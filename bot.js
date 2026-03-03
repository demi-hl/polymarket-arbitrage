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
    this.edgeThreshold = config.edgeThreshold || 0.10;
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

    /** @type {import('./learning/edge-model')|null} */
    this.edgeModel = config.edgeModel || null;

    this.slippageModel = {
      baseSlippage: 0.003,   // 30 bps — realistic for $50-100 orders on typical Polymarket books
      liquidityFactor: 0.5
    };

    this.fees = {
      polymarket: 0.005,     // 0.5% taker fee (50 bps) per Polymarket CLOB
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

  /**
   * Use real CLOB orderbook depth when available to simulate realistic fills.
   * Returns { fillPrice, slippage, partial, method } where method is 'clob' or 'model'.
   */
  simulateFill(tokenId, side, amount, liquidity) {
    const depth = this.clob.depthAtPrice(tokenId, side, amount);
    if (depth && depth.fillPrice != null && !depth.partial) {
      return { ...depth, method: 'clob' };
    }
    if (depth && depth.partial && depth.filled > amount * 0.5) {
      const modelSlip = this.calculateSlippage(amount - depth.filled, liquidity);
      const blendedSlippage = (depth.slippage || 0) * 0.7 + modelSlip * 0.3;
      return { fillPrice: depth.fillPrice, slippage: blendedSlippage, partial: false, method: 'clob-partial' };
    }
    const slippage = this.calculateSlippage(amount, liquidity);
    return { fillPrice: null, slippage, partial: false, method: 'model' };
  }

  calculateMaxPosition(liquidity) {
    return Math.min((liquidity || 0) * this.maxLiquidityPct, this.maxPositionSize);
  }

  estimateTotalCost(edgePercent, slippage) {
    return this.fees.polymarket + this.fees.polymarketSpread + slippage + (this.fees.gasCostPerTx * 2 / 100);
  }

  async simulateExecution(opportunity, size) {
    const timestamp = new Date().toISOString();
    const liquidityCap = this.calculateMaxPosition(opportunity.liquidity);

    const edge = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;
    const edgeMultiplier = Math.min(Math.max(edge / this.edgeThreshold, 0.5), 2.0);
    const dynamicSize = size * edgeMultiplier;

    const positionSize = Math.min(dynamicSize, opportunity.maxPosition, this.maxPositionSize, liquidityCap);

    if (positionSize < 10) {
      throw new Error(`Position too small ($${positionSize.toFixed(2)}) — min $10 to absorb friction`);
    }

    const dir = opportunity.direction || 'BUY_BOTH';
    const isDirectional = dir === 'BUY_YES' || dir === 'BUY_NO';
    const tokens = opportunity.clobTokenIds || [];

    let yesSize, noSize, yesSlippage, noSlippage;
    let fillMethod = 'model';

    if (isDirectional) {
      const tokenId = dir === 'BUY_YES' ? tokens[0] : tokens[1];
      const fill = tokenId
        ? this.simulateFill(tokenId, 'buy', positionSize, opportunity.liquidity)
        : { slippage: this.calculateSlippage(positionSize, opportunity.liquidity), method: 'model' };
      fillMethod = fill.method;

      if (dir === 'BUY_YES') {
        yesSize = positionSize;
        noSize = 0;
        yesSlippage = fill.slippage;
        noSlippage = 0;
      } else {
        yesSize = 0;
        noSize = positionSize;
        yesSlippage = 0;
        noSlippage = fill.slippage;
      }
    } else {
      const halfSize = positionSize / 2;
      const yesFill = tokens[0]
        ? this.simulateFill(tokens[0], 'buy', halfSize, opportunity.liquidity)
        : { slippage: this.calculateSlippage(halfSize, opportunity.liquidity), method: 'model' };
      const noFill = tokens[1]
        ? this.simulateFill(tokens[1], 'buy', halfSize, opportunity.liquidity)
        : { slippage: this.calculateSlippage(halfSize, opportunity.liquidity), method: 'model' };
      yesSlippage = yesFill.slippage;
      noSlippage = noFill.slippage;
      yesSize = halfSize;
      noSize = halfSize;
      fillMethod = yesFill.method === 'clob' || noFill.method === 'clob' ? 'clob' : 'model';
    }

    const avgSlippage = isDirectional
      ? (yesSlippage || noSlippage)
      : (yesSlippage + noSlippage) / 2;

    // Limit order improvement: thin books mean limits often don't fill at desired price
    const limitOrderDiscount = fillMethod === 'clob' ? 0.15 : 0.10;
    const effectiveSlippage = avgSlippage * (1 - limitOrderDiscount);

    const effectiveEdge = opportunity.executableEdge ?? opportunity.edgePercent;
    let totalCostPct = this.estimateTotalCost(effectiveEdge, effectiveSlippage);
    const netEdge = effectiveEdge - totalCostPct;

    if (netEdge <= 0) {
      throw new Error(`Edge ${(effectiveEdge * 100).toFixed(2)}% wiped by costs ${(totalCostPct * 100).toFixed(2)}%`);
    }

    const yesPrice = opportunity.yesPrice * (1 + yesSlippage * (1 - limitOrderDiscount));
    const noPrice = opportunity.noPrice * (1 + noSlippage * (1 - limitOrderDiscount));

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
      fillMethod,
      yesPrice, noPrice, yesShares, noShares, yesSize, noSize, totalCost,
      yesSlippage, noSlippage,
      grossEdge: opportunity.edgePercent,
      executableEdge: effectiveEdge,
      slippageCost: effectiveSlippage,
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
      holdUntilResolution: opportunity.holdUntilResolution || false,
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
    // Rust engine trades are already executed — just record them
    if (opportunity.rustEngine) {
      return this.recordRustEngineTrade(opportunity);
    }

    const size = options.size || opportunity.maxPosition;
    
    const threshold = this.edgeModel?.getOptimalThreshold(opportunity.strategy) || this.edgeThreshold;
    if (opportunity.edgePercent < threshold) {
      throw new Error(`Edge ${(opportunity.edgePercent * 100).toFixed(2)}% below threshold ${(threshold * 100).toFixed(2)}%`);
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

  async recordRustEngineTrade(opportunity) {
    if (!(opportunity.alreadyExecuted && opportunity.rustPnl != null)) {
      throw new Error('Rust signal not executed yet; skipping Node portfolio entry');
    }

    const timestamp = new Date().toISOString();
    const size = opportunity.maxPosition || 25;
    const yesPrice = opportunity.yesPrice || 0.5;
    const noPrice = opportunity.noPrice || 0.5;
    const isYes = opportunity.direction === 'BUY_YES';

    const trade = {
      id: `rust-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
      timestamp,
      marketId: opportunity.marketId,
      question: opportunity.question,
      strategy: 'crypto-latency-arb',
      mode: 'paper',
      direction: opportunity.direction,
      pricingSource: 'rust-engine',
      fillMethod: 'rust-engine',
      yesPrice, noPrice,
      yesShares: isYes ? size / yesPrice : 0,
      noShares: !isYes ? size / noPrice : 0,
      yesSize: isYes ? size : 0,
      noSize: !isYes ? size : 0,
      totalCost: size,
      yesSlippage: 0, noSlippage: 0,
      grossEdge: opportunity.edgePercent,
      executableEdge: opportunity.edgePercent,
      slippageCost: 0, spreadCost: 0,
      netEdge: opportunity.edgePercent,
      edgePercent: opportunity.edgePercent,
      expectedReturn: size * (1 + opportunity.edgePercent),
      expectedProfit: size * opportunity.edgePercent,
      status: 'filled', filledAt: timestamp,
    };

    trade.realizedPnl = opportunity.rustPnl;
    trade.closedAt = timestamp;
    trade.closeMethod = 'rust-instant';

    this.portfolio.trades.push(trade);
    this.updatePnL();
    await this.savePortfolio();
    this.emit('trade:executed', { trade, portfolio: this.portfolio });
    return trade;
  }

  async autoExecute(opportunities, options = {}) {
    const minEdge = options.minEdge || this.edgeThreshold;
    const maxTradesPerCycle = options.maxTradesPerCycle || 3;
    const executed = [], skipped = [], failed = [];

    // Position recycling: sort by edge * confidence to allocate capital to best opportunities first
    const ranked = [...opportunities].sort((a, b) => {
      const scoreA = (a.executableEdge || a.edgePercent || 0) * (a.confidence || 0.5);
      const scoreB = (b.executableEdge || b.edgePercent || 0) * (b.confidence || 0.5);
      return scoreB - scoreA;
    });

    // Calculate available capital budget for this cycle
    const openPositionCost = Object.values(this.portfolio.positions)
      .filter(p => p.status === 'open')
      .reduce((s, p) => s + (p.entryCost || 0), 0);
    const totalEquity = this.portfolio.cash + openPositionCost;
    const maxDeployPct = 0.5; // deploy at most 50% of equity
    const availableBudget = Math.max(0, totalEquity * maxDeployPct - openPositionCost);

    let budgetUsed = 0;

    for (const opp of ranked) {
      try {
        if (opp.rustEngine) {
          if (!(opp.alreadyExecuted && opp.rustPnl != null)) {
            skipped.push({ opportunity: opp, reason: 'Rust signal pending execution' });
            continue;
          }
          const trade = await this.execute(opp);
          executed.push(trade);
          const pnlTag = trade.realizedPnl != null ? ` PnL: $${trade.realizedPnl.toFixed(2)}` : '';
          console.log(`⚡ Rust: ${opp.question.substring(0, 50)}... | Div: ${(opp.edgePercent * 100).toFixed(3)}%${pnlTag}`);
          continue;
        }
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
        const oppSize = opp.maxPosition || 100;
        if (budgetUsed + oppSize > availableBudget) {
          skipped.push({ opportunity: opp, reason: 'Cycle capital budget exhausted' });
          continue;
        }

        const trade = await this.execute(opp);
        executed.push(trade);
        budgetUsed += trade.totalCost;
        console.log(`✅ Executed: ${opp.question.substring(0, 50)}... | Edge: ${(opp.edgePercent * 100).toFixed(2)}% | Fill: ${trade.fillMethod}`);
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

        // Use bestBid for conservative M2M (what you'd actually get selling)
        currentYes = yesBook?.bestBid
          ?? pos.currentYesPrice
          ?? pos.entryYesPrice ?? 0.5;
        currentNo = noBook?.bestBid
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
    const grossPayout = winningShares * 1;
    const exitFee = grossPayout * this.fees.polymarket; // 0.5% taker fee on exit
    const payout = grossPayout - exitFee;
    const realizedPnl = payout - position.entryCost;

    position.status = 'closed';
    position.closeTime = new Date().toISOString();
    position.outcome = outcome;
    position.payout = payout;
    position.exitFee = exitFee;
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
    const TAKER_FEE = this.fees.polymarket; // 0.5%

    const yesExitPrice = currentYesPrice * (1 - SELL_SLIPPAGE);
    const noExitPrice = currentNoPrice * (1 - SELL_SLIPPAGE);
    const sellValue = (position.yesShares * yesExitPrice) + (position.noShares * noExitPrice);
    const exitFee = sellValue * TAKER_FEE;
    const payout = sellValue - GAS_COST - exitFee;
    const realizedPnl = payout - position.entryCost;

    position.status = 'closed';
    position.closeTime = new Date().toISOString();
    position.closeMethod = 'market';
    position.exitYesPrice = currentYesPrice;
    position.exitNoPrice = currentNoPrice;
    position.payout = payout;
    position.gasCost = GAS_COST;
    position.exitFee = exitFee;
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
