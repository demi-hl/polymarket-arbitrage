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
const RustTradeTrainer = require('../learning/rust-trade-trainer');
const ClobClient = require('../clob-client');
const OrderflowWatcher = require('../lib/orderflow-watcher');
const OrderbookImbalanceAnalyzer = require('../lib/orderbook-imbalance');
const { setOrderflowWatcher } = require('../strategies');
const auth = require('./auth');

// Shared OrderflowWatcher singleton
let _orderflowWatcher = null;
function getOrderflowWatcher(wsServer) {
  if (!_orderflowWatcher) {
    const clob = new ClobClient();
    const imbalance = new OrderbookImbalanceAnalyzer(clob);
    _orderflowWatcher = new OrderflowWatcher(clob, imbalance);
    _orderflowWatcher.start();
    setOrderflowWatcher(_orderflowWatcher);

    // Connect ClobClient to start receiving data
    clob.connect();

    // Broadcast whale events to dashboard WebSocket
    if (wsServer) {
      _orderflowWatcher.on('whale-trade', (data) => {
        wsServer.broadcast && wsServer.broadcast('orderflow', { event: 'whale-trade', ...data });
      });
      _orderflowWatcher.on('mega-whale-trade', (data) => {
        wsServer.broadcast && wsServer.broadcast('orderflow', { event: 'mega-whale', ...data });
      });
      _orderflowWatcher.on('whale-consensus', (data) => {
        wsServer.broadcast && wsServer.broadcast('orderflow', { event: 'consensus', ...data });
      });
    }
  }
  return _orderflowWatcher;
}

