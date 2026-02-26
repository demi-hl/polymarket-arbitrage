/**
 * Volume Trading Engine
 * Scales position sizes based on edge strength and account configuration
 */

const MultiAccountConfig = require('../config/multi-account');

class VolumeTradingEngine {
  constructor() {
    this.config = MultiAccountConfig;
    
    // Slippage models
    this.slippageModels = {
      aggressive: {
        baseSlippage: 0.001,
        liquidityFactor: 0.5,
        volatilityFactor: 0.2
      },
      conservative: {
        baseSlippage: 0.002,
        liquidityFactor: 0.3,
        volatilityFactor: 0.1
      }
    };
  }

  /**
   * Calculate position size based on edge strength
   * @param {string} accountId - 'aggressive' or 'conservative'
   * @param {object} opportunity - Arbitrage opportunity
   * @returns {number} Position size in USD
   */
  calculatePositionSize(accountId, opportunity) {
    const accountConfig = this.config.getAccountConfig(accountId);
    const edgePercent = opportunity.edgePercent;
    
    // Get base position size from volume scaling
    let positionSize = this.config.getVolumePositionSize(accountId, edgePercent);
    
    // Apply additional constraints
    positionSize = Math.min(positionSize, accountConfig.maxPosition);
    positionSize = Math.min(positionSize, opportunity.maxPosition || positionSize);
    
    // Liquidity adjustment - reduce size if liquidity is low
    if (opportunity.liquidity) {
      const liquidityRatio = positionSize / opportunity.liquidity;
      if (liquidityRatio > 0.1) {
        // Scale down if position is >10% of liquidity
        positionSize = opportunity.liquidity * 0.1;
      }
    }
    
    return Math.floor(positionSize);
  }

  /**
   * Calculate slippage for a trade
   * @param {string} accountId - Account identifier
   * @param {number} positionSize - Trade size
   * @param {number} liquidity - Market liquidity
   * @returns {object} Slippage for YES and NO sides
   */
  calculateSlippage(accountId, positionSize, liquidity) {
    const accountConfig = this.config.getAccountConfig(accountId);
    const model = this.slippageModels[accountConfig.execution.slippageModel];
    
    const sizeRatio = positionSize / (liquidity || positionSize * 10);
    const slippage = model.baseSlippage + (sizeRatio * model.liquidityFactor);
    
    return {
      yesSlippage: Math.min(slippage, 0.05),
      noSlippage: Math.min(slippage * 0.9, 0.05) // NO side typically has slightly less slippage
    };
  }

  /**
   * Simulate trade execution with realistic fills
   * @param {string} accountId - Account identifier
   * @param {object} opportunity - Arbitrage opportunity
   * @param {number} positionSize - Desired position size
   * @returns {object} Execution details
   */
  simulateExecution(accountId, opportunity, positionSize) {
    const accountConfig = this.config.getAccountConfig(accountId);
    const timestamp = new Date().toISOString();
    
    // Calculate slippage
    const slippage = this.calculateSlippage(accountId, positionSize, opportunity.liquidity);
    
    // Apply slippage to prices
    const yesPrice = opportunity.yesPrice * (1 + slippage.yesSlippage);
    const noPrice = opportunity.noPrice * (1 + slippage.noSlippage);
    
    // Split position between YES and NO
    const yesSize = positionSize / 2;
    const noSize = positionSize / 2;
    
    // Calculate shares
    const yesShares = yesSize / yesPrice;
    const noShares = noSize / noPrice;
    
    // Total cost
    const totalCost = yesSize + noSize;
    
    // Expected profit (guaranteed return minus cost)
    const guaranteedReturn = positionSize; // $1 per share total
    const expectedProfit = guaranteedReturn - totalCost;
    
    // Fill probability check
    const fillRoll = Math.random();
    const fillProbability = accountConfig.execution.fillProbability;
    
    if (fillRoll > fillProbability) {
      // Trade didn't fill
      return {
        filled: false,
        reason: 'No fill - market moved',
        timestamp
      };
    }
    
    // Partial fill simulation
    let filledSize = positionSize;
    if (accountConfig.execution.partialFills) {
      const partialRoll = Math.random();
      if (partialRoll < 0.1) {
        // 10% chance of partial fill
        filledSize = positionSize * (0.5 + Math.random() * 0.5);
      }
    }
    
    return {
      filled: true,
      timestamp,
      positionSize: filledSize,
      yesPrice,
      noPrice,
      yesShares,
      noShares,
      yesSize: filledSize / 2,
      noSize: filledSize / 2,
      totalCost: filledSize * (totalCost / positionSize),
      yesSlippage: slippage.yesSlippage,
      noSlippage: slippage.noSlippage,
      expectedProfit: expectedProfit * (filledSize / positionSize),
      fillQuality: filledSize / positionSize,
      latencyMs: accountConfig.execution.latencyMs + Math.floor(Math.random() * 100)
    };
  }

