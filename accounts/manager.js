/**
 * Multi-Account Manager
 * Manages multiple paper trading accounts with A/B testing capabilities
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const MultiAccountConfig = require('../config/multi-account');
const VolumeTradingEngine = require('../trading/volume');

class MultiAccountManager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = MultiAccountConfig;
    this.dataDir = options.dataDir || path.join(__dirname, '../data/multi-account');
    this.accounts = new Map();
    this.volumeEngine = new VolumeTradingEngine();
    this.isRunning = false;
    this.scanInterval = null;
    
    // Performance tracking
    this.performance = {
      startTime: null,
      scansCompleted: 0,
      totalOpportunities: 0
    };
  }

  async init() {
    // Ensure data directory exists
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {
      // Directory may already exist
    }

    // Initialize both accounts
    await this.initializeAccount('aggressive');
    await this.initializeAccount('conservative');
    
    console.log('✅ Multi-Account Manager initialized');
    console.log(`   Aggressive: $10,000 virtual | Conservative: $10,000 virtual`);
    
    return this;
  }

  async initializeAccount(accountId) {
    const accountConfig = this.config.getAccountConfig(accountId);
    const portfolioPath = this.getPortfolioPath(accountId);
    
    let portfolio;
    try {
      const data = await fs.readFile(portfolioPath, 'utf8');
      portfolio = JSON.parse(data);
      console.log(`💼 Loaded ${accountId} portfolio: $${portfolio.cash.toFixed(2)} cash`);
    } catch (error) {
      // Create new portfolio
      portfolio = {
        accountId,
        cash: accountConfig.virtualBalance,
        initialBalance: accountConfig.virtualBalance,
        positions: {},
        trades: [],
        dailyStats: {
          date: new Date().toISOString().split('T')[0],
          trades: 0,
          pnl: 0,
          losses: 0
        },
        pnl: { realized: 0, unrealized: 0, total: 0 },
        createdAt: new Date().toISOString()
      };
      console.log(`💼 New ${accountId} portfolio: $${portfolio.cash.toFixed(2)}`);
      await this.savePortfolio(accountId, portfolio);
    }
    
    this.accounts.set(accountId, {
      config: accountConfig,
      portfolio,
      metrics: {
        totalTrades: 0,
        winningTrades: 0,
        totalPnl: 0,
        maxDrawdown: 0,
        peakBalance: accountConfig.virtualBalance
      },
      strategyPerformance: {}
    });
    
    return portfolio;
  }

  getPortfolioPath(accountId) {
    return path.join(this.dataDir, `portfolio-${accountId}.json`);
  }

  async savePortfolio(accountId, portfolio) {
    const portfolioPath = this.getPortfolioPath(accountId);
    try {
      await fs.writeFile(portfolioPath, JSON.stringify(portfolio, null, 2));
    } catch (error) {
      console.error(`❌ Failed to save ${accountId} portfolio:`, error.message);
    }
  }

  getAccount(accountId) {
    return this.accounts.get(accountId);
  }

  getAllAccounts() {
    return Array.from(this.accounts.entries()).map(([id, data]) => ({
      id,
      ...data
    }));
  }

  // Volume-based position sizing
  calculatePositionSize(accountId, opportunity) {
    return this.volumeEngine.calculatePositionSize(accountId, opportunity);
  }

  // Check if account can trade
  canTrade(accountId, opportunity) {
    const account = this.accounts.get(accountId);
    if (!account) return { canTrade: false, reason: 'Account not found' };
    
    const { config, portfolio, metrics } = account;
    
    // Check minimum edge
    if (opportunity.edgePercent < config.minEdge) {
      return { canTrade: false, reason: `Edge ${(opportunity.edgePercent * 100).toFixed(2)}% below minimum ${(config.minEdge * 100).toFixed(2)}%` };
    }
    
    // Check if already positioned in this market
    if (portfolio.positions[opportunity.marketId]) {
      return { canTrade: false, reason: 'Already positioned in this market' };
    }
    
    // Check daily trade limit
    const today = new Date().toISOString().split('T')[0];
    if (portfolio.dailyStats.date !== today) {
      portfolio.dailyStats = { date: today, trades: 0, pnl: 0, losses: 0 };
    }
    if (portfolio.dailyStats.trades >= config.maxDailyTrades) {
      return { canTrade: false, reason: 'Daily trade limit reached' };
    }
    
    // Check daily loss limit
    if (portfolio.dailyStats.losses <= -config.dailyLossLimit) {
      return { canTrade: false, reason: 'Daily loss limit reached' };
    }
    
    // Check max drawdown
    const currentBalance = portfolio.cash + this.calculateUnrealizedPnl(accountId);
    if (metrics.peakBalance > 0) {
      const drawdown = (metrics.peakBalance - currentBalance) / metrics.peakBalance;
      if (drawdown >= config.maxDrawdown) {
        return { canTrade: false, reason: 'Max drawdown reached' };
      }
    }
    
    // Check sufficient funds
    const positionSize = this.calculatePositionSize(accountId, opportunity);
    if (positionSize > portfolio.cash) {
      return { canTrade: false, reason: 'Insufficient funds' };
    }
    
    return { canTrade: true, positionSize };
  }

  calculateUnrealizedPnl(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) return 0;
    
    let unrealized = 0;
    for (const position of Object.values(account.portfolio.positions)) {
      if (position.status === 'open') {
        // Assume both YES and NO are worth $0.50 each for unrealized PnL
        // (they'll resolve to $1.00 and $0.00)
        unrealized += (position.yesShares * 0.5 + position.noShares * 0.5) - position.entryCost;
      }
    }
    return unrealized;
  }

  // Execute a trade for an account
  async executeTrade(accountId, opportunity) {
    const check = this.canTrade(accountId, opportunity);
    if (!check.canTrade) {
      return { success: false, reason: check.reason };
    }
    
    const account = this.accounts.get(accountId);
    const { config, portfolio } = account;
    const positionSize = check.positionSize;
    
    // Simulate execution with slippage
    const execution = this.volumeEngine.simulateExecution(
      accountId,
      opportunity,
      positionSize
    );
    
    // Update portfolio
    portfolio.cash -= execution.totalCost;
    portfolio.positions[opportunity.marketId] = {
      marketId: opportunity.marketId,
      question: opportunity.question,
      yesShares: execution.yesShares,
      noShares: execution.noShares,
      entryCost: execution.totalCost,
      entryTime: new Date().toISOString(),
      status: 'open',
      strategy: opportunity.strategy || 'unknown'
    };
    
    // Record trade
    const trade = {
      id: `trade-${accountId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      accountId,
      timestamp: new Date().toISOString(),
      marketId: opportunity.marketId,
      question: opportunity.question,
      direction: opportunity.direction,
      edgePercent: opportunity.edgePercent,
      positionSize,
      ...execution,
      expectedProfit: execution.expectedProfit,
      status: 'filled',
      strategy: opportunity.strategy || 'unknown'
    };
    
    portfolio.trades.push(trade);
    portfolio.dailyStats.trades++;
    
    // Update metrics
    account.metrics.totalTrades++;
    
    // Track strategy performance
    const strategyName = opportunity.strategy || 'unknown';
    if (!account.strategyPerformance[strategyName]) {
      account.strategyPerformance[strategyName] = { trades: 0, wins: 0, pnl: 0 };
    }
    account.strategyPerformance[strategyName].trades++;
    
    await this.savePortfolio(accountId, portfolio);
    
    this.emit('trade:executed', { accountId, trade, portfolio });
    
    return { success: true, trade };
  }

  // Close a position
  async closePosition(accountId, marketId, outcome) {
    const account = this.accounts.get(accountId);
    if (!account) return { success: false, reason: 'Account not found' };
    
    const position = account.portfolio.positions[marketId];
    if (!position || position.status !== 'open') {
      return { success: false, reason: 'Position not found or already closed' };
    }
    
    // Calculate payout
    const winningShares = outcome === 'yes' ? position.yesShares : position.noShares;
    const payout = winningShares * 1; // Each share pays $1 if correct
    const realizedPnl = payout - position.entryCost;
    
    // Update position
    position.status = 'closed';
    position.closeTime = new Date().toISOString();
    position.outcome = outcome;
    position.payout = payout;
    position.realizedPnl = realizedPnl;
    
    // Update portfolio
    account.portfolio.cash += payout;
    account.portfolio.pnl.realized += realizedPnl;
    account.portfolio.dailyStats.pnl += realizedPnl;
    if (realizedPnl < 0) {
      account.portfolio.dailyStats.losses += realizedPnl;
    }
    
    // Update trade record
    const trade = account.portfolio.trades.find(
      t => t.marketId === marketId && !t.realizedPnl
    );
    if (trade) {
      trade.realizedPnl = realizedPnl;
      trade.closedAt = new Date().toISOString();
    }
    
    // Update metrics
    if (realizedPnl > 0) {
      account.metrics.winningTrades++;
      account.metrics.totalPnl += realizedPnl;
      if (position.strategy && account.strategyPerformance[position.strategy]) {
        account.strategyPerformance[position.strategy].wins++;
        account.strategyPerformance[position.strategy].pnl += realizedPnl;
      }
    } else {
      account.metrics.totalPnl += realizedPnl;
      if (position.strategy && account.strategyPerformance[position.strategy]) {
        account.strategyPerformance[position.strategy].pnl += realizedPnl;
      }
    }
    
    // Update peak balance and drawdown
    const currentBalance = account.portfolio.cash + this.calculateUnrealizedPnl(accountId);
    if (currentBalance > account.metrics.peakBalance) {
      account.metrics.peakBalance = currentBalance;
    }
    const drawdown = (account.metrics.peakBalance - currentBalance) / account.metrics.peakBalance;
    if (drawdown > account.metrics.maxDrawdown) {
      account.metrics.maxDrawdown = drawdown;
    }
    
    await this.savePortfolio(accountId, account.portfolio);
    
    this.emit('position:closed', { accountId, marketId, realizedPnl, roi: (realizedPnl / position.entryCost * 100).toFixed(2) + '%' });
    
    return { 
      success: true, 
      realizedPnl, 
      roi: realizedPnl / position.entryCost,
      payout
    };
  }

  // Get account summary
  getAccountSummary(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) return null;
    
    const { config, portfolio, metrics } = account;
    const unrealized = this.calculateUnrealizedPnl(accountId);
    const totalValue = portfolio.cash + unrealized;
    const totalReturn = (totalValue - config.virtualBalance) / config.virtualBalance;
    
    return {
      accountId,
      name: config.name,
      cash: portfolio.cash,
      unrealizedPnl: unrealized,
      totalValue,
      totalReturn: totalReturn * 100,
      openPositions: Object.values(portfolio.positions).filter(p => p.status === 'open').length,
      closedPositions: Object.values(portfolio.positions).filter(p => p.status === 'closed').length,
      totalTrades: metrics.totalTrades,
      winningTrades: metrics.winningTrades,
      winRate: metrics.totalTrades > 0 ? (metrics.winningTrades / metrics.totalTrades * 100).toFixed(1) : 0,
      maxDrawdown: (metrics.maxDrawdown * 100).toFixed(2),
      dailyTrades: portfolio.dailyStats.trades,
      strategyPerformance: account.strategyPerformance
    };
  }

  // Get comparison data for both accounts
  getComparisonData() {
    return {
      aggressive: this.getAccountSummary('aggressive'),
      conservative: this.getAccountSummary('conservative'),
      timestamp: new Date().toISOString()
    };
  }

  // Reset an account
  async resetAccount(accountId) {
    const account = this.accounts.get(accountId);
    if (!account) return { success: false, reason: 'Account not found' };
    
    const config = account.config;
    const portfolio = {
      accountId,
      cash: config.virtualBalance,
      initialBalance: config.virtualBalance,
      positions: {},
      trades: [],
      dailyStats: {
        date: new Date().toISOString().split('T')[0],
        trades: 0,
        pnl: 0,
        losses: 0
      },
      pnl: { realized: 0, unrealized: 0, total: 0 },
      resetAt: new Date().toISOString()
    };
    
    account.portfolio = portfolio;
    account.metrics = {
      totalTrades: 0,
      winningTrades: 0,
      totalPnl: 0,
      maxDrawdown: 0,
      peakBalance: config.virtualBalance
    };
    account.strategyPerformance = {};
    
    await this.savePortfolio(accountId, portfolio);
    
    return { success: true, message: `${accountId} account reset to $${config.virtualBalance}` };
  }

  // Reset both accounts
  async resetAll() {
    await this.resetAccount('aggressive');
    await this.resetAccount('conservative');
    return { success: true, message: 'All accounts reset' };
  }
}

module.exports = MultiAccountManager;