const DEFAULT_SETTINGS = {
  positionSizing: { mode: 'fixed', fixedAmount: 25, percentageOfPortfolio: 2, maxPositionPerMarket: 100 },
  risk: { maxConcurrentPositions: 10, stopLossPercent: 15, takeProfitPercent: 25, maxDailyLoss: 500 },
  trading: { mode: 'paper', autoExecute: true, minEdgePercent: 3, minLiquidity: 1000 },
};

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
  
  // ── Auth Module Init ──
  auth.init();

  // ── Auth Routes (public, no middleware) ──
  const authRouter = express.Router();

  authRouter.post('/nonce', (req, res) => {
    try {
      const { address } = req.body;
      if (!address) return res.status(400).json({ error: 'Address required' });
      const { nonce, message } = auth.generateNonce(address);
      res.json({ success: true, nonce, message });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  authRouter.post('/verify', async (req, res) => {
    try {
      const { address, signature, message } = req.body;
      if (!address || !signature || !message) {
        return res.status(400).json({ error: 'Address, signature, and message required' });
      }

      // 1. Verify nonce hasn't expired
      const nonce = auth.consumeNonce(address);
      if (!nonce) {
        return res.status(401).json({ error: 'Nonce expired or not found. Request a new nonce.' });
      }

      // 2. Verify signature matches address
      if (!auth.verifySignature(message, signature, address)) {
        return res.status(401).json({ error: 'Signature verification failed' });
      }

      // 3. Check NFT ownership on HyperEVM
      const nftBalance = await auth.checkNFTBalance(address);
      if (nftBalance === 0) {
        return res.status(403).json({ error: 'No Locals Only NFT found. Hold the NFT to access the bot.' });
      }

      // 4. Issue JWT
      const token = auth.createJWT({ address, nftBalance });

      // 5. Ensure user data directory exists with defaults
      const userDir = auth.getUserDataDir(address);
      const portfolioPath = auth.getUserFilePath(address, 'portfolio.json');
      if (!fs.existsSync(portfolioPath)) {
        auth.writeUserFile(address, 'portfolio.json', {
          cash: 10000, positions: [], trades: [], pnl: { realized: 0, unrealized: 0, total: 0 },
        });
      }
      const settingsPath = auth.getUserFilePath(address, 'settings.json');
      if (!fs.existsSync(settingsPath)) {
        auth.writeUserFile(address, 'settings.json', DEFAULT_SETTINGS);
      }

      res.json({
        success: true,
        token,
        user: { address, nftBalance },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  authRouter.post('/refresh', (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader) return res.status(401).json({ error: 'Token required' });
      const oldToken = authHeader.replace('Bearer ', '');
      const payload = auth.verifyJWT(oldToken);
      if (!payload) return res.status(401).json({ error: 'Invalid token' });

      const newToken = auth.createJWT({ address: payload.address, nftBalance: payload.nftBalance });
      res.json({ success: true, token: newToken });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.use('/api/auth', authRouter);

  // API Routes
  const api = express.Router();

  // ── Auth Middleware — protect all /api/* routes ──
  // Public routes that skip auth (shared market data)
  const PUBLIC_API_ROUTES = [
    '/status', '/opportunities', '/strategies', '/gas', '/health',
    '/oracle', '/whales', '/orderflow', '/realism',  // shared market data
    '/gpu', '/report', '/accounts',                    // shared infrastructure
  ];
  api.use((req, res, next) => {
    // Skip auth for public read-only market data endpoints
    if (PUBLIC_API_ROUTES.some(r => req.path === r || req.path.startsWith(r + '/'))) {
      return next();
    }
    // Apply auth middleware to everything else
    auth.authMiddleware(req, res, next);
  });
  
  const _gpuClient = new GPUClient();

  // ── Rust Trade -> GPU Training Loop ──
  // Starts after EdgeModel is lazy-initialized on first access
  let _rustTradeTrainer = null;

  async function ensureRustTradeTrainer() {
    if (_rustTradeTrainer) return _rustTradeTrainer;
    try {
      const edgeModel = await getEdgeModel();
      _rustTradeTrainer = new RustTradeTrainer({
        gpuClient: _gpuClient,
        edgeModel,
      });
      _rustTradeTrainer.start();
    } catch (err) {
      console.error('[api] Failed to start RustTradeTrainer:', err.message);
    }
    return _rustTradeTrainer;
  }

  // Kick off the trainer after a brief startup delay
  setTimeout(() => ensureRustTradeTrainer().catch(() => {}), 8_000);

  // Status (running state, version)
  api.get('/status', async (req, res) => {
    const gpuStatus = await _gpuClient.getStatus().catch(() => ({ available: false }));
    const trainerStats = _rustTradeTrainer ? _rustTradeTrainer.getStats() : { running: false };
    res.json({
      status: 'running',
      version: '3.0.0',
      timestamp: new Date().toISOString(),
      gpu: gpuStatus,
      rustTradeTrainer: trainerStats,
      endpoints: ['/api/portfolio', '/api/opportunities', '/api/strategies', '/api/report', '/api/risk', '/api/gpu', '/api/gpu/train-status']
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

  // Rust -> GPU training pipeline status
  api.get('/gpu/train-status', async (req, res) => {
    try {
      const trainer = _rustTradeTrainer;
      if (!trainer) {
        return res.json({
          success: true,
          data: { running: false, message: 'RustTradeTrainer not yet initialized' },
        });
      }
      const stats = trainer.getStats();
      const gpuAvailable = await _gpuClient.isAvailable();
      res.json({
        success: true,
        data: {
          ...stats,
          gpuAvailable,
          gpuUrl: _gpuClient.baseUrl,
          rustEngineUrl: process.env.LATENCY_ENGINE_URL || 'http://127.0.0.1:8900',
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Force an immediate sync of Rust trades to GPU
  api.post('/gpu/train-sync', async (req, res) => {
    try {
      const trainer = await ensureRustTradeTrainer();
      if (!trainer) {
        return res.status(503).json({ success: false, error: 'RustTradeTrainer failed to initialize' });
      }
      await trainer._syncOnce();
      res.json({ success: true, data: trainer.getStats() });
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
          totalTrades: rust?.tradeCount || merged.mergedTrades.length,
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
      const limit = parseInt(req.query.limit) || 500;
      res.json({ success: true, data: merged.mergedTrades.slice(0, limit) });
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
      const realClosed = merged.realClosedCount || merged.closedTrades.length;
      const hasClosed = realClosed > 0;
      const winRate = hasClosed ? (merged.wins.length / realClosed) * 100 : 0;

      res.json({
        success: true,
        data: {
          ...report,
          performance: {
            ...(report.performance || {}),
            totalTrades: rust?.tradeCount || merged.mergedTrades.length,
            closedTrades: realClosed,
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
      await bot.loadPortfolio();

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
      // Store reset timestamp so we can filter out pre-reset Rust trades
      _lastResetTimestamp = new Date().toISOString();
      // Clear Rust snapshot cache so stale data doesn't persist
      _rustSnapshotCache = { ts: 0, data: null };
      // Try to reset Rust engine too
      try { await axios.post(`${RUST_ENGINE_URL}/reset`, {}, { timeout: 2000 }); } catch {}
      res.json({ success: true, message: 'Portfolio reset' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // ── Polygon Gas / MEV Monitor ──
  let _gasCache = { ts: 0, data: null };
  const GAS_CACHE_TTL = 15000; // 15s

  api.get('/gas', async (req, res) => {
    try {
      if (Date.now() - _gasCache.ts < GAS_CACHE_TTL && _gasCache.data) {
        return res.json({ success: true, data: _gasCache.data });
      }

      let gasData;
      try {
        // Polygon Gas Station v2
        const gasRes = await axios.get('https://gasstation.polygon.technology/v2', { timeout: 5000 });
        const g = gasRes.data;
        gasData = {
          network: 'polygon',
          blockNumber: g.blockNumber || null,
          baseFee: parseFloat((g.estimatedBaseFee || 0).toFixed(2)),
          slow: {
            maxFee: parseFloat((g.safeLow?.maxFee || 30).toFixed(2)),
            maxPriorityFee: parseFloat((g.safeLow?.maxPriorityFee || 30).toFixed(2)),
            label: 'Slow',
            time: '~30s',
          },
          standard: {
            maxFee: parseFloat((g.standard?.maxFee || 35).toFixed(2)),
            maxPriorityFee: parseFloat((g.standard?.maxPriorityFee || 32).toFixed(2)),
            label: 'Standard',
            time: '~15s',
          },
          fast: {
            maxFee: parseFloat((g.fast?.maxFee || 50).toFixed(2)),
            maxPriorityFee: parseFloat((g.fast?.maxPriorityFee || 40).toFixed(2)),
            label: 'Fast',
            time: '~5s',
          },
          recommended: {
            maxFee: parseFloat(((g.fast?.maxFee || 50) * 1.2).toFixed(2)),
            maxPriorityFee: parseFloat(((g.fast?.maxPriorityFee || 40) * 1.5).toFixed(2)),
            label: 'MEV Protection',
            time: '~3s',
            note: '20% above fast to front-run competing bots',
          },
          timestamp: new Date().toISOString(),
        };
      } catch {
        // Fallback if Polygon gas station is down
        gasData = {
          network: 'polygon',
          baseFee: 30,
          slow: { maxFee: 30, maxPriorityFee: 30, label: 'Slow', time: '~30s' },
          standard: { maxFee: 35, maxPriorityFee: 32, label: 'Standard', time: '~15s' },
          fast: { maxFee: 50, maxPriorityFee: 40, label: 'Fast', time: '~5s' },
          recommended: { maxFee: 60, maxPriorityFee: 60, label: 'MEV Protection', time: '~3s', note: 'Fallback values — gas station unreachable' },
          timestamp: new Date().toISOString(),
          fallback: true,
        };
      }

      _gasCache = { ts: Date.now(), data: gasData };
      res.json({ success: true, data: gasData });
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

  // ── Feature Importance Endpoints ──

  api.get('/learning/features', async (req, res) => {
    try {
      const model = await getEdgeModel();
      const report = model.getFeatureReport();
      res.json({ success: true, data: report });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/learning/features/permutation', async (req, res) => {
    try {
      const model = await getEdgeModel();
      const importance = model.getFeatureImportance({ permutation: true });
      res.json({ success: true, data: importance });
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

      const maxAge = parseInt(req.query.maxAge) || 86400000; // 24h default
      const cutoff = Date.now() - maxAge;

      let filteredWhales = (Array.isArray(whales) ? whales : []).filter(s => s.timestamp > cutoff);
      let filteredX = (Array.isArray(xSentiment) ? xSentiment : []).filter(s => s.timestamp > cutoff);
      let stale = false;

      // If no signals within maxAge, return the most recent ones so the page isn't blank
      if (filteredWhales.length === 0 && Array.isArray(whales) && whales.length > 0) {
        filteredWhales = whales.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 50);
        stale = true;
      }
      if (filteredX.length === 0 && Array.isArray(xSentiment) && xSentiment.length > 0) {
        filteredX = xSentiment.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).slice(0, 20);
        stale = true;
      }

      res.json({
        success: true,
        data: {
          whales: filteredWhales,
          xSentiment: filteredX,
          stale,
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

  async function loadAccountBot(accountId) {
    if (SINGLE_ACCOUNT_ONLY && accountId !== SINGLE_ACCOUNT_ID) {
      throw new Error(`Account '${accountId}' is disabled in single-account mode`);
    }
    const dataDir = getAccountDataDir(accountId);
    const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir });
    await bot.loadPortfolio();
    return bot;
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

  const RUST_ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://127.0.0.1:8900';
  const STARTING_CAPITAL = toNumber(process.env.STARTING_CAPITAL, 10000);
  const RUST_CACHE_TTL_MS = 2000;
  let _rustSnapshotCache = { ts: 0, data: null };
  let _lastResetTimestamp = null;

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
        fillRatio: toNumber(t.fill_ratio, 1),
        feesPaid: toNumber(t.fees_paid, 0),
        holdMs: toNumber(t.hold_ms, 0),
        entrySlippageBps: toNumber(t.entry_slippage_bps, 0),
        exitSlippageBps: toNumber(t.exit_slippage_bps, 0),
        shadowPnl: t.shadow_pnl != null ? toNumber(t.shadow_pnl, 0) : null,
        shadowEntryPrice: t.shadow_entry_price != null ? toNumber(t.shadow_entry_price, 0) : null,
        shadowExitPrice: t.shadow_exit_price != null ? toNumber(t.shadow_exit_price, 0) : null,
        shadowSlippageBps: t.shadow_slippage_bps != null ? toNumber(t.shadow_slippage_bps, 0) : null,
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
    // Use real Rust counts (not limited by display array size)
    const rustClosedCount = rust?.closedCount || 0;
    const rustWinCount = rust?.winCount || 0;
    const rustLossCount = rust?.lossCount || 0;
    const nodeClosedTrades = nodeTrades.filter(t => t.realizedPnl != null);
    const nodeWins = nodeClosedTrades.filter(t => toNumber(t.realizedPnl, 0) > 0);
    const nodeLosses = nodeClosedTrades.filter(t => toNumber(t.realizedPnl, 0) < 0);
    const closedTrades = mergedTrades.filter(t => t.realizedPnl != null);
    const openTrades = mergedTrades.filter(t => t.realizedPnl == null);
    // Real counts combining Node + Rust
    const wins = { length: nodeWins.length + rustWinCount };
    const losses = { length: nodeLosses.length + rustLossCount };

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

    const realClosedCount = nodeClosedTrades.length + rustClosedCount;
    return {
      mergedPnl,
      mergedTrades,
      closedTrades,
      openTrades,
      wins,
      losses,
      realClosedCount,
      totalValue: combinedTotalValue,
      totalReturn,
    };
  }

  function computeRealismMetrics(rustTrades = []) {
    const sample = rustTrades
      .filter(t => t.realizedPnl != null && t.shadowPnl != null)
      .slice(0, 200);
    if (sample.length === 0) {
      return {
        score: null,
        grade: 'N/A',
        sampleSize: 0,
        maeUsd: 0,
        biasUsd: 0,
        mapePct: 0,
        avgFillRatio: 0,
        avgEntrySlippageBps: 0,
        avgShadowSlippageBps: 0,
        warning: 'No comparable rust trade samples yet.',
      };
    }

    const absErrors = sample.map(t => Math.abs(toNumber(t.realizedPnl, 0) - toNumber(t.shadowPnl, 0)));
    const signedErrors = sample.map(t => toNumber(t.realizedPnl, 0) - toNumber(t.shadowPnl, 0));
    const pctErrors = sample.map(t => {
      const denom = Math.max(0.01, Math.abs(toNumber(t.shadowPnl, 0)));
      return Math.abs((toNumber(t.realizedPnl, 0) - toNumber(t.shadowPnl, 0)) / denom) * 100;
    });
    const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

    const maeUsd = avg(absErrors);
    const biasUsd = avg(signedErrors);
    const mapePct = avg(pctErrors);
    const avgFillRatio = avg(sample.map(t => toNumber(t.fillRatio, 1)));
    const avgEntrySlippageBps = avg(sample.map(t => toNumber(t.entrySlippageBps, 0)));
    const avgShadowSlippageBps = avg(sample.map(t => toNumber(t.shadowSlippageBps, 0)));
    const slippageDrift = Math.abs(avgEntrySlippageBps - avgShadowSlippageBps);

    // 100 is perfect paper/live alignment. Penalize error, bias and fill-quality drift.
    let score = 100
      - Math.min(45, maeUsd * 6.5)
      - Math.min(25, Math.abs(biasUsd) * 6.0)
      - Math.min(20, slippageDrift * 0.8)
      - Math.min(10, Math.max(0, 1 - avgFillRatio) * 100 * 0.4);
    score = Math.max(0, Math.min(100, score));

    const grade = score >= 90 ? 'A'
      : score >= 80 ? 'B'
      : score >= 70 ? 'C'
      : score >= 60 ? 'D'
      : 'F';

    return {
      score: Number(score.toFixed(1)),
      grade,
      sampleSize: sample.length,
      maeUsd: Number(maeUsd.toFixed(3)),
      biasUsd: Number(biasUsd.toFixed(3)),
      mapePct: Number(mapePct.toFixed(2)),
      avgFillRatio: Number(avgFillRatio.toFixed(3)),
      avgEntrySlippageBps: Number(avgEntrySlippageBps.toFixed(2)),
      avgShadowSlippageBps: Number(avgShadowSlippageBps.toFixed(2)),
      warning: sample.length < 25 ? 'Low sample size; realism score will stabilize with more trades.' : null,
    };
  }

  function computeLiveProjection(rustTrades = [], realism = null) {
    const sample = rustTrades
      .filter(t => t.realizedPnl != null && t.shadowPnl != null)
      .slice(0, 200);

    if (sample.length === 0) {
      return {
        available: false,
        confidence: 'low',
        sampleSize: 0,
        estimatedWinRateLow: null,
        estimatedWinRateHigh: null,
        projectedNetPnlPerTrade: null,
        projectedNetPnlPerTradeLow: null,
        projectedNetPnlPerTradeHigh: null,
        riskFlag: 'red',
        note: 'No comparable samples yet. Run more trades before trusting live projections.',
      };
    }

    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const avg = arr => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
    const stdDev = arr => {
      if (arr.length < 2) return 0;
      const m = avg(arr);
      const variance = avg(arr.map(v => (v - m) ** 2));
      return Math.sqrt(Math.max(0, variance));
    };

    const realizedSeries = sample.map(t => toNumber(t.realizedPnl, 0));
    const winners = realizedSeries.filter(v => v > 0).length;
    const baseWinRate = (winners / sample.length) * 100;
    const avgRealized = avg(realizedSeries);
    const pnlVolatility = stdDev(realizedSeries);

    const score = toNumber(realism?.score, 0);
    const fillRatio = toNumber(realism?.avgFillRatio, 1);
    const slippageDrift = Math.abs(
      toNumber(realism?.avgEntrySlippageBps, 0) - toNumber(realism?.avgShadowSlippageBps, 0)
    );
    const maeUsd = toNumber(realism?.maeUsd, 0);
    const biasUsd = Math.abs(toNumber(realism?.biasUsd, 0));

    // Conservative live penalty built from realism drift.
    const winRatePenalty =
      8
      + Math.max(0, 80 - score) * 0.3
      + Math.max(0, 1 - fillRatio) * 22
      + Math.max(0, slippageDrift) * 0.18;

    const projectedWinRate = clamp(baseWinRate - winRatePenalty, 5, 95);
    const rangeHalfWidth = sample.length < 40 ? 12 : sample.length < 100 ? 8 : 5;
    const estimatedWinRateLow = clamp(projectedWinRate - rangeHalfWidth, 1, 99);
    const estimatedWinRateHigh = clamp(projectedWinRate + rangeHalfWidth, 1, 99);

    const costDrag = biasUsd + (maeUsd * 0.35) + (Math.max(0, slippageDrift) * 0.01);
    const projectedNetPnlPerTrade = avgRealized - costDrag;
    const pnlBandHalf = Math.max(0.2, (pnlVolatility * 0.35) + (sample.length < 50 ? 0.45 : 0.2));
    const projectedNetPnlPerTradeLow = projectedNetPnlPerTrade - pnlBandHalf;
    const projectedNetPnlPerTradeHigh = projectedNetPnlPerTrade + pnlBandHalf;

    const confidence = sample.length >= 120 ? 'high' : sample.length >= 50 ? 'medium' : 'low';
    const riskFlag = projectedNetPnlPerTrade <= 0
      ? 'red'
      : estimatedWinRateLow < 45
        ? 'yellow'
        : 'green';

    return {
      available: true,
      confidence,
      sampleSize: sample.length,
      estimatedWinRateLow: Number(estimatedWinRateLow.toFixed(1)),
      estimatedWinRateHigh: Number(estimatedWinRateHigh.toFixed(1)),
      projectedNetPnlPerTrade: Number(projectedNetPnlPerTrade.toFixed(3)),
      projectedNetPnlPerTradeLow: Number(projectedNetPnlPerTradeLow.toFixed(3)),
      projectedNetPnlPerTradeHigh: Number(projectedNetPnlPerTradeHigh.toFixed(3)),
      riskFlag,
      note: riskFlag === 'red'
        ? 'Live expectancy is currently negative after realism penalties.'
        : riskFlag === 'yellow'
          ? 'Live expectancy is positive but fragile; keep sizing conservative.'
          : 'Live projection is positive with acceptable confidence.',
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
      let allRustTrades = Array.isArray(tradesRes.data) ? tradesRes.data : [];
      // Filter out trades from before the last reset
      if (_lastResetTimestamp) {
        const resetTs = new Date(_lastResetTimestamp).getTime();
        allRustTrades = allRustTrades.filter(t => {
          const tradeTs = new Date(t.timestamp || t.closed_at || 0).getTime();
          return tradeTs > resetTs;
        });
      }
      const filledRust = allRustTrades.filter(t => t.status === 'filled');
      // If all trades were filtered out by reset, zero out PnL too
      const rustPnlAdjusted = filledRust.length === 0
        ? { realized: 0, unrealized: 0, total: 0 }
        : pnl;
      const rustWins = filledRust.filter(t => toNumber(t.pnl, 0) > 0).length;
      const rustLosses = filledRust.filter(t => toNumber(t.pnl, 0) <= 0).length;
      const recentTrades = mapRustTrades(allRustTrades.slice(-500).reverse());
      const data = {
        available: status.running === true,
        status,
        pnl: {
          realized: toNumber(rustPnlAdjusted.realized, 0),
          unrealized: toNumber(rustPnlAdjusted.unrealized, 0),
          total: toNumber(rustPnlAdjusted.total, 0),
        },
        recentTrades,
        tradeCount: filledRust.length || toNumber(status.trades_today, 0),
        closedCount: filledRust.length,
        winCount: rustWins,
        lossCount: rustLosses,
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

  // Accounts response cache — serves stale data when API is slow
  let _accountsCache = { data: null, ts: 0 };
  const ACCOUNTS_CACHE_TTL = 10000; // 10s fresh cache
  const ACCOUNTS_STALE_TTL = 120000; // serve stale up to 2 min

  async function buildAccountsResponse() {
    const ids = discoverAccounts();
    const accounts = [];
    const rust = await fetchRustSnapshot();
    for (const id of ids) {
      const bot = await loadAccountBot(id);
      const portfolio = bot.getPortfolio();
      const report = await bot.generateReport();
      const includeRust = id === SINGLE_ACCOUNT_ID || id === 'paper';
      const merged = computeMergedStats(portfolio, report, includeRust ? rust : null);
      const realClosed = merged.realClosedCount || merged.closedTrades.length;
      const hasClosed = realClosed > 0;
      const winRate = hasClosed ? (merged.wins.length / realClosed * 100) : 0;
      const realTradeCount = includeRust ? (rust?.tradeCount || merged.mergedTrades.length) : merged.mergedTrades.length;
      accounts.push({
        id,
        portfolio: {
          ...portfolio,
          trades: merged.mergedTrades,
          totalTrades: realTradeCount,
          totalValue: merged.totalValue,
          pnl: merged.mergedPnl,
        },
        performance: {
          ...(report.performance || {}),
          totalTrades: realTradeCount,
          closedTrades: realClosed,
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
    return accounts;
  }

  api.get('/accounts', async (req, res) => {
    try {
      // Return fresh cache if available
      if (_accountsCache.data && Date.now() - _accountsCache.ts < ACCOUNTS_CACHE_TTL) {
        return res.json({ success: true, data: _accountsCache.data });
      }

      // Race: build fresh data vs 4s timeout
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000));
      const fresh = buildAccountsResponse().then(data => {
        _accountsCache = { data, ts: Date.now() };
        return data;
      });

      try {
        const data = await Promise.race([fresh, timeout]);
        res.json({ success: true, data });
      } catch {
        // Timeout — serve stale cache if available
        if (_accountsCache.data && Date.now() - _accountsCache.ts < ACCOUNTS_STALE_TTL) {
          res.json({ success: true, data: _accountsCache.data, stale: true });
        } else {
          res.status(504).json({ success: false, error: 'Account data temporarily unavailable' });
        }
        // Let the fresh build finish in background to update cache
        fresh.catch(() => {});
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/realism', async (req, res) => {
    try {
      const rust = await fetchRustSnapshot();
      const realism = computeRealismMetrics(rust?.recentTrades || []);
      const projection = computeLiveProjection(rust?.recentTrades || [], realism);
      res.json({
        success: true,
        data: {
          available: !!rust?.available,
          paperMode: rust?.status?.paper_mode !== false,
          timestamp: new Date().toISOString(),
          ...realism,
          projection,
        },
      });
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
        const bot = await loadAccountBot(id);
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
      const bot = await loadAccountBot(req.params.id);
      const portfolio = bot.getPortfolio();
      const report = await bot.generateReport();
      const includeRust = req.params.id === SINGLE_ACCOUNT_ID || req.params.id === 'paper';
      const rust = includeRust ? await fetchRustSnapshot() : null;
      const merged = computeMergedStats(portfolio, report, rust);
      const realTradeCount = includeRust ? (rust?.tradeCount || merged.mergedTrades.length) : merged.mergedTrades.length;
      res.json({
        success: true,
        data: {
          ...portfolio,
          trades: merged.mergedTrades,
          totalTrades: realTradeCount,
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
      const bot = await loadAccountBot(req.params.id);
      const report = await bot.generateReport();
      const includeRust = req.params.id === SINGLE_ACCOUNT_ID || req.params.id === 'paper';
      const rust = includeRust ? await fetchRustSnapshot() : null;
      const merged = computeMergedStats(bot.getPortfolio(), report, rust);
      const limit = parseInt(req.query.limit) || 500;
      res.json({ success: true, data: merged.mergedTrades.slice(0, limit) });
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

  // ── Orderflow / Whale Detection ──
  api.get('/orderflow/feed', (req, res) => {
    try {
      const watcher = getOrderflowWatcher(wsServer);
      const limit = parseInt(req.query.limit) || 50;
      let feed = watcher.getActivityFeed(limit);

      // If orderflow watcher has no data yet, seed from whale-signals.json
      if ((!feed || feed.length === 0)) {
        try {
          const whaleSignalsPath = path.join(__dirname, '..', 'data', 'whale-signals.json');
          const raw = JSON.parse(fs.readFileSync(whaleSignalsPath, 'utf8'));
          if (Array.isArray(raw) && raw.length > 0) {
            feed = raw
              .filter(s => s.timestamp)
              .sort((a, b) => b.timestamp - a.timestamp)
              .slice(0, limit)
              .map(s => ({
                event: s.size >= 5000 ? 'mega-whale' : 'whale-trade',
                side: (s.side || s.direction || 'BUY').toLowerCase(),
                size: s.totalSize || s.size || 0,
                assetId: s.conditionId || s.marketId || '',
                title: s.title || '',
                wallet: s.walletAddress || '',
                timestamp: s.timestamp,
              }));
          }
        } catch {}
      }

      res.json({ success: true, data: feed });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/orderflow/stats', (req, res) => {
    try {
      const watcher = getOrderflowWatcher(wsServer);
      res.json({ success: true, data: watcher.getStats() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/orderflow/volume', (req, res) => {
    try {
      const watcher = getOrderflowWatcher(wsServer);
      res.json({ success: true, data: watcher.getVolumeSnapshot() });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Initialize OrderflowWatcher after a short delay (let server bind first)
  setTimeout(() => {
    try { getOrderflowWatcher(wsServer); } catch (e) { console.error('[OrderflowWatcher] Init error:', e.message); }
  }, 5000);

  // ── Settings Endpoints (per-user) ──
  // Helper to get settings path for the authenticated user
  function getUserSettingsPath(req) {
    if (req.user) return auth.getUserFilePath(req.user.address, 'settings.json');
    return path.join(__dirname, '..', 'data', 'settings.json'); // fallback
  }

  api.get('/settings', (req, res) => {
    try {
      let settings = { ...DEFAULT_SETTINGS };
      const settingsPath = getUserSettingsPath(req);
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
      res.json({ success: true, data: settings });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/settings', express.json(), (req, res) => {
    try {
      const settings = req.body;
      const settingsPath = getUserSettingsPath(req);
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      res.json({ success: true, data: settings });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.get('/settings/live-status', (req, res) => {
    try {
      // Check per-user encrypted credentials
      const credStatus = req.user
        ? auth.getCredentialStatus(req.user.address)
        : { hasKey: false, hasApiKey: false, hasSecret: false, hasPassphrase: false };
      const hasAll = credStatus.hasKey && credStatus.hasApiKey && credStatus.hasSecret && credStatus.hasPassphrase;
      let currentMode = 'paper';
      try { currentMode = JSON.parse(fs.readFileSync(getUserSettingsPath(req), 'utf8'))?.trading?.mode || 'paper'; } catch {}
      res.json({
        success: true,
        data: {
          credentials: credStatus,
          hasAllCredentials: hasAll,
          mode: currentMode,
          canGoLive: hasAll,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/settings/trading-mode', express.json(), (req, res) => {
    try {
      const { mode } = req.body;
      if (!['paper', 'live'].includes(mode)) {
        return res.status(400).json({ success: false, error: 'Mode must be paper or live' });
      }
      if (mode === 'live') {
        const credStatus = auth.getCredentialStatus(req.user.address);
        if (!credStatus.hasKey || !credStatus.hasApiKey || !credStatus.hasSecret || !credStatus.hasPassphrase) {
          return res.status(400).json({ success: false, error: 'Missing CLOB credentials. Add them in Settings → Credentials.' });
        }
      }
      const settingsPath = getUserSettingsPath(req);
      let settings = { ...DEFAULT_SETTINGS };
      try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
      settings.trading = { ...settings.trading, mode };
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      res.json({ success: true, data: { mode } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Per-User Credential Management ──
  api.get('/settings/credentials', (req, res) => {
    try {
      const status = auth.getCredentialStatus(req.user.address);
      res.json({ success: true, data: status });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.post('/settings/credentials', express.json(), (req, res) => {
    try {
      const { privateKey, apiKey, apiSecret, passphrase } = req.body;
      if (!privateKey && !apiKey && !apiSecret && !passphrase) {
        return res.status(400).json({ success: false, error: 'At least one credential required' });
      }
      // Merge with existing credentials (don't overwrite fields not provided)
      const existing = auth.decryptCredentials(req.user.address) || {};
      const merged = {
        privateKey: privateKey || existing.privateKey || '',
        apiKey: apiKey || existing.apiKey || '',
        apiSecret: apiSecret || existing.apiSecret || '',
        passphrase: passphrase || existing.passphrase || '',
      };
      auth.encryptCredentials(req.user.address, merged);
      res.json({ success: true, data: auth.getCredentialStatus(req.user.address) });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  api.delete('/settings/credentials', (req, res) => {
    try {
      auth.deleteCredentials(req.user.address);
      res.json({ success: true, data: { cleared: true } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.use('/api', api);

  // When mounted (e.g. dashboard), pass through unmatched routes so SPA catch-all can serve index.html
  app.use((req, res, next) => next());

  return app;
}

module.exports = createApiServer;
