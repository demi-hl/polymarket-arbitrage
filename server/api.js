const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const PolymarketScanner = require('../scanner');
const PolymarketArbitrageBot = require('../bot');
const { StrategyRegistry } = require('../strategies');
const RiskManager = require('../risk-manager');
const WhaleTracker = require('../integrations/whale-tracker');
const DataStore = require('../learning/data-store');
const EdgeModel = require('../learning/edge-model');
const { MarketMaker } = require('../strategies/market-maker');
const GPUClient = require('../lib/gpu-client');
function createApiServer(wsServer) {
  const app = express();
  
  app.use(cors());
  app.use(express.json());
  
  // Health check
  app.get('/health', (req, res) => {
    res.json({ 
      status: 'ok', 
      timestamp: Date.now(), 
      version: '2.0.0'
    });
  });
  
  // API Routes
  const api = express.Router();
  
  const _gpuClient = new GPUClient();

  // Status (running state, version)
  api.get('/status', async (req, res) => {
    const gpuStatus = await _gpuClient.getStatus().catch(() => ({ available: false }));
    res.json({
      status: 'running',
      version: '3.0.0',
      timestamp: new Date().toISOString(),
      gpu: gpuStatus,
      endpoints: ['/api/portfolio', '/api/opportunities', '/api/strategies', '/api/report', '/api/risk', '/api/gpu']
    });
  });

  // GPU worker status and controls
  api.get('/gpu', async (req, res) => {
    try {
      const status = await _gpuClient.getStatus();
      res.json({ success: true, data: status });
    } catch (err) {
      res.json({ success: true, data: { available: false, error: err.message } });
    }
  });

  api.post('/gpu/backtest', async (req, res) => {
    try {
      const { trades, strategy } = req.body;
      const result = await _gpuClient.auditStrategies(trades);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/gpu/monte-carlo', async (req, res) => {
    try {
      const { positions, bankroll, n_paths, horizon_days } = req.body;
      const result = await _gpuClient.monteCarloSimulation(positions, bankroll, n_paths, horizon_days);
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  const accountId = process.env.ACCOUNT_ID || 'default';
  const botDataDir = accountId !== 'default'
    ? path.join(__dirname, '..', 'data', `account-${accountId}`)
    : undefined;
  const OPPORTUNITY_TIMEOUT_MS = Math.max(4000, parseInt(process.env.OPPORTUNITY_TIMEOUT_MS || '12000', 10));
  const OPPORTUNITY_CACHE_TTL_MS = Math.max(1000, parseInt(process.env.OPPORTUNITY_CACHE_TTL_MS || '15000', 10));
  let _opportunityCache = {
    ts: 0,
    threshold: null,
    data: { opportunities: [], marketsScanned: 0, stale: false },
  };

  // Get portfolio
  api.get('/portfolio', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      await bot.loadPortfolio();
      const portfolio = bot.getPortfolio();
      const report = await bot.generateReport();
      const rust = await fetchRustSnapshot();
      const merged = computeMergedStats(portfolio, report, rust);
      res.json({
        success: true,
        data: {
          ...portfolio,
          trades: merged.mergedTrades,
          totalTrades: merged.mergedTrades.length,
          pnl: merged.mergedPnl,
          totalValue: merged.totalValue,
          totalReturn: merged.totalReturn,
          rust,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get trades
  api.get('/trades', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      await bot.loadPortfolio();
      const report = await bot.generateReport();
      const rust = await fetchRustSnapshot();
      const merged = computeMergedStats(bot.getPortfolio(), report, rust);
      res.json({ success: true, data: merged.mergedTrades.slice(0, 200) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get opportunities
  api.get('/opportunities', async (req, res) => {
    try {
      const threshold = parseFloat(req.query.threshold) / 100 || 0.05;
      const now = Date.now();
      if (
        _opportunityCache.threshold === threshold &&
        now - _opportunityCache.ts < OPPORTUNITY_CACHE_TTL_MS
      ) {
        return res.json({ success: true, data: _opportunityCache.data });
      }

      const scanner = new PolymarketScanner({
        edgeThreshold: threshold,
        timeout: Math.min(OPPORTUNITY_TIMEOUT_MS, 10000),
      });

      const timeoutError = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Opportunities scan timed out after ${OPPORTUNITY_TIMEOUT_MS}ms`)), OPPORTUNITY_TIMEOUT_MS)
      );

      const result = await Promise.race([
        scanner.scan({ threshold }),
        timeoutError,
      ]);

      _opportunityCache = {
        ts: now,
        threshold,
        data: { ...(result || {}), stale: false },
      };

      res.json({ success: true, data: _opportunityCache.data });
    } catch (err) {
      if (_opportunityCache.data?.opportunities) {
        return res.json({
          success: true,
          data: {
            ..._opportunityCache.data,
            stale: true,
            warning: err.message,
          },
        });
      }
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get strategies
  api.get('/strategies', async (req, res) => {
    try {
      const { ALL_STRATEGIES } = require('../strategies');
      res.json({ 
        success: true, 
        data: ALL_STRATEGIES.map(s => ({ 
          name: s.name, 
          type: s.type, 
          riskLevel: s.riskLevel 
        })) 
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get performance report
  api.get('/report', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      await bot.loadPortfolio();
      const portfolio = bot.getPortfolio();
      const report = await bot.generateReport();
      const rust = await fetchRustSnapshot();
      const merged = computeMergedStats(portfolio, report, rust);
      const hasClosed = merged.closedTrades.length > 0;
      const winRate = hasClosed ? (merged.wins.length / merged.closedTrades.length) * 100 : 0;

      res.json({
        success: true,
        data: {
          ...report,
          performance: {
            ...(report.performance || {}),
            totalTrades: merged.mergedTrades.length,
            closedTrades: merged.closedTrades.length,
            winningTrades: merged.wins.length,
            losingTrades: merged.losses.length,
            winRate: `${winRate.toFixed(1)}%`,
          },
          portfolio: {
            ...(report.portfolio || {}),
            totalValue: merged.totalValue,
            totalReturn: merged.totalReturn.toFixed(2),
          },
          pnl: merged.mergedPnl,
          recentTrades: merged.mergedTrades.slice(0, 80),
          rust,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get risk report
  api.get('/risk', async (req, res) => {
    try {
      const riskManager = new RiskManager();
      const report = riskManager.getRiskReport();
      res.json({ success: true, data: report });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Execute trade
  api.post('/execute', async (req, res) => {
    try {
      const { marketId, size } = req.body;
      const scanner = new PolymarketScanner();
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      
      const markets = await scanner.fetchMarkets();
      const market = markets.find(m => m.id === marketId);
      
      if (!market) {
        return res.status(404).json({ success: false, error: 'Market not found' });
      }
      
      const opportunity = scanner.calculateArbitrage(market);
      if (!opportunity) {
        return res.status(400).json({ success: false, error: 'No arbitrage opportunity' });
      }
      
      const trade = await bot.execute(opportunity, { size: parseFloat(size) || opportunity.maxPosition });
      
      if (wsServer) {
        wsServer.broadcast('trades', trade);
      }
      
      res.json({ success: true, data: trade });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Reset portfolio
  api.post('/reset', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      await bot.reset();
      res.json({ success: true, message: 'Portfolio reset' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Trigger manual scan
  api.post('/scan', async (req, res) => {
    try {
      const threshold = parseFloat(req.body.threshold) / 100 || 0.05;
      const scanner = new PolymarketScanner({ edgeThreshold: threshold });
      const result = await scanner.scan({ threshold });
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Learning System Endpoints ──

  let _dataStoreInstance = null;
  let _edgeModelInstance = null;

  async function getDataStore() {
    if (!_dataStoreInstance) {
      _dataStoreInstance = new DataStore();
      await _dataStoreInstance.init();
    }
    return _dataStoreInstance;
  }

  async function getEdgeModel() {
    if (!_edgeModelInstance) {
      const store = await getDataStore();
      _edgeModelInstance = new EdgeModel(store, null);
      await _edgeModelInstance.init();
    }
    return _edgeModelInstance;
  }

  api.get('/learning/status', async (req, res) => {
    try {
      const store = await getDataStore();
      const model = await getEdgeModel();
      res.json({
        success: true,
        data: {
          dataStore: await store.getStats(),
          model: model.getReport(),
          strategyStats: store.getStrategyStats(),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/learning/estimate', async (req, res) => {
    try {
      const model = await getEdgeModel();
      const opp = {
        marketId: req.query.marketId || 'test',
        edgePercent: parseFloat(req.query.edge) || 0.03,
        executableEdge: parseFloat(req.query.edge) || 0.03,
        liquidity: parseFloat(req.query.liquidity) || 10000,
        volume: parseFloat(req.query.volume) || 50000,
        yesPrice: parseFloat(req.query.yesPrice) || 0.5,
        noPrice: parseFloat(req.query.noPrice) || 0.5,
        strategy: req.query.strategy || 'basic-arbitrage',
        direction: 'BUY_BOTH',
        pricingSource: 'gamma',
        endDate: null,
        spread: 0.02,
      };
      const estimate = model.estimate(opp);
      res.json({ success: true, data: estimate });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Market Maker Endpoints ──

  let _marketMaker = null;
  function getMarketMaker() {
    if (!_marketMaker) _marketMaker = new MarketMaker({ mode: 'paper' });
    return _marketMaker;
  }

  api.get('/market-maker', async (req, res) => {
    try {
      const mm = getMarketMaker();
      res.json({ success: true, data: mm.getReport() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/market-maker/start', async (req, res) => {
    try {
      const mm = getMarketMaker();
      mm.start();
      res.json({ success: true, message: 'Market maker started', data: mm.getReport() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/market-maker/stop', async (req, res) => {
    try {
      const mm = getMarketMaker();
      mm.stop();
      res.json({ success: true, message: 'Market maker stopped' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/market-maker/refresh', async (req, res) => {
    try {
      const mm = getMarketMaker();
      const quotes = await mm.refreshAllQuotes();
      res.json({ success: true, data: { quotes, report: mm.getReport() } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Whale Tracker Endpoints ──

  let _whaleTrackerInstance = null;
  function getWhaleTracker() {
    if (!_whaleTrackerInstance) {
      _whaleTrackerInstance = new WhaleTracker();
      _whaleTrackerInstance.init().catch(() => {});
    }
    return _whaleTrackerInstance;
  }

  api.get('/whales', async (req, res) => {
    try {
      const tracker = getWhaleTracker();
      const report = tracker.getReport();
      res.json({ success: true, data: report });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/whales/signals', async (req, res) => {
    try {
      const tracker = getWhaleTracker();
      const signals = tracker.getAllSignals().slice(0, 20);
      res.json({ success: true, data: signals });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/whales/refresh', async (req, res) => {
    try {
      const tracker = getWhaleTracker();
      await tracker.discoverWhales();
      await tracker.refreshPositions();
      res.json({ success: true, data: tracker.getReport() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Oracle Research Daemon Endpoints ──
  api.get('/oracle/status', async (req, res) => {
    try {
      const logPath = path.join(__dirname, '..', 'data', 'oracle-log.json');
      const thesesPath = path.join(__dirname, '..', 'data', 'news-theses.json');
      const whaleSignalsPath = path.join(__dirname, '..', 'data', 'whale-signals.json');
      const xSignalsPath = path.join(__dirname, '..', 'data', 'x-sentiment-signals.json');

      let log = { stats: {}, runs: [] };
      let theses = { theses: [] };
      let whaleSignals = [];
      let xSignals = [];

      try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
      try {
        const raw = JSON.parse(fs.readFileSync(thesesPath, 'utf8'));
        theses = Array.isArray(raw) ? { theses: raw } : raw;
      } catch {}
      try { whaleSignals = JSON.parse(fs.readFileSync(whaleSignalsPath, 'utf8')); } catch {}
      try { xSignals = JSON.parse(fs.readFileSync(xSignalsPath, 'utf8')); } catch {}

      const cutoff = Date.now() - 3600000;
      res.json({
        success: true,
        data: {
          stats: log.stats || {},
          lastRun: log.runs.length > 0 ? log.runs[log.runs.length - 1] : null,
          activeTheses: (theses.theses || []).length,
          theses: (theses.theses || []).slice(-20),
          recentWhaleSignals: (Array.isArray(whaleSignals) ? whaleSignals : []).filter(s => s.timestamp > cutoff).length,
          recentXSignals: (Array.isArray(xSignals) ? xSignals : []).filter(s => s.timestamp > cutoff).length,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/oracle/theses', async (req, res) => {
    try {
      const thesesPath = path.join(__dirname, '..', 'data', 'news-theses.json');
      const raw = JSON.parse(fs.readFileSync(thesesPath, 'utf8'));
      const theses = Array.isArray(raw) ? raw : (raw.theses || []);
      res.json({ success: true, data: theses });
    } catch (err) {
      res.json({ success: true, data: [] });
    }
  });

  api.get('/oracle/signals', async (req, res) => {
    try {
      const whaleSignalsPath = path.join(__dirname, '..', 'data', 'whale-signals.json');
      const xSignalsPath = path.join(__dirname, '..', 'data', 'x-sentiment-signals.json');
      let whales = [], xSentiment = [];
      try { whales = JSON.parse(fs.readFileSync(whaleSignalsPath, 'utf8')); } catch {}
      try { xSentiment = JSON.parse(fs.readFileSync(xSignalsPath, 'utf8')); } catch {}

      const maxAge = parseInt(req.query.maxAge) || 3600000;
      const cutoff = Date.now() - maxAge;

      res.json({
        success: true,
        data: {
          whales: (Array.isArray(whales) ? whales : []).filter(s => s.timestamp > cutoff),
          xSentiment: (Array.isArray(xSentiment) ? xSentiment : []).filter(s => s.timestamp > cutoff),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Multi-Account A/B Testing Endpoints ──
  const SINGLE_ACCOUNT_ONLY = process.env.SINGLE_ACCOUNT_ONLY !== 'false';
  const SINGLE_ACCOUNT_ID = process.env.SINGLE_ACCOUNT_ID || 'paper';

  function getAccountDataDir(accountId) {
    return path.join(__dirname, '..', 'data', `account-${accountId}`);
  }

  function loadAccountBot(accountId) {
    if (SINGLE_ACCOUNT_ONLY && accountId !== SINGLE_ACCOUNT_ID) {
      throw new Error(`Account '${accountId}' is disabled in single-account mode`);
    }
    const dataDir = getAccountDataDir(accountId);
    return new PolymarketArbitrageBot({ mode: 'paper', dataDir });
  }

  function discoverAccounts() {
    if (SINGLE_ACCOUNT_ONLY) return [SINGLE_ACCOUNT_ID];
    const dataRoot = path.join(__dirname, '..', 'data');
    try {
      return fs.readdirSync(dataRoot)
        .filter(d => d.startsWith('account-') && fs.statSync(path.join(dataRoot, d)).isDirectory())
        .map(d => d.replace('account-', ''));
    } catch {
      return [];
    }
  }

  const RUST_ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://localhost:8900';
  const STARTING_CAPITAL = toNumber(process.env.STARTING_CAPITAL, 10000);
  const RUST_CACHE_TTL_MS = 2000;
  let _rustSnapshotCache = { ts: 0, data: null };

  function toNumber(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function isSyntheticRustPosition(position) {
    return Boolean(position?.rustEngine) || String(position?.strategy || '') === 'crypto-latency-arb';
  }

  function getOpenPositionCost(positions = {}, { includeSyntheticRust = true } = {}) {
    return Object.values(positions)
      .filter(p => p?.status === 'open')
      .filter(p => includeSyntheticRust || !isSyntheticRustPosition(p))
      .reduce((sum, p) => sum + toNumber(p.entryCost, 0), 0);
  }

  function estimateNodeUnrealizedFromPositions(positions = {}) {
    return Object.values(positions)
      .filter(p => p?.status === 'open')
      .filter(p => !isSyntheticRustPosition(p))
      .reduce((sum, p) => {
        const yesShares = toNumber(p.yesShares, 0);
        const noShares = toNumber(p.noShares, 0);
        const currentYes = toNumber(p.currentYesPrice, toNumber(p.entryYesPrice, 0.5));
        const currentNo = toNumber(p.currentNoPrice, toNumber(p.entryNoPrice, 0.5));
        const entryCost = toNumber(p.entryCost, 0);
        const currentValue = yesShares * currentYes + noShares * currentNo;
        return sum + (currentValue - entryCost);
      }, 0);
  }

  function mapRustTrades(trades = []) {
    return trades.map(t => {
      const side = String(t.side || '').toLowerCase();
      return {
        id: `rust-${t.id}`,
        rustTradeId: t.id,
        timestamp: t.submitted_at || new Date().toISOString(),
        closedAt: t.filled_at || t.submitted_at || new Date().toISOString(),
        strategy: 'crypto-latency-arb',
        question: `Rust Engine: ${String(t.asset || 'crypto').toUpperCase()} latency arb`,
        direction: side === 'buy' ? 'BUY_YES' : 'BUY_NO',
        status: t.status === 'filled' ? 'closed' : 'open',
        fillMethod: 'rust-engine',
        pricingSource: 'rust-engine',
        totalCost: toNumber(t.cost, 0),
        edgePercent: Math.abs(toNumber(t.divergence_at_entry, 0)),
        expectedProfit: Math.abs(toNumber(t.divergence_at_entry, 0)) * toNumber(t.cost, 0),
        realizedPnl: t.pnl != null ? toNumber(t.pnl, 0) : null,
        executedBy: 'rust-engine',
      };
    });
  }

  function mergeTrades(nodeTrades = [], rustTrades = []) {
    const key = t => `${t.id || ''}:${t.timestamp || ''}:${toNumber(t.totalCost, 0).toFixed(6)}`;
    const out = [];
    const seen = new Set();
    for (const t of [...nodeTrades, ...rustTrades]) {
      const k = key(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    out.sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    return out;
  }

  function isRustTrade(trade = {}) {
    return trade.fillMethod === 'rust-engine'
      || trade.executedBy === 'rust-engine'
      || trade.strategy === 'crypto-latency-arb'
      || Boolean(trade.rustTradeId);
  }

  function selectFeedTrades(trades = [], limit = 80) {
    const sorted = [...trades].sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime());
    const recent = sorted.slice(0, limit);
    const nodeInRecent = recent.filter(t => !isRustTrade(t));
    if (nodeInRecent.length > 0) return recent;

    // If Rust saturates the latest window, reserve a small slice for latest Node trades.
    const latestNode = sorted.filter(t => !isRustTrade(t)).slice(0, Math.min(12, limit));
    if (latestNode.length === 0) return recent;
    const rustPortion = recent.filter(isRustTrade).slice(0, Math.max(0, limit - latestNode.length));
    const mixed = [...rustPortion, ...latestNode]
      .sort((a, b) => new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime())
      .slice(0, limit);
    return mixed;
  }

  function computeMergedStats(portfolio, report, rust) {
    const rustPnl = rust?.pnl || { realized: 0, unrealized: 0, total: 0 };

    const allNodeTrades = portfolio?.trades || [];
    const nodeTrades = allNodeTrades.filter(t => t?.fillMethod !== 'rust-engine' && t?.strategy !== 'crypto-latency-arb');
    const rustTrades = rust?.recentTrades || [];
    const mergedTrades = mergeTrades(nodeTrades, rustTrades);
    const closedTrades = mergedTrades.filter(t => t.realizedPnl != null);
    const openTrades = mergedTrades.filter(t => t.realizedPnl == null);
    const wins = closedTrades.filter(t => toNumber(t.realizedPnl, 0) > 0);
    const losses = closedTrades.filter(t => toNumber(t.realizedPnl, 0) < 0);

    const syntheticRustOpenCost = getOpenPositionCost(portfolio?.positions || {}, { includeSyntheticRust: true })
      - getOpenPositionCost(portfolio?.positions || {}, { includeSyntheticRust: false });
    const normalizedCash = toNumber(portfolio?.cash, 0) + syntheticRustOpenCost;
    const openCost = getOpenPositionCost(portfolio?.positions || {}, { includeSyntheticRust: false });
    const normalizedNodeRealized = nodeTrades
      .filter(t => t.realizedPnl != null)
      .reduce((sum, t) => sum + toNumber(t.realizedPnl, 0), 0);
    const normalizedNodeUnrealized = estimateNodeUnrealizedFromPositions(portfolio?.positions || {});
    const baseTotalValue = normalizedCash + openCost + normalizedNodeUnrealized;
    const combinedTotalValue = baseTotalValue + toNumber(rustPnl.total, 0);
    const allTimePnl = combinedTotalValue - STARTING_CAPITAL;
    const mergedRealized = normalizedNodeRealized + toNumber(rustPnl.realized, 0);
    const mergedUnrealized = allTimePnl - mergedRealized;
    const mergedPnl = {
      realized: mergedRealized,
      unrealized: mergedUnrealized,
      total: allTimePnl,
      components: {
        node: {
          realized: normalizedNodeRealized,
          unrealized: normalizedNodeUnrealized,
          total: normalizedNodeRealized + normalizedNodeUnrealized,
        },
        rust: {
          realized: toNumber(rustPnl.realized, 0),
          unrealized: toNumber(rustPnl.unrealized, 0),
          total: toNumber(rustPnl.total, 0),
        },
      },
      baseline: {
        startingCapital: STARTING_CAPITAL,
        allTimePnl,
      },
    };
    const totalReturn = STARTING_CAPITAL > 0
      ? ((combinedTotalValue - STARTING_CAPITAL) / STARTING_CAPITAL) * 100
      : 0;

    return {
      mergedPnl,
      mergedTrades,
      closedTrades,
      openTrades,
      wins,
      losses,
      totalValue: combinedTotalValue,
      totalReturn,
    };
  }

  async function fetchRustSnapshot() {
    if (Date.now() - _rustSnapshotCache.ts < RUST_CACHE_TTL_MS && _rustSnapshotCache.data) {
      return _rustSnapshotCache.data;
    }
    try {
      const [statusRes, pnlRes, tradesRes] = await Promise.all([
        axios.get(`${RUST_ENGINE_URL}/status`, { timeout: 1200 }),
        axios.get(`${RUST_ENGINE_URL}/pnl`, { timeout: 1200 }),
        axios.get(`${RUST_ENGINE_URL}/trades`, { timeout: 1200 }),
      ]);
      const status = statusRes.data || {};
      const pnl = pnlRes.data || {};
      const recentTrades = mapRustTrades(Array.isArray(tradesRes.data) ? tradesRes.data.slice(-200).reverse() : []);
      const data = {
        available: status.running === true,
        status,
        pnl: {
          realized: toNumber(pnl.realized, 0),
          unrealized: toNumber(pnl.unrealized, 0),
          total: toNumber(pnl.total, 0),
        },
        recentTrades,
        tradeCount: toNumber(status.trades_today, 0),
      };
      _rustSnapshotCache = { ts: Date.now(), data };
      return data;
    } catch {
      const data = {
        available: false,
        status: null,
        pnl: { realized: 0, unrealized: 0, total: 0 },
        recentTrades: [],
        tradeCount: 0,
      };
      _rustSnapshotCache = { ts: Date.now(), data };
      return data;
    }
  }

  api.get('/accounts', async (req, res) => {
    try {
      const ids = discoverAccounts();
      const accounts = [];
      const rust = await fetchRustSnapshot();
      for (const id of ids) {
        const bot = loadAccountBot(id);
        await new Promise(r => setTimeout(r, 100));
        const portfolio = bot.getPortfolio();
        const report = await bot.generateReport();
        const includeRust = id === SINGLE_ACCOUNT_ID || id === 'paper';
        const merged = computeMergedStats(portfolio, report, includeRust ? rust : null);
        const hasClosed = merged.closedTrades.length > 0;
        const winRate = hasClosed ? (merged.wins.length / merged.closedTrades.length * 100) : 0;
        accounts.push({
          id,
          portfolio: {
            ...portfolio,
            trades: merged.mergedTrades,
            totalTrades: merged.mergedTrades.length,
            totalValue: merged.totalValue,
            pnl: merged.mergedPnl,
          },
          performance: {
            ...(report.performance || {}),
            totalTrades: merged.mergedTrades.length,
            closedTrades: merged.closedTrades.length,
            winningTrades: merged.wins.length,
            losingTrades: merged.losses.length,
            winRate: `${winRate.toFixed(1)}%`,
            totalReturn: merged.totalReturn.toFixed(2),
          },
          pnl: merged.mergedPnl,
          recentTrades: selectFeedTrades(merged.mergedTrades, 80),
          totalValue: merged.totalValue,
          rust: includeRust ? rust : { available: false },
        });
      }
      res.json({ success: true, data: accounts });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/accounts/compare', async (req, res) => {
    try {
      const ids = discoverAccounts();
      if (ids.length < 2) {
        return res.json({ success: true, data: { accounts: [], comparison: null } });
      }

      const accounts = {};
      const rust = await fetchRustSnapshot();
      for (const id of ids) {
        const bot = loadAccountBot(id);
        await new Promise(r => setTimeout(r, 100));
        const portfolio = bot.getPortfolio();
        const report = await bot.generateReport();
        const includeRust = id === SINGLE_ACCOUNT_ID || id === 'paper';
        const merged = computeMergedStats(portfolio, report, includeRust ? rust : null);
        const trades = merged.mergedTrades;
        const edges = trades.map(t => t.edgePercent || 0).filter(e => e > 0);
        const avgEdge = edges.length > 0 ? edges.reduce((a, b) => a + b, 0) / edges.length : 0;
        const totalValue = merged.totalValue;

        const closedTrades = trades.filter(t => t.realizedPnl != null);
        const openTrades = trades.filter(t => t.realizedPnl == null);
        const wins = closedTrades.filter(t => t.realizedPnl > 0);
        const losses = closedTrades.filter(t => t.realizedPnl < 0);
        const hasClosedData = closedTrades.length > 0;
        const winRate = hasClosedData
          ? parseFloat((wins.length / closedTrades.length * 100).toFixed(1))
          : 0;

        accounts[id] = {
          id,
          cash: portfolio.cash,
          totalValue,
          totalReturn: merged.totalReturn,
          openPositions: portfolio.openPositions,
          closedPositions: portfolio.closedPositions,
          totalTrades: trades.length,
          closedTradeCount: closedTrades.length,
          openTradeCount: openTrades.length,
          winCount: wins.length,
          lossCount: losses.length,
          winRate,
          winRateIsEstimated: !hasClosedData,
          avgEdge: (avgEdge * 100).toFixed(2),
          profitFactor: parseFloat(report.performance.profitFactor) || 0,
          pnl: merged.mergedPnl,
          recentTrades: selectFeedTrades(trades, 80),
          equityCurve: buildEquityCurve(trades, merged.mergedPnl, portfolio),
          rust: includeRust ? rust : { available: false },
        };
      }

      const idList = Object.keys(accounts);
      const a = accounts[idList[0]];
      const b = accounts[idList[1]];
      const winner =
        a.totalValue > b.totalValue ? idList[0] :
        b.totalValue > a.totalValue ? idList[1] : 'tie';

      res.json({
        success: true,
        data: {
          accounts,
          comparison: {
            winner,
            valueDiff: Math.abs(a.totalValue - b.totalValue).toFixed(2),
            combinedValue: (a.totalValue + b.totalValue).toFixed(2),
          },
          timestamp: new Date().toISOString(),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/accounts/:id/portfolio', async (req, res) => {
    try {
      const bot = loadAccountBot(req.params.id);
      await new Promise(r => setTimeout(r, 100));
      const portfolio = bot.getPortfolio();
      const report = await bot.generateReport();
      const includeRust = req.params.id === SINGLE_ACCOUNT_ID || req.params.id === 'paper';
      const rust = includeRust ? await fetchRustSnapshot() : null;
      const merged = computeMergedStats(portfolio, report, rust);
      res.json({
        success: true,
        data: {
          ...portfolio,
          trades: merged.mergedTrades,
          totalTrades: merged.mergedTrades.length,
          pnl: merged.mergedPnl,
          totalValue: merged.totalValue,
          totalReturn: merged.totalReturn,
          rust: includeRust ? rust : { available: false },
        },
      });
    } catch (err) {
      const status = /disabled in single-account mode/i.test(err.message) ? 404 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  api.get('/accounts/:id/trades', async (req, res) => {
    try {
      const bot = loadAccountBot(req.params.id);
      await new Promise(r => setTimeout(r, 100));
      const report = await bot.generateReport();
      const includeRust = req.params.id === SINGLE_ACCOUNT_ID || req.params.id === 'paper';
      const rust = includeRust ? await fetchRustSnapshot() : null;
      const merged = computeMergedStats(bot.getPortfolio(), report, rust);
      res.json({ success: true, data: merged.mergedTrades.slice(0, 200) });
    } catch (err) {
      const status = /disabled in single-account mode/i.test(err.message) ? 404 : 500;
      res.status(status).json({ success: false, error: err.message });
    }
  });

  function buildEquityCurve(trades, pnl, portfolio) {
    const startingCapital = 10000;
    if (!trades || trades.length === 0) {
      return [{ time: Math.floor(Date.now() / 1000), value: startingCapital }];
    }

    const closedEvents = trades
      .filter(t => t.realizedPnl != null)
      .map(t => {
        const openTs = t.timestamp ? new Date(t.timestamp).getTime() : Date.now();
        const closeTs = t.closedAt ? new Date(t.closedAt).getTime() : openTs + 60000;
        return { ts: closeTs, realizedPnl: toNumber(t.realizedPnl, 0) };
      })
      .sort((a, b) => a.ts - b.ts);

    const anchorTs = closedEvents.length > 0
      ? Math.floor(closedEvents[0].ts / 1000)
      : Math.floor((trades[0]?.timestamp ? new Date(trades[0].timestamp).getTime() : Date.now()) / 1000);
    const firstTs = anchorTs - 3600;
    const curve = [{ time: firstTs, value: startingCapital }];
    let lastTime = firstTs;
    let equity = startingCapital;

    for (const ev of closedEvents) {
      equity += ev.realizedPnl;
      let ts = Math.floor(ev.ts / 1000);
      if (ts <= lastTime) ts = lastTime + 1;
      lastTime = ts;
      curve.push({ time: ts, value: parseFloat(equity.toFixed(2)) });
    }

    const currentValue = toNumber(portfolio?.totalValue, startingCapital + toNumber(pnl?.total, 0));
    const nowTs = Math.floor(Date.now() / 1000);
    if (nowTs > lastTime) {
      curve.push({ time: nowTs, value: parseFloat(currentValue.toFixed(2)) });
    }

    return curve;
  }

  app.use('/api', api);

  // When mounted (e.g. dashboard), pass through unmatched routes so SPA catch-all can serve index.html
  app.use((req, res, next) => next());

  return app;
}

module.exports = createApiServer;
