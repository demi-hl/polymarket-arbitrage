/**
 * Auto-Optimizer Engine
 * Analyzes performance and automatically adjusts strategies and parameters
 */

const fs = require('fs').promises;
const path = require('path');
const MultiAccountConfig = require('../config/multi-account');

class AutoOptimizer {
  constructor(options = {}) {
    this.config = MultiAccountConfig;
    this.dataDir = options.dataDir || path.join(__dirname, '../data/multi-account');
    this.optimizerConfig = this.config.global.optimizer;
    
    // Optimization state
    this.optimizationHistory = [];
    this.recommendations = [];
  }

  async init() {
    await this.loadHistory();
    console.log('✅ Auto-Optimizer initialized');
    return this;
  }

  async loadHistory() {
    try {
      const historyPath = path.join(this.dataDir, 'optimization-history.json');
      const data = await fs.readFile(historyPath, 'utf8');
      this.optimizationHistory = JSON.parse(data);
    } catch (error) {
      this.optimizationHistory = [];
    }
  }

  async saveHistory() {
    try {
      const historyPath = path.join(this.dataDir, 'optimization-history.json');
      await fs.writeFile(historyPath, JSON.stringify(this.optimizationHistory, null, 2));
    } catch (error) {
      console.error('Failed to save optimization history:', error.message);
    }
  }

  /**
   * Analyze account performance and generate recommendations
   * @param {object} accountData - Account performance data
   * @returns {object} Analysis and recommendations
   */
  analyzePerformance(accountData) {
    const { accountId, trades, metrics } = accountData;
    const accountConfig = this.config.getAccountConfig(accountId);
    
    const recommendations = [];
    const analysis = {
      accountId,
      timestamp: new Date().toISOString(),
      tradeCount: trades.length,
      winRate: metrics.winRate,
      totalPnl: metrics.totalPnl,
      sharpeRatio: this.calculateSharpeRatio(trades),
      maxDrawdown: metrics.maxDrawdown
    };

    // Check if we have enough data
    if (trades.length < this.optimizerConfig.minTradesForOptimization) {
      analysis.status = 'insufficient_data';
      analysis.message = `Need ${this.optimizerConfig.minTradesForOptimization} trades, have ${trades.length}`;
      return { analysis, recommendations };
    }

    // Analyze edge threshold effectiveness
    const edgeAnalysis = this.analyzeEdgeEffectiveness(trades, accountConfig.minEdge);
    
    if (edgeAnalysis.optimalEdge !== accountConfig.minEdge) {
      const adjustment = edgeAnalysis.optimalEdge - accountConfig.minEdge;
      const clampedAdjustment = Math.max(
        -this.optimizerConfig.maxAdjustment,
        Math.min(this.optimizerConfig.maxAdjustment, adjustment)
      );
      
      if (Math.abs(clampedAdjustment) >= this.optimizerConfig.adjustmentStep) {
        recommendations.push({
          type: 'adjust_edge',
          parameter: 'minEdge',
          current: accountConfig.minEdge,
          recommended: accountConfig.minEdge + clampedAdjustment,
          reason: `Win rate ${(metrics.winRate * 100).toFixed(1)}% suggests ${clampedAdjustment > 0 ? 'raising' : 'lowering'} threshold`,
          confidence: edgeAnalysis.confidence
        });
      }
    }

    // Analyze position sizing
    const sizingAnalysis = this.analyzePositionSizing(trades, accountConfig);
    
    if (sizingAnalysis.recommendation) {
      recommendations.push(sizingAnalysis.recommendation);
    }

    // Analyze strategy performance
    const strategyAnalysis = this.analyzeStrategies(trades, accountConfig.strategies);
    
    strategyAnalysis.forEach(stratRec => {
      recommendations.push(stratRec);
    });

    // Risk management analysis
    const riskAnalysis = this.analyzeRiskManagement(trades, metrics);
    
    if (riskAnalysis.recommendation) {
      recommendations.push(riskAnalysis.recommendation);
    }

    analysis.status = recommendations.length > 0 ? 'recommendations_ready' : 'no_changes';
    
    return { analysis, recommendations };
  }

