/**
 * Strategy Registry - Central hub for all trading strategies
 */

const EventEmitter = require('events');

class StrategyRegistry extends EventEmitter {
  constructor(bot, riskManager) {
    super();
    this.bot = bot;
    this.riskManager = riskManager;
    this.strategies = new Map();
    this.performance = new Map();
    this.weights = { edge: 0.4, confidence: 0.3, liquidity: 0.2, speed: 0.1 };
  }

  register(strategy) {
    if (!this.validateStrategy(strategy)) throw new Error('Invalid strategy: ' + strategy.name);
    this.strategies.set(strategy.name, strategy);
    this.performance.set(strategy.name, { 
      scans: 0, opportunities: 0, executed: 0, wins: 0, losses: 0, 
      pnl: 0, avgExecutionTime: 0, lastScan: null 
    });
    console.log('Registered:', strategy.name, '(' + strategy.riskLevel + ' risk)');
    return this;
  }

  validateStrategy(strategy) {
    const required = ['name', 'type', 'scan', 'validate', 'execute', 'riskLevel'];
    const missing = required.filter(key => !(key in strategy));
    if (missing.length > 0) { 
      console.error('Strategy', strategy.name || 'unknown', 'missing:', missing.join(', ')); 
      return false; 
    }
    if (!['low', 'medium', 'high'].includes(strategy.riskLevel)) { 
      console.error('Invalid riskLevel:', strategy.riskLevel); 
      return false; 
    }
    return true;
  }

  async scanAll(filters = {}) {
    const opportunities = [];
    const scanStart = Date.now();
    let strategiesToScan = Array.from(this.strategies.values());
    
    if (filters.type) strategiesToScan = strategiesToScan.filter(s => s.type === filters.type);
    if (filters.riskLevel) strategiesToScan = strategiesToScan.filter(s => s.riskLevel === filters.riskLevel);
    
    const scanResults = await Promise.allSettled(strategiesToScan.map(async (strategy) => {
      const perf = this.performance.get(strategy.name);
      perf.scans++;
      perf.lastScan = Date.now();
      try {
        const start = Date.now();
        const opps = await strategy.scan(this.bot);
        const duration = Date.now() - start;
        const enriched = opps.map(opp => ({ 
          ...opp, 
          strategy: strategy.name, 
          strategyType: strategy.type, 
          riskLevel: strategy.riskLevel, 
          scannedAt: Date.now(), 
          scanDuration: duration, 
          score: this.scoreOpportunity(opp, strategy) 
        }));
        perf.opportunities += enriched.length;
        return enriched;
      } catch (err) { 
        console.error(strategy.name, 'scan failed:', err.message); 
        return []; 
      }
    }));

    for (const result of scanResults) {
      if (result.status === 'fulfilled') opportunities.push(...result.value);
    }
    opportunities.sort((a, b) => b.score - a.score);
    return opportunities;
  }

  scoreOpportunity(opp, strategy) {
    const edge = opp.expectedReturn || opp.edge || 0;
    const confidence = opp.confidence || 0.5;
    const liquidity = Math.min((opp.liquidity || 0) / 100000, 1);
    const speed = opp.executionSpeed || 0.5;
    const riskMultipliers = { low: 1.0, medium: 0.85, high: 0.7 };
    const riskAdj = riskMultipliers[strategy.riskLevel] || 0.85;
    return (edge * this.weights.edge + confidence * this.weights.confidence * 100 + 
            liquidity * this.weights.liquidity * 100 + speed * this.weights.speed * 100) * riskAdj;
  }

  getPerformanceReport() {
    const report = { 
      summary: { totalStrategies: this.strategies.size, totalScans: 0, totalOpportunities: 0, totalExecuted: 0, totalPnl: 0 }, 
      strategies: {} 
    };
    for (const [name, perf] of this.performance) {
      report.summary.totalScans += perf.scans;
      report.summary.totalOpportunities += perf.opportunities;
      report.summary.totalExecuted += perf.executed;
      report.summary.totalPnl += perf.pnl;
      report.strategies[name] = { 
        ...perf, 
        winRate: perf.executed > 0 ? (perf.wins / perf.executed * 100).toFixed(1) + '%' : 'N/A', 
        avgPnl: perf.executed > 0 ? (perf.pnl / perf.executed).toFixed(2) : 'N/A' 
      };
    }
    return report;
  }
}

// All 24 strategies defined inline
const ALL_STRATEGIES = [
  // Fundamental strategies (low risk)
  { name: 'basic-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'cross-market-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'resolution-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'settlement-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'liquidity-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'funding-rate-arbitrage', type: 'fundamental', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  
  // Event-driven strategies (medium risk)
  { name: 'temporal-arbitrage', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'news-sentiment', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'event-impact', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'debate-arbitrage', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'polling-arbitrage', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'calendar-arbitrage', type: 'event', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  
  // Statistical strategies (medium-high risk)
  { name: 'correlation-arbitrage', type: 'statistical', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'cointegration-arbitrage', type: 'statistical', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'mean-reversion', type: 'statistical', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'volatility-arbitrage', type: 'statistical', riskLevel: 'high', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'momentum-arbitrage', type: 'statistical', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'pairs-trading', type: 'statistical', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  
  // Flow-based strategies (high risk)
  { name: 'whale-tracker', type: 'flow', riskLevel: 'high', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'orderbook-scalper', type: 'flow', riskLevel: 'high', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'flow-imbalance', type: 'flow', riskLevel: 'high', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'latency-arbitrage', type: 'flow', riskLevel: 'high', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  
  // Cross-platform strategies (varied risk)
  { name: 'kalshi-arbitrage', type: 'cross-platform', riskLevel: 'low', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) },
  { name: 'predictit-arbitrage', type: 'cross-platform', riskLevel: 'medium', scan: async () => [], validate: async () => true, execute: async () => ({ success: true }) }
];

module.exports = { StrategyRegistry, ALL_STRATEGIES };
