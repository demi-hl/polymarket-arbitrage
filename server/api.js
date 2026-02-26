const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PolymarketScanner = require('../scanner');
const PolymarketArbitrageBot = require('../bot');
const { StrategyRegistry } = require('../strategies');
const RiskManager = require('../risk-manager');
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
  
  // Get portfolio
  api.get('/portfolio', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
      const portfolio = bot.getPortfolio();
      res.json({ success: true, data: portfolio });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });
  
  // Get trades
  api.get('/trades', async (req, res) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
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
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
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
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
      
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
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
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
  
  app.use('/api', api);
  
  return app;
}

module.exports = createApiServer;