  /**
   * Analyze edge threshold effectiveness
   */
  analyzeEdgeEffectiveness(trades, currentEdge) {
    // Group trades by edge brackets
    const brackets = {
      low: { min: 0, max: 0.05, trades: [], pnl: 0 },
      medium: { min: 0.05, max: 0.10, trades: [], pnl: 0 },
      high: { min: 0.10, max: 1.0, trades: [], pnl: 0 }
    };

    trades.forEach(trade => {
      const edge = trade.edgePercent || 0;
      if (edge < brackets.low.max) {
        brackets.low.trades.push(trade);
        brackets.low.pnl += trade.realizedPnl || 0;
      } else if (edge < brackets.medium.max) {
        brackets.medium.trades.push(trade);
        brackets.medium.pnl += trade.realizedPnl || 0;
      } else {
        brackets.high.trades.push(trade);
        brackets.high.pnl += trade.realizedPnl || 0;
      }
    });

    // Find the most profitable bracket
    let bestBracket = null;
    let bestPnlPerTrade = -Infinity;

    for (const [name, bracket] of Object.entries(brackets)) {
      if (bracket.trades.length >= 5) {
        const pnlPerTrade = bracket.pnl / bracket.trades.length;
        if (pnlPerTrade > bestPnlPerTrade) {
          bestPnlPerTrade = pnlPerTrade;
          bestBracket = bracket;
        }
      }
    }

    if (!bestBracket) {
      return { optimalEdge: currentEdge, confidence: 0 };
    }

    // Suggest edge based on best performing bracket
    const suggestedEdge = bestBracket.min + (bestBracket.max - bestBracket.min) / 2;
    const confidence = Math.min(bestBracket.trades.length / 20, 1); // Max confidence at 20 trades

    return { optimalEdge: suggestedEdge, confidence };
  }

  /**
   * Analyze position sizing effectiveness
   */
  analyzePositionSizing(trades, accountConfig) {
    const wins = trades.filter(t => (t.realizedPnl || 0) > 0);
    const losses = trades.filter(t => (t.realizedPnl || 0) < 0);

    if (wins.length === 0 || losses.length === 0) {
      return { recommendation: null };
    }

    const avgWinSize = wins.reduce((sum, t) => sum + (t.positionSize || 0), 0) / wins.length;
    const avgLossSize = losses.reduce((sum, t) => sum + (t.positionSize || 0), 0) / losses.length;

    const winPnl = wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const lossPnl = losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);

    const profitFactor = Math.abs(lossPnl) > 0 ? Math.abs(winPnl / lossPnl) : 0;

    if (profitFactor < 1.2) {
      return {
        recommendation: {
          type: 'reduce_position_size',
          parameter: 'maxPosition',
          current: accountConfig.maxPosition,
          recommended: Math.floor(accountConfig.maxPosition * 0.8),
          reason: `Low profit factor (${profitFactor.toFixed(2)}), reduce risk exposure`,
          confidence: 0.7
        }
      };
    }

    if (profitFactor > 2.0 && avgWinSize < accountConfig.maxPosition * 0.8) {
      return {
        recommendation: {
          type: 'increase_position_size',
          parameter: 'maxPosition',
          current: accountConfig.maxPosition,
          recommended: Math.floor(accountConfig.maxPosition * 1.1),
          reason: `Strong profit factor (${profitFactor.toFixed(2)}), can increase size`,
          confidence: 0.6
        }
      };
    }

