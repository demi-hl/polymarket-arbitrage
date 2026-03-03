/**
 * Strategy Registry - Central hub for all trading strategies
 */

const EventEmitter = require('events');

let _whaleTracker = null;
function setWhaleTracker(tracker) { _whaleTracker = tracker; }
function getWhaleTracker() { return _whaleTracker; }

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
    let failedStrategies = 0;
    let rateLimitHits = 0;
    let strategiesToScan = Array.from(this.strategies.values());
    
    if (filters.type) strategiesToScan = strategiesToScan.filter(s => s.type === filters.type);
    if (filters.riskLevel) strategiesToScan = strategiesToScan.filter(s => s.riskLevel === filters.riskLevel);
    if (Array.isArray(filters.strategyNames) && filters.strategyNames.length > 0) {
      const selected = new Set(filters.strategyNames);
      strategiesToScan = strategiesToScan.filter(s => selected.has(s.name));
    }
    
    const PER_STRATEGY_TIMEOUT = 45000;
    const BATCH_SIZE = 4;

    // Pre-warm the shared market cache before strategies run
    try {
      const { fetchMarketsOnce } = require('./lib/with-scanner');
      await fetchMarketsOnce();
    } catch {}


    const runStrategy = async (strategy) => {
      const perf = this.performance.get(strategy.name);
      perf.scans++;
      perf.lastScan = Date.now();
      try {
        const start = Date.now();
        const opps = await Promise.race([
          strategy.scan(this.bot),
          new Promise((_, rej) => setTimeout(() => rej(new Error(`${strategy.name} timed out (${PER_STRATEGY_TIMEOUT / 1000}s)`)), PER_STRATEGY_TIMEOUT)),
        ]);
        const duration = Date.now() - start;
        const enriched = (opps || []).map(opp => ({ 
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
        failedStrategies++;
        if ((err?.message || '').includes('429')) rateLimitHits++;
        console.error(strategy.name, 'scan failed:', err.message); 
        return []; 
      }
    };

    // Run strategies in batches to avoid overwhelming APIs
    for (let i = 0; i < strategiesToScan.length; i += BATCH_SIZE) {
      const batch = strategiesToScan.slice(i, i + BATCH_SIZE);
      const scanResults = await Promise.allSettled(batch.map(s => runStrategy(s)));
      for (const result of scanResults) {
        if (result.status === 'fulfilled') opportunities.push(...result.value);
      }
    }

    this.lastScanMeta = {
      scannedStrategies: strategiesToScan.length,
      failedStrategies,
      rateLimitHits,
    };
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

    let whaleMultiplier = 1.0;
    if (_whaleTracker && opp.conditionId) {
      whaleMultiplier = _whaleTracker.getConfidenceMultiplier(opp.conditionId);
    }

    const baseScore = (edge * this.weights.edge + confidence * this.weights.confidence * 100 + 
            liquidity * this.weights.liquidity * 100 + speed * this.weights.speed * 100) * riskAdj;

    return baseScore * whaleMultiplier;
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

const fundamental = require('./fundamental');
const flow = require('./flow');
const crossPlatform = require('./cross-platform');
const multiOutcome = require('./multi-outcome');
const { marketMakerStrategy } = require('./market-maker');
const correlated = require('./correlated');
const negRisk = require('./neg-risk');
const volumeSpike = require('./volume-spike');
const taMomentum = require('./ta-momentum');
const liquiditySniper = require('./liquidity-sniper');
const eventCatalyst = require('./event-catalyst');
const smartMoney = require('./smart-money');
const newsSentiment = require('./news-sentiment');
const resolutionFrontrun = require('./resolution-frontrun');
const cryptoLatencyArb = require('./crypto-latency-arb');
const systematicFactorSuite = require('./systematic-factor-suite');
const impliedVolSurface = require('./implied-vol-surface');
const { strategies: whaleFlow, setOrderflowWatcher } = require('./whale-flow');

const ALL_STRATEGIES = [].concat(
  resolutionFrontrun,
  multiOutcome,
  fundamental,
  crossPlatform,
  [marketMakerStrategy],
  flow,
  correlated,
  negRisk,
  volumeSpike,
  taMomentum,
  liquiditySniper,
  eventCatalyst,
  smartMoney,
  newsSentiment,
  cryptoLatencyArb,
  systematicFactorSuite,
  impliedVolSurface,
  whaleFlow,
);

const STRATEGY_COUNT = ALL_STRATEGIES.length;

module.exports = { StrategyRegistry, ALL_STRATEGIES, STRATEGY_COUNT, setWhaleTracker, setOrderflowWatcher };
