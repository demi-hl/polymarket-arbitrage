/**
 * Auto-Optimizer Engine
 * Analyzes performance and automatically adjusts strategies and parameters.
 * Now ML-informed: uses the EdgeModel for probability-based recommendations
 * and the DataStore for historical analysis.
 */

const fs = require('fs').promises;
const path = require('path');
const MultiAccountConfig = require('../config/multi-account');

class AutoOptimizer {
  constructor(options = {}) {
    this.config = MultiAccountConfig;
    this.dataDir = options.dataDir || path.join(__dirname, '../data/multi-account');
    this.optimizerConfig = this.config.global.optimizer;
    
    this.optimizationHistory = [];
    this.recommendations = [];

    this.edgeModel = options.edgeModel || null;
    this.dataStore = options.dataStore || null;
  }

  async init() {
    await this.loadHistory();
    if (this.edgeModel) await this.edgeModel.init();
    console.log('Auto-Optimizer initialized' + (this.edgeModel ? ' (ML-enhanced)' : ''));
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
      await fs.mkdir(this.dataDir, { recursive: true });
      const historyPath = path.join(this.dataDir, 'optimization-history.json');
      await fs.writeFile(historyPath, JSON.stringify(this.optimizationHistory, null, 2));
    } catch (error) {
      console.error('Failed to save optimization history:', error.message);
    }
  }

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
      maxDrawdown: metrics.maxDrawdown,
      mlModelActive: !!this.edgeModel?.modelReady,
    };

    if (trades.length < this.optimizerConfig.minTradesForOptimization) {
      analysis.status = 'insufficient_data';
      analysis.message = `Need ${this.optimizerConfig.minTradesForOptimization} trades, have ${trades.length}`;
      return { analysis, recommendations };
    }

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

    const sizingAnalysis = this.analyzePositionSizing(trades, accountConfig);
    if (sizingAnalysis.recommendation) {
      recommendations.push(sizingAnalysis.recommendation);
    }

    const strategyAnalysis = this.analyzeStrategies(trades, accountConfig.strategies);
    strategyAnalysis.forEach(stratRec => recommendations.push(stratRec));

    const riskAnalysis = this.analyzeRiskManagement(trades, metrics);
    if (riskAnalysis.recommendation) {
      recommendations.push(riskAnalysis.recommendation);
    }

    if (this.edgeModel?.modelReady) {
      const mlRecs = this._mlRecommendations(trades);
      mlRecs.forEach(r => recommendations.push(r));
    }

    analysis.status = recommendations.length > 0 ? 'recommendations_ready' : 'no_changes';
    
    return { analysis, recommendations };
  }

  /**
   * ML-powered recommendations based on the edge model's learned weights.
   */
  _mlRecommendations(trades) {
    const recs = [];
    if (!this.edgeModel) return recs;

    const report = this.edgeModel.getReport();

    for (const [strategy, multiplier] of Object.entries(report.strategyMultipliers || {})) {
      if (multiplier <= 0.5) {
        recs.push({
          type: 'ml_demote_strategy',
          strategy,
          multiplier,
          reason: `ML model assigns ${multiplier}x multiplier — underperforming`,
          confidence: Math.min(report.trainingSamples / 100, 0.9),
        });
      } else if (multiplier >= 1.2) {
        recs.push({
          type: 'ml_promote_strategy',
          strategy,
          multiplier,
          reason: `ML model assigns ${multiplier}x multiplier — outperforming`,
          confidence: Math.min(report.trainingSamples / 100, 0.9),
        });
      }
    }

    if (report.weights) {
      const names = report.featureNames || [];
      const weights = report.weights;
      const sorted = names.map((n, i) => ({ name: n, weight: Math.abs(weights[i] || 0) }))
        .sort((a, b) => b.weight - a.weight);

      const topFeature = sorted[0];
      if (topFeature && topFeature.weight > 0.1) {
        recs.push({
          type: 'ml_insight',
          feature: topFeature.name,
          weight: topFeature.weight,
          reason: `'${topFeature.name}' is the strongest predictor of profitability`,
          confidence: 0.6,
        });
      }
    }

    return recs;
  }

  analyzeEdgeEffectiveness(trades, currentEdge) {
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

    const suggestedEdge = bestBracket.min + (bestBracket.max - bestBracket.min) / 2;
    const confidence = Math.min(bestBracket.trades.length / 20, 1);

    return { optimalEdge: suggestedEdge, confidence };
  }

  analyzePositionSizing(trades, accountConfig) {
    const wins = trades.filter(t => (t.realizedPnl || 0) > 0);
    const losses = trades.filter(t => (t.realizedPnl || 0) < 0);

    if (wins.length === 0 || losses.length === 0) {
      return { recommendation: null };
    }

    const winPnl = wins.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const lossPnl = losses.reduce((sum, t) => sum + (t.realizedPnl || 0), 0);
    const profitFactor = Math.abs(lossPnl) > 0 ? Math.abs(winPnl / lossPnl) : 0;

    if (this.edgeModel?.modelReady) {
      const avgKelly = wins.reduce((sum, t) => {
        const k = this.edgeModel.getKellyFraction({
          edgePercent: t.edgePercent || 0,
          executableEdge: t.executableEdge || t.edgePercent || 0,
          strategy: t.strategy,
        });
        return sum + k;
      }, 0) / wins.length;

      const kellySize = Math.floor(accountConfig.maxPosition * Math.min(avgKelly * 10, 1));
      if (Math.abs(kellySize - accountConfig.maxPosition) > accountConfig.maxPosition * 0.15) {
        return {
          recommendation: {
            type: 'ml_position_sizing',
            parameter: 'maxPosition',
            current: accountConfig.maxPosition,
            recommended: kellySize,
            reason: `Kelly criterion suggests ${kellySize} (profit factor: ${profitFactor.toFixed(2)})`,
            confidence: 0.65,
          }
        };
      }
    }

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

    if (profitFactor > 2.0) {
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

  analyzeStrategies(trades, activeStrategies) {
    const recommendations = [];
    const strategyStats = {};

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

  calculateSharpeRatio(trades) {
    if (trades.length < 2) return 0;
    
    const returns = trades.map(t => t.realizedPnl || 0);
    const avg = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    if (avg === 0) return 0;
    
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    
    return stdDev === 0 ? 0 : avg / stdDev;
  }

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

    const scoreAccount = (data) => {
      let score = 0;
      const weights = {
        totalReturn: 0.3,
        sharpeRatio: 0.25,
        winRate: 0.2,
        maxDrawdown: 0.25
      };

      score += Math.min((data.totalReturn || 0) / 50, 1) * weights.totalReturn;
      score += Math.min((data.sharpeRatio || 0) / 3, 1) * weights.sharpeRatio;
      score += ((data.winRate || 0) / 100) * weights.winRate;
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

  async applyRecommendations(accountId, recommendations) {
    const applied = [];
    const rejected = [];

    for (const rec of recommendations) {
      if (rec.confidence >= 0.7) {
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

  generateReport() {
    const report = {
      timestamp: new Date().toISOString(),
      totalOptimizations: this.optimizationHistory.length,
      history: this.optimizationHistory.slice(-10),
      recommendations: this.recommendations,
      config: this.optimizerConfig,
      mlStatus: this.edgeModel ? this.edgeModel.getReport() : { active: false },
    };
    return report;
  }
}

module.exports = AutoOptimizer;