  /**
   * Calculate optimal position size using Kelly Criterion
   * @param {number} edgePercent - Expected edge
   * @param {number} winProbability - Probability of winning
   * @param {number} maxPosition - Maximum allowed position
   * @returns {number} Kelly-optimal position size
   */
  calculateKellySize(edgePercent, winProbability, maxPosition) {
    // Kelly fraction: f = (bp - q) / b
    // where b = odds, p = win probability, q = loss probability
    const b = edgePercent; // Simplified odds
    const p = winProbability;
    const q = 1 - p;
    
    const kellyFraction = (b * p - q) / b;
    
    // Use half-Kelly for safety
    const halfKelly = kellyFraction / 2;
    
    // Scale to position size (as fraction of portfolio)
    const positionFraction = Math.max(0, Math.min(halfKelly, 0.25)); // Max 25% of portfolio
    
    return Math.floor(positionFraction * maxPosition);
  }

  /**
   * Get volume scaling explanation for UI
   * @param {string} accountId - Account identifier
   * @returns {object} Scaling rules explanation
   */
  getScalingExplanation(accountId) {
    const accountConfig = this.config.getAccountConfig(accountId);
    const scaling = accountConfig.volumeScaling;
    
    const tiers = Object.entries(scaling)
      .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
      .map(([edge, size]) => ({
        edgePercent: parseFloat(edge) * 100,
        positionSize: size
      }));
    
    return {
      accountId,
      accountName: accountConfig.name,
      minEdge: accountConfig.minEdge * 100,
      maxPosition: accountConfig.maxPosition,
      tiers,
      description: this.getAccountDescription(accountId)
    };
  }

  getAccountDescription(accountId) {
    const descriptions = {
      aggressive: 'Higher risk, higher frequency. Scales from $100 (3% edge) to $500 (15%+ edge).',
      conservative: 'Lower risk, selective trades. Scales from $100 (8% edge) to $200 (12%+ edge).'
    };
    return descriptions[accountId] || '';
  }

  /**
   * Get trade statistics for an account
   * @param {array} trades - Array of trade objects
   * @returns {object} Trade statistics
   */
  calculateTradeStats(trades) {
    if (!trades || trades.length === 0) {
      return {
        totalTrades: 0,
        avgPositionSize: 0,
        avgEdge: 0,
        avgSlippage: 0,
        totalVolume: 0
      };
    }
    
    const totalVolume = trades.reduce((sum, t) => sum + (t.totalCost || 0), 0);
    const totalEdge = trades.reduce((sum, t) => sum + (t.edgePercent || 0), 0);
    const totalSlippage = trades.reduce((sum, t) => sum + ((t.yesSlippage || 0) + (t.noSlippage || 0)) / 2, 0);
    
    return {
      totalTrades: trades.length,
      avgPositionSize: totalVolume / trades.length,
      avgEdge: (totalEdge / trades.length) * 100,
      avgSlippage: (totalSlippage / trades.length) * 100,
      totalVolume
    };
  }
}

module.exports = VolumeTradingEngine;