    return { recommendation: null };
  }

  /**
   * Analyze individual strategy performance
   */
  analyzeStrategies(trades, activeStrategies) {
    const recommendations = [];
    const strategyStats = {};

    // Calculate stats for each strategy
    trades.forEach(trade => {
      const strategy = trade.strategy || 'unknown';
      if (!strategyStats[strategy]) {
        strategyStats[strategy] = { trades: 0, wins: 0, pnl: 0 };
      }
      strategyStats[strategy].trades++;
      strategyStats[strategy].pnl += trade.realizedPnl || 0;
      if ((trade.realizedPnl || 0) > 0) {
        strategyStats[strategy].wins++;
      }
    });

    const migrationRules = this.optimizerConfig.migrationRules;

    // Check for strategies to promote
    for (const [strategy, stats] of Object.entries(strategyStats)) {
      if (stats.trades >= migrationRules.minTradesForMigration) {
        const winRate = stats.wins / stats.trades;
        
        if (winRate >= migrationRules.minWinRateToPromote && !activeStrategies.includes(strategy)) {
          recommendations.push({
            type: 'promote_strategy',
            strategy,
            currentWinRate: winRate,
            reason: `Win rate ${(winRate * 100).toFixed(1)}% exceeds threshold`,
            confidence: Math.min(stats.trades / 30, 0.9)
          });
        }
        
        if (winRate <= migrationRules.maxWinRateToDemote && activeStrategies.includes(strategy)) {
          recommendations.push({
            type: 'demote_strategy',
            strategy,
            currentWinRate: winRate,
            reason: `Win rate ${(winRate * 100).toFixed(1)}% below threshold`,
            confidence: Math.min(stats.trades / 30, 0.9)
          });
        }
      }
    }

    return recommendations;
  }

  /**
   * Analyze risk management effectiveness
   */
  analyzeRiskManagement(trades, metrics) {
    const maxDrawdown = metrics.maxDrawdown || 0;
    
    if (maxDrawdown > 0.15) {
      return {
        recommendation: {
          type: 'tighten_risk',
          parameter: 'dailyLossLimit',
          current: null,
          action: 'reduce_by_20_percent',
          reason: `High max drawdown ${(maxDrawdown * 100).toFixed(1)}%`,
          confidence: 0.8
        }
      };
    }

    return { recommendation: null };
  }

  /**
   * Calculate Sharpe ratio from trades
   */
  calculateSharpeRatio(trades) {
    if (trades.length < 2) return 0;
    
    const returns = trades.map(t => t.realizedPnl || 0);
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    if (avg === 0) return 0;
    
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev === 0 ? 0 : avg / stdDev;
  }

  /**
   * Compare both accounts and determine winner
   */
  compareAccounts(aggressiveData, conservativeData) {
    const comparison = {
      timestamp: new Date().toISOString(),
      accounts: {
        aggressive: aggressiveData,
        conservative: conservativeData
      },
      winner: null,
      metrics: {},
      recommendation: null
    };

    // Score each account across multiple dimensions
    const scoreAccount = (data) => {
      let score = 0;
      const weights = {
        totalReturn: 0.3,
        sharpeRatio: 0.25,
        winRate: 0.2,
        maxDrawdown: 0.25
      };

      // Total return (normalized to 0-1 scale, assuming max 50% return)
      score += Math.min((data.totalReturn || 0) / 50, 1) * weights.totalReturn;
      
      // Sharpe ratio (assuming max 3.0)
      score += Math.min((data.sharpeRatio || 0) / 3, 1) * weights.sharpeRatio;
      
      // Win rate
      score += ((data.winRate || 0) / 100) * weights.winRate;
      
      // Max drawdown (inverted, lower is better)
      score += (1 - Math.min((data.maxDrawdown || 0) / 0.5, 1)) * weights.maxDrawdown;

      return score;
    };

    const aggressiveScore = scoreAccount(aggressiveData);
    const conservativeScore = scoreAccount(conservativeData);

    comparison.metrics.aggressiveScore = aggressiveScore;
    comparison.metrics.conservativeScore = conservativeScore;
    comparison.metrics.performanceGap = Math.abs(aggressiveScore - conservativeScore);

    if (comparison.metrics.performanceGap < 0.1) {
      comparison.winner = 'tie';
      comparison.recommendation = 'Both strategies performing similarly';
    } else if (aggressiveScore > conservativeScore) {
      comparison.winner = 'aggressive';
      comparison.recommendation = 'Aggressive strategy outperforming - consider rebalancing';
    } else {
      comparison.winner = 'conservative';
      comparison.recommendation = 'Conservative strategy outperforming - quality over quantity';
    }

    return comparison;
  }

  /**
   * Apply optimization recommendations
   */
  async applyRecommendations(accountId, recommendations) {
    const applied = [];
    const rejected = [];

    for (const rec of recommendations) {
      // Only apply high confidence recommendations automatically
      if (rec.confidence >= 0.7) {
        // In a real implementation, this would update the config file
        applied.push({
          ...rec,
          appliedAt: new Date().toISOString()
        });
      } else {
        rejected.push({
          ...rec,
          reason: 'Low confidence, requires manual review'
        });
      }
    }

    // Record optimization
    this.optimizationHistory.push({
      timestamp: new Date().toISOString(),
      accountId,
      recommendations: recommendations.length,
      applied: applied.length,
      rejected: rejected.length
    });

    await this.saveHistory();

    return { applied, rejected };
  }

  /**
   * Generate optimization report
   */
  generateReport() {
    return {
      timestamp: new Date().toISOString(),
      totalOptimizations: this.optimizationHistory.length,
      history: this.optimizationHistory.slice(-10),
      recommendations: this.recommendations,
      config: this.optimizerConfig
    };
  }
}

module.exports = AutoOptimizer;
