const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const ClobClient = require('./clob-client');

/**
 * PolymarketArbitrageBot - The Executioner Agent
 * Handles trade execution, P&L tracking, and portfolio management.
 * Uses CLOB orderbook data when available for realistic slippage estimation.
 */
class PolymarketArbitrageBot extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.mode = config.mode || 'paper';
    this.edgeThreshold = config.edgeThreshold || 0.05;
    this.scanThreshold = config.scanThreshold;
    this.maxPositionSize = config.maxPositionSize || 1000;
    /** @type {string[]|undefined} - Sectors to scan: politics, sports, crypto */
    this.sectors = config.sectors;
    this.dataDir = config.dataDir || path.join(__dirname, 'data');
    this.clob = config.clobClient || new ClobClient();
    
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

    this.fees = {
      polymarket: 0.00,
      polymarketSpread: 0.001,
      kalshiFee: 0.02,
      predictitFee: 0.10,
      gasCostPerTx: 0.04,
    };

    this.maxLiquidityPct = 0.02;

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

  calculateSlippage(positionSize, liquidity, clobDepth) {
    if (clobDepth && clobDepth.fillPrice != null && !clobDepth.partial) {
      return clobDepth.slippage || 0;
    }
    const sizeRatio = positionSize / (liquidity || 1);
    const slippage = this.slippageModel.baseSlippage + (sizeRatio * this.slippageModel.liquidityFactor);
    return Math.min(slippage, 0.10);
  }

  calculateMaxPosition(liquidity) {
    return Math.min((liquidity || 0) * this.maxLiquidityPct, this.maxPositionSize);
  }

  estimateTotalCost(edgePercent, slippage) {
    return this.fees.polymarketSpread + slippage + (this.fees.gasCostPerTx * 2 / 100);
  }

  async simulateExecution(opportunity, size) {
    const timestamp = new Date().toISOString();
    const liquidityCap = this.calculateMaxPosition(opportunity.liquidity);

    const edge = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;
    const edgeMultiplier = Math.min(Math.max(edge / this.edgeThreshold, 0.5), 3.0);
    const dynamicSize = size * edgeMultiplier;

    const positionSize = Math.min(dynamicSize, opportunity.maxPosition, this.maxPositionSize, liquidityCap);

    if (positionSize < 5) {
      throw new Error(`Position too small ($${positionSize.toFixed(2)}) — insufficient liquidity`);
    }

    const dir = opportunity.direction || 'BUY_BOTH';
    const isDirectional = dir === 'BUY_YES' || dir === 'BUY_NO';

    let yesSize, noSize, yesSlippage, noSlippage;

    if (isDirectional) {
      const sideSlippage = this.calculateSlippage(positionSize, opportunity.liquidity, null);
      if (dir === 'BUY_YES') {
        yesSize = positionSize;
        noSize = 0;
        yesSlippage = sideSlippage;
        noSlippage = 0;
      } else {
        yesSize = 0;
        noSize = positionSize;
        yesSlippage = 0;
        noSlippage = sideSlippage;
      }
    } else {
      const halfSize = positionSize / 2;
      const yesClobDepth = opportunity.clobYesDepth
        ? this.clob.depthAtPrice(opportunity.clobTokenIds?.[0], 'buy', halfSize)
        : null;
      const noClobDepth = opportunity.clobNoDepth
        ? this.clob.depthAtPrice(opportunity.clobTokenIds?.[1], 'buy', halfSize)
        : null;
      yesSlippage = this.calculateSlippage(halfSize, opportunity.liquidity, yesClobDepth);
      noSlippage = this.calculateSlippage(halfSize, opportunity.liquidity, noClobDepth);
      yesSize = halfSize;
      noSize = halfSize;
    }

    const avgSlippage = isDirectional
      ? (yesSlippage || noSlippage)
      : (yesSlippage + noSlippage) / 2;

    const effectiveEdge = opportunity.executableEdge ?? opportunity.edgePercent;
    let totalCostPct = this.estimateTotalCost(effectiveEdge, avgSlippage);
    const netEdge = effectiveEdge - totalCostPct;

    if (netEdge <= 0) {
      throw new Error(`Edge ${(effectiveEdge * 100).toFixed(2)}% wiped by costs ${(totalCostPct * 100).toFixed(2)}%`);
    }

    const yesPrice = opportunity.yesPrice * (1 + yesSlippage);
    const noPrice = opportunity.noPrice * (1 + noSlippage);

    const yesShares = yesSize > 0 ? yesSize / yesPrice : 0;
    const noShares = noSize > 0 ? noSize / noPrice : 0;

    const totalCost = yesSize + noSize;
    const expectedReturn = positionSize * (1 + netEdge);
    const expectedProfit = expectedReturn - totalCost;

    const trade = {
      id: `trade-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp,
      marketId: opportunity.marketId,
      question: opportunity.question,
      strategy: opportunity.strategy || 'basic-arbitrage',
      mode: 'paper',
      direction: opportunity.direction,
      pricingSource: opportunity.pricingSource || 'gamma',
      yesPrice, noPrice, yesShares, noShares, yesSize, noSize, totalCost,
      yesSlippage, noSlippage,
      grossEdge: opportunity.edgePercent,
      executableEdge: effectiveEdge,
      slippageCost: avgSlippage,
      spreadCost: this.fees.polymarketSpread,
      netEdge,
      edgePercent: netEdge,
      expectedReturn, expectedProfit,
      liquidityCap,
      status: 'filled', filledAt: timestamp
    };

    this.portfolio.cash -= totalCost;
    this.portfolio.positions[opportunity.marketId] = {
      marketId: opportunity.marketId,
      question: opportunity.question,
      yesShares, noShares,
      entryYesPrice: yesPrice,
      entryNoPrice: noPrice,
      entryCost: totalCost,
      entryTime: timestamp,
      direction: opportunity.direction || 'BUY_BOTH',
      strategy: opportunity.strategy || 'basic-arbitrage',
      clobTokenIds: opportunity.clobTokenIds || [],
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
    const maxTradesPerCycle = options.maxTradesPerCycle || 3;
    const executed = [], skipped = [], failed = [];

    for (const opp of opportunities) {
      try {
        if (executed.length >= maxTradesPerCycle) {
          skipped.push({ opportunity: opp, reason: 'Max trades per cycle reached' });
          continue;
        }
        if (opp.edgePercent < minEdge) {
          skipped.push({ opportunity: opp, reason: 'Below edge threshold' });
          continue;
        }
        if (this.portfolio.positions[opp.marketId]) {
          skipped.push({ opportunity: opp, reason: 'Already positioned' });
          continue;
        }
        if (this.portfolio.cash < 10) {
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

  updatePnL(currentPrices = null) {
    let unrealized = 0;
    for (const pos of Object.values(this.portfolio.positions)) {
      if (pos.status !== 'open') continue;

      const mktPrices = currentPrices?.[pos.marketId];
      let currentYes, currentNo;

      if (mktPrices) {
        currentYes = mktPrices.yesPrice ?? pos.entryYesPrice ?? 0.5;
        currentNo = mktPrices.noPrice ?? pos.entryNoPrice ?? 0.5;
      } else {
        const yesToken = pos.clobTokenIds?.[0];
        const noToken = pos.clobTokenIds?.[1];
        const yesBook = yesToken ? this.clob.getCachedBook(yesToken) : null;
        const noBook = noToken ? this.clob.getCachedBook(noToken) : null;

        currentYes = yesBook?.midpoint
          ?? pos.currentYesPrice
          ?? pos.entryYesPrice ?? 0.5;
        currentNo = noBook?.midpoint
          ?? pos.currentNoPrice
          ?? pos.entryNoPrice ?? 0.5;
      }

      const currentValue = (pos.yesShares * currentYes) + (pos.noShares * currentNo);
      unrealized += currentValue - pos.entryCost;
    }

    const realized = this.portfolio.trades
      .filter(t => t.realizedPnl != null)
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

  async closePositionAtMarket(marketId, currentYesPrice, currentNoPrice) {
    const position = this.portfolio.positions[marketId];
    if (!position) throw new Error(`No position found for market ${marketId}`);

    const GAS_COST = 0.04;
    const SELL_SLIPPAGE = 0.003;

    const yesExitPrice = currentYesPrice * (1 - SELL_SLIPPAGE);
    const noExitPrice = currentNoPrice * (1 - SELL_SLIPPAGE);
    const sellValue = (position.yesShares * yesExitPrice) + (position.noShares * noExitPrice);
    const payout = sellValue - GAS_COST;
    const realizedPnl = payout - position.entryCost;

    position.status = 'closed';
    position.closeTime = new Date().toISOString();
    position.closeMethod = 'market';
    position.exitYesPrice = currentYesPrice;
    position.exitNoPrice = currentNoPrice;
    position.payout = payout;
    position.gasCost = GAS_COST;
    position.sellSlippage = SELL_SLIPPAGE;
    position.realizedPnl = realizedPnl;

    this.portfolio.cash += payout;

    const trade = this.portfolio.trades.find(t => t.marketId === marketId && !t.realizedPnl);
    if (trade) {
      trade.realizedPnl = realizedPnl;
      trade.closedAt = new Date().toISOString();
      trade.closeMethod = 'market';
      trade.exitYesPrice = currentYesPrice;
      trade.exitNoPrice = currentNoPrice;
      trade.gasCost = GAS_COST;
    }

    this.updatePnL();
    await this.savePortfolio();

    this.emit('position:closed', { marketId, payout, realizedPnl, method: 'market' });
    return { marketId, payout, realizedPnl, roi: (realizedPnl / position.entryCost * 100).toFixed(2) + '%' };
  }

  getPortfolio(currentPrices = null) {
    this.updatePnL(currentPrices);
    const openPositions = Object.values(this.portfolio.positions).filter(p => p.status === 'open');
    const invested = openPositions.reduce((sum, p) => sum + (p.entryCost || 0), 0);
    const totalValue = this.portfolio.cash + invested + this.portfolio.pnl.unrealized;
    return {
      ...this.portfolio,
      invested,
      totalValue,
      openPositions: openPositions.length,
      closedPositions: Object.values(this.portfolio.positions).filter(p => p.status === 'closed').length,
      totalTrades: this.portfolio.trades.length
    };
  }

  async generateReport() {
    const portfolio = this.getPortfolio();
    const trades = portfolio.trades;
    const closedTrades = trades.filter(t => t.realizedPnl != null);
    
    const winningTrades = closedTrades.filter(t => t.realizedPnl > 0);
    const losingTrades = closedTrades.filter(t => t.realizedPnl < 0);
    
    const winRate = closedTrades.length > 0
      ? (winningTrades.length / closedTrades.length * 100).toFixed(1)
      : '0.0';
    const avgWin = winningTrades.length > 0 ? winningTrades.reduce((sum, t) => sum + t.realizedPnl, 0) / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? losingTrades.reduce((sum, t) => sum + t.realizedPnl, 0) / losingTrades.length : 0;
    const profitFactor = Math.abs(avgLoss) > 0 ? (avgWin * winningTrades.length) / (Math.abs(avgLoss) * losingTrades.length) : 0;

    const totalReturn = ((portfolio.totalValue - 10000) / 10000 * 100).toFixed(2);

    return {
      mode: this.mode,
      generatedAt: new Date().toISOString(),
      portfolio: {
        cash: portfolio.cash,
        initialCash: 10000,
        totalValue: portfolio.totalValue,
        invested: portfolio.invested,
        totalReturn: totalReturn + '%',
        openPositions: portfolio.openPositions,
        closedPositions: portfolio.closedPositions
      },
      pnl: portfolio.pnl,
      performance: {
        totalTrades: trades.length,
        closedTrades: closedTrades.length,
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
