/**
 * Multi-Account Configuration
 * A/B Testing Setup for Strategy Comparison
 */

const MultiAccountConfig = {
  // Account A: "Aggressive" - High frequency, higher risk
  accountA: {
    id: 'aggressive',
    name: 'Aggressive Account',
    description: 'High-frequency trading with moderate edge requirements',
    virtualBalance: 10000,
    
    // Edge and Position Settings
    minEdge: 0.03,          // 3% minimum edge
    maxPosition: 500,       // $500 max per trade
    maxDailyTrades: 50,     // Hard limit
    targetTradesPerDay: 20, // Volume focus
    
    // Risk Management
    maxDrawdown: 0.15,      // Stop at 15% drawdown
    dailyLossLimit: 500,    // Stop after $500 loss
    positionSizing: 'volume', // Scale by edge strength
    
    // Strategy Assignment
    strategies: [
      'cross-market',       // Primary: Cross-exchange arbitrage
      'scalping',           // Micro-opportunities
      'whale-shadow',       // Follow large orders
      'resolution-arb'      // Resolution certainty plays
    ],
    
    // Volume Scaling Rules (position size based on edge)
    volumeScaling: {
      0.03: 100,   // 3% edge = $100 position
      0.05: 200,   // 5% edge = $200 position
      0.10: 400,   // 10% edge = $400 position
      0.15: 500    // 15%+ edge = $500 position (max)
    },
    
    // Execution Settings
    execution: {
      slippageModel: 'aggressive',
      fillProbability: 0.85,    // 85% of signals get filled
      latencyMs: 150,           // Faster execution
      partialFills: true
    }
  },

  // Account B: "Conservative" - Selective, lower risk
  accountB: {
    id: 'conservative',
    name: 'Conservative Account',
    description: 'Quality-focused trading with strict edge requirements',
    virtualBalance: 10000,
    
    // Edge and Position Settings
    minEdge: 0.08,          // 8% minimum edge
    maxPosition: 200,       // $200 max per trade
    maxDailyTrades: 15,     // Hard limit
    targetTradesPerDay: 8,  // Quality focus
    
    // Risk Management
    maxDrawdown: 0.10,      // Stop at 10% drawdown
    dailyLossLimit: 300,    // Stop after $300 loss
    positionSizing: 'volume', // Scale by edge strength
    
    // Strategy Assignment
    strategies: [
      'temporal-arb',       // Time-based mispricing
      'correlation-breakdown', // Statistical arbitrage
      'kelly-criterion',    // Optimal sizing
      'flash-scout'         // Quick opportunities
    ],
    
    // Volume Scaling Rules (more conservative)
    volumeScaling: {
      0.08: 100,   // 8% edge = $100 position
      0.10: 150,   // 10% edge = $150 position
      0.12: 200    // 12%+ edge = $200 position (max)
    },
    
    // Execution Settings
    execution: {
      slippageModel: 'conservative',
      fillProbability: 0.95,    // 95% of signals get filled (more selective)
      latencyMs: 300,           // More deliberate execution
      partialFills: false       // All or nothing
    }
  },

  // Global Settings
  global: {
    paperTrading: true,
    dataDir: './data/multi-account',
    priceSource: 'polymarket',
    updateIntervalMs: 30000,    // 30 second market scan
    
    // Comparison Settings
    comparison: {
      metrics: ['totalReturn', 'winRate', 'sharpeRatio', 'maxDrawdown', 'tradeCount', 'avgTradeSize'],
      rebalanceThreshold: 0.10,   // Reallocate if 10%+ performance gap
      autoOptimize: true
    },
    
    // Auto-Optimization
    optimizer: {
      enabled: true,
      evaluationWindow: 7,        // Days of data to evaluate
      minTradesForOptimization: 20, // Minimum trades before adjusting
      adjustmentStep: 0.005,      // 0.5% step size for edge adjustments
      maxAdjustment: 0.02,        // Max 2% adjustment per cycle
      
      // What to optimize
      optimizeEdge: true,
      optimizePositionSize: true,
      optimizeStrategies: true,
      
      // Strategy migration rules
      migrationRules: {
        minWinRateToPromote: 0.60,      // 60%+ win rate to add strategy
        maxWinRateToDemote: 0.40,       // Below 40% to remove strategy
        minTradesForMigration: 10       // Minimum trades before migration
      }
    },
    
    // Reporting
    reporting: {
      saveTradeHistory: true,
      exportFormats: ['json', 'csv'],
      dashboardUpdateInterval: 5000   // 5 seconds
    }
  },

  // Helper methods
  getAccountConfig(accountId) {
    return accountId === 'aggressive' ? this.accountA : this.accountB;
  },
  
  getAllAccounts() {
    return [this.accountA, this.accountB];
  },
  
  getVolumePositionSize(accountId, edgePercent) {
    const account = this.getAccountConfig(accountId);
    const scaling = account.volumeScaling;
    
    // Find the appropriate position size based on edge
    const thresholds = Object.keys(scaling).map(parseFloat).sort((a, b) => a - b);
    
    for (let i = thresholds.length - 1; i >= 0; i--) {
      if (edgePercent >= thresholds[i]) {
        return scaling[thresholds[i]];
      }
    }
    
    return 0; // Below minimum edge
  }
};

module.exports = MultiAccountConfig;
