const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PolymarketScanner = require('../scanner');
const PolymarketArbitrageBot = require('../bot');
const { StrategyRegistry } = require('../strategies');
const RiskManager = require('../risk-manager');
const WhaleTracker = require('../integrations/whale-tracker');
const DataStore = require('../learning/data-store');
const EdgeModel = require('../learning/edge-model');
const { MarketMaker } = require('../strategies/market-maker');
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
  
  // Status (running state, version)
  api.get('/status', (req, res) => {
    res.json({
      status: 'running',
      version: '2.0.0',
      timestamp: new Date().toISOString(),
      endpoints: ['/api/portfolio', '/api/opportunities', '/api/strategies', '/api/report', '/api/risk']
    });
  });
  
  const accountId = process.env.ACCOUNT_ID || 'default';
  const botDataDir = accountId !== 'default'
    ? path.join(__dirname, '..', 'data', `account-${accountId}`)
    : undefined;

  // Get portfolio
  api.get('/portfolio', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper', dataDir: botDataDir });
      await bot.loadPortfolio();
      const portfolio = bot.getPortfolio();
      res.json({ success: true, data: portfolio });
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
      res.json({ success: true, data: report.recentTrades });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get opportunities
  api.get('/opportunities', async (req, res) => {
    try {
      const threshold = parseFloat(req.query.threshold) / 100 || 0.05;
      const scanner = new PolymarketScanner({ edgeThreshold: threshold });
      const result = await scanner.scan({ threshold });
      
      res.json({ success: true, data: result });
    } catch (err) {
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
      const report = await bot.generateReport();
      res.json({ success: true, data: report });
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

  api.get('/accounts', async (req, res) => {
    try {
      const ids = discoverAccounts();
      const accounts = [];
      for (const id of ids) {
        const bot = loadAccountBot(id);
        await new Promise(r => setTimeout(r, 100));
        const portfolio = bot.getPortfolio();
        const report = await bot.generateReport();
        accounts.push({
          id,
          portfolio,
          performance: report.performance,
          pnl: report.pnl,
          recentTrades: report.recentTrades,
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
      for (const id of ids) {
        const bot = loadAccountBot(id);
        await new Promise(r => setTimeout(r, 100));
        const portfolio = bot.getPortfolio();
        const report = await bot.generateReport();
        const trades = portfolio.trades || [];
        const edges = trades.map(t => t.edgePercent || 0).filter(e => e > 0);
        const avgEdge = edges.length > 0 ? edges.reduce((a, b) => a + b, 0) / edges.length : 0;

        const totalValue = portfolio.totalValue || (portfolio.cash + (portfolio.pnl?.unrealized || 0));

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
          totalReturn: parseFloat(report.portfolio.totalReturn) || 0,
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
          pnl: portfolio.pnl,
          recentTrades: trades.slice(-50).reverse(),
          equityCurve: buildEquityCurve(trades, portfolio.pnl, portfolio),
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
      res.json({ success: true, data: portfolio });
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
      res.json({ success: true, data: report.recentTrades });
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

    const events = [];
    for (const t of trades) {
      const openTs = t.timestamp ? new Date(t.timestamp).getTime() : Date.now();
      events.push({ ts: openTs, type: 'open', cost: t.totalCost || 0, realizedPnl: 0 });

      if (t.realizedPnl != null) {
        const closeTs = t.closedAt ? new Date(t.closedAt).getTime() : openTs + 60000;
        events.push({ ts: closeTs, type: 'close', cost: t.totalCost || 0, realizedPnl: t.realizedPnl });
      }
    }
    events.sort((a, b) => a.ts - b.ts);

    const firstTs = Math.floor(events[0].ts / 1000) - 3600;
    const curve = [{ time: firstTs, value: startingCapital }];
    let lastTime = firstTs;
    let cash = startingCapital;
    let invested = 0;
    let cumulativeRealized = 0;

    for (const ev of events) {
      if (ev.type === 'open') {
        cash -= ev.cost;
        invested += ev.cost;
      } else {
        const payout = ev.cost + ev.realizedPnl;
        cash += payout;
        invested -= ev.cost;
        cumulativeRealized += ev.realizedPnl;
      }

      const equity = cash + invested;
      let ts = Math.floor(ev.ts / 1000);
      if (ts <= lastTime) ts = lastTime + 1;
      lastTime = ts;
      curve.push({ time: ts, value: parseFloat(equity.toFixed(2)) });
    }

    const currentValue = portfolio?.totalValue ?? (cash + invested + (pnl?.unrealized || 0));
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
