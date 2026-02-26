const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');

/**
 * PolymarketArbitrageBot - The Executioner Agent
 * Handles trade execution, P&L tracking, and portfolio management
 */
class PolymarketArbitrageBot extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.mode = config.mode || 'paper';
    this.edgeThreshold = config.edgeThreshold || 0.05;
    this.maxPositionSize = config.maxPositionSize || 1000;
    this.dataDir = config.dataDir || path.join(__dirname, 'data');
    
    this.portfolio = {
      cash: config.initialCash || 10000,
      positions: {},
      trades: [],
      pnl: { realized: 0, unrealized: 0, total: 0 }
    };

    this.slippageModel = {
      baseSlippage: 0.001,
      liquidityFactor: 0.5
    };

    this.init();
  }

  async init() {
    try {
      await fs.mkdir(this.dataDir, { recursive: true });
    } catch (error) {}
    await this.loadPortfolio();
  }

  getPortfolioPath() {
    return path.join(this.dataDir, `portfolio-${this.mode}.json`);
  }

  async loadPortfolio() {
    try {
      const data = await fs.readFile(this.getPortfolioPath(), 'utf8');
      const saved = JSON.parse(data);
      this.portfolio = { ...this.portfolio, ...saved };
      console.log(`💼 Loaded ${this.mode} portfolio: $${this.portfolio.cash.toFixed(2)} cash`);
    } catch (error) {
      console.log(`💼 New ${this.mode} portfolio: $${this.portfolio.cash.toFixed(2)}`);
      await this.savePortfolio();
    }
  }

  async savePortfolio() {
    try {
      await fs.writeFile(this.getPortfolioPath(), JSON.stringify(this.portfolio, null, 2));
    } catch (error) {
      console.error(`❌ Failed to save portfolio: ${error.message}`);
    }
  }

  calculateSlippage(positionSize, liquidity) {
    const sizeRatio = positionSize / (liquidity || 1);
    const slippage = this.slippageModel.baseSlippage + (sizeRatio * this.slippageModel.liquidityFactor);
    return Math.min(slippage, 0.05);
  }

  async simulateExecution(opportunity, size) {
    const timestamp = new Date().toISOString();
    const positionSize = Math.min(size, opportunity.maxPosition, this.maxPositionSize);
    
    const yesSlippage = this.calculateSlippage(positionSize / 2, opportunity.liquidity);
    const noSlippage = this.calculateSlippage(positionSize / 2, opportunity.liquidity);
    
    const yesPrice = opportunity.yesPrice * (1 + yesSlippage);
    const noPrice = opportunity.noPrice * (1 + noSlippage);
    
    const yesSize = positionSize / 2;
    const noSize = positionSize / 2;
    
    const yesShares = yesSize / yesPrice;
    const noShares = noSize / noPrice;
    
    const totalCost = yesSize + noSize;
    const expectedReturn = positionSize * (1 + opportunity.edgePercent);
    const expectedProfit = expectedReturn - totalCost;

    const trade = {
      id: `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp,
      marketId: opportunity.marketId,
      question: opportunity.question,
      mode: 'paper',
      direction: opportunity.direction,
      yesPrice, noPrice, yesShares, noShares, yesSize, noSize, totalCost,
      yesSlippage, noSlippage,
      edgePercent: opportunity.edgePercent,
      expectedReturn, expectedProfit,
      status: 'filled', filledAt: timestamp
    };

    this.portfolio.cash -= totalCost;
    this.portfolio.positions[opportunity.marketId] = {
      marketId: opportunity.marketId,
      question: opportunity.question,
      yesShares, noShares,
      entryCost: totalCost,
      entryTime: timestamp,
      status: 'open'
    };
    this.portfolio.trades.push(trade);

    this.updatePnL();
    await this.savePortfolio();

    this.emit('trade:executed', { trade, portfolio: this.portfolio });
    return trade;
  }

  async executeLive(opportunity, size) {
    console.log('🔴 LIVE TRADE - This would execute on-chain');
    throw new Error('Live trading not yet implemented. Use paper mode.');
  }

  async execute(opportunity, options = {}) {
    const size = options.size || opportunity.maxPosition;
    
    if (opportunity.edgePercent < this.edgeThreshold) {
      throw new Error(`Edge ${(opportunity.edgePercent * 100).toFixed(2)}% below threshold`);
    }
    if (size > this.portfolio.cash) {
      throw new Error(`Insufficient funds: $${this.portfolio.cash.toFixed(2)} available`);
    }

    if (this.mode === 'paper') {
      return this.simulateExecution(opportunity, size);
    } else {
      return this.executeLive(opportunity, size);
    }
  }

  async autoExecute(opportunities, options = {}) {
    const minEdge = options.minEdge || this.edgeThreshold;
    const executed = [], skipped = [], failed = [];

    for (const opp of opportunities) {
      try {
        if (opp.edgePercent < minEdge) {
          skipped.push({ opportunity: opp, reason: 'Below edge threshold' });
          continue;
        }
        if (this.portfolio.positions[opp.marketId]) {
          skipped.push({ opportunity: opp, reason: 'Already positioned' });
          continue;
        }
        if (this.portfolio.cash < opp.maxPosition) {
          skipped.push({ opportunity: opp, reason: 'Insufficient cash' });
          continue;
        }

        const trade = await this.execute(opp);
        executed.push(trade);
        console.log(`✅ Executed: ${opp.question.substring(0, 50)}... | Edge: ${(opp.edgePercent * 100).toFixed(2)}%`);
      } catch (error) {
        failed.push({ opportunity: opp, error: error.message });
        console.error(`❌ Failed: ${error.message}`);
      }
    }

    return { executed, skipped, failed };
  }

  updatePnL() {
    let unrealized = 0;
    for (const pos of Object.values(this.portfolio.positions)) {
      if (pos.status === 'open') {
        unrealized += pos.yesShares * 0.5 + pos.noShares * 0.5 - pos.entryCost;
      }
    }
    const realized = this.portfolio.trades
      .filter(t => t.realizedPnl)
      .reduce((sum, t) => sum + t.realizedPnl, 0);

    this.portfolio.pnl = { realized, unrealized, total: realized + unrealized };
  }

  async closePosition(marketId, outcome) {
    const position = this.portfolio.positions[marketId];
    if (!position) throw new Error(`No position found for market ${marketId}`);

    const winningShares = outcome === 'yes' ? position.yesShares : position.noShares;
    const payout = winningShares * 1;
    const realizedPnl = payout - position.entryCost;

    position.status = 'closed';
    position.closeTime = new Date().toISOString();
    position.outcome = outcome;
    position.payout = payout;
    position.realizedPnl = realizedPnl;

    this.portfolio.cash += payout;
    
    const trade = this.portfolio.trades.find(t => t.marketId === marketId && !t.realizedPnl);
    if (trade) {
      trade.realizedPnl = realizedPnl;
      trade.closedAt = new Date().toISOString();
    }

    this.updatePnL();
    await this.savePortfolio();

    this.emit('position:closed', { marketId, payout, realizedPnl, roi: (realizedPnl / position.entryCost * 100).toFixed(2) + '%' });
    return { marketId, payout, realizedPnl, roi: (realizedPnl / position.entryCost * 100).toFixed(2) + '%' };
  }

  getPortfolio() {
    this.updatePnL();
    return {
      ...this.portfolio,
      openPositions: Object.values(this.portfolio.positions).filter(p => p.status === 'open').length,
      closedPositions: Object.values(this.portfolio.positions).filter(p => p.status === 'closed').length,
      totalTrades: this.portfolio.trades.length
    };
  }

  async generateReport() {
    const portfolio = this.getPortfolio();
    const trades = portfolio.trades;
    
    const winningTrades = trades.filter(t => (t.realizedPnl || 0) > 0);
    const losingTrades = trades.filter(t => (t.realizedPnl || 0) < 0);
    
    const winRate = trades.length > 0 ? (winningTrades.length / trades.length * 100).toFixed(1) : 0;
    const avgWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.realizedPnl, 0) / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? losingTrades.reduce((sum, t) => sum + t.realizedPnl, 0) / losingTrades.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin * winningTrades.length) / (Math.abs(avgLoss) * losingTrades.length) : 0;

    return {
      mode: this.mode,
      generatedAt: new Date().toISOString(),
      portfolio: {
        cash: portfolio.cash,
        initialCash: 10000,
        totalReturn: ((portfolio.cash - 10000) / 10000 * 100).toFixed(2) + '%',
        openPositions: portfolio.openPositions,
        closedPositions: portfolio.closedPositions
      },
      pnl: portfolio.pnl,
      performance: {
        totalTrades: trades.length,
        winningTrades: winningTrades.length,
        losingTrades: losingTrades.length,
        winRate: winRate + '%',
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        profitFactor: profitFactor.toFixed(2)
      },
      recentTrades: trades.slice(-10).reverse()
    };
  }

  async reset() {
    if (this.mode !== 'paper') throw new Error('Cannot reset live portfolio');
    
    this.portfolio = {
      cash: 10000,
      positions: {},
      trades: [],
      pnl: { realized: 0, unrealized: 0, total: 0 }
    };
    
    await this.savePortfolio();
    console.log('🔄 Paper portfolio reset to $10,000');
  }
}

module.exports = PolymarketArbitrageBot;
