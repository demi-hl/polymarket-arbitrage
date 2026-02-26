/**
 * Combined Reporting Module
 * Generates comprehensive reports for multi-account trading
 */

const fs = require('fs').promises;
const path = require('path');

class CombinedReporting {
  constructor(options = {}) {
    this.dataDir = options.dataDir || path.join(__dirname, '../data/multi-account');
    this.exportFormats = ['json', 'csv'];
  }

  async init() {
    console.log('✅ Combined Reporting initialized');
    return this;
  }

  /**
   * Generate comprehensive report for both accounts
   * @param {object} manager - MultiAccountManager instance
   * @returns {object} Complete report
   */
  async generateReport(manager) {
    const aggressive = manager.getAccountSummary('aggressive');
    const conservative = manager.getAccountSummary('conservative');
    
    const report = {
      generatedAt: new Date().toISOString(),
      period: await this.getReportingPeriod(manager),
      summary: {
        combinedValue: aggressive.totalValue + conservative.totalValue,
        combinedReturn: ((aggressive.totalValue + conservative.totalValue - 20000) / 20000 * 100),
        totalTrades: aggressive.totalTrades + conservative.totalTrades,
        openPositions: aggressive.openPositions + conservative.openPositions
      },
      accounts: { aggressive, conservative },
      comparison: this.generateComparison(aggressive, conservative),
      performance: await this.calculatePerformanceMetrics(manager),
      strategies: this.analyzeStrategyPerformance(manager),
      risk: this.analyzeRiskMetrics(manager),
      recommendations: this.generateRecommendations(aggressive, conservative)
    };

    return report;
  }

  /**
   * Generate side-by-side comparison
   */
  generateComparison(aggressive, conservative) {
    return {
      metrics: [
        {
          metric: 'Total Return',
          aggressive: `${aggressive.totalReturn.toFixed(2)}%`,
          conservative: `${conservative.totalReturn.toFixed(2)}%`,
          winner: aggressive.totalReturn > conservative.totalReturn ? 'aggressive' : 
                  conservative.totalReturn > aggressive.totalReturn ? 'conservative' : 'tie',
          difference: (aggressive.totalReturn - conservative.totalReturn).toFixed(2) + '%'
        },
        {
          metric: 'Win Rate',
          aggressive: `${aggressive.winRate}%`,
          conservative: `${conservative.winRate}%`,
          winner: parseFloat(aggressive.winRate) > parseFloat(conservative.winRate) ? 'aggressive' : 
                  parseFloat(conservative.winRate) > parseFloat(aggressive.winRate) ? 'conservative' : 'tie',
          difference: (parseFloat(aggressive.winRate) - parseFloat(conservative.winRate)).toFixed(1) + '%'
        },
        {
          metric: 'Total Trades',
          aggressive: aggressive.totalTrades,
          conservative: conservative.totalTrades,
          winner: aggressive.totalTrades > conservative.totalTrades ? 'aggressive' : 
                  conservative.totalTrades > aggressive.totalTrades ? 'conservative' : 'tie',
          difference: Math.abs(aggressive.totalTrades - conservative.totalTrades)
        },
        {
          metric: 'Max Drawdown',
          aggressive: `${aggressive.maxDrawdown}%`,
          conservative: `${conservative.maxDrawdown}%`,
          winner: parseFloat(aggressive.maxDrawdown) < parseFloat(conservative.maxDrawdown) ? 'aggressive' : 
                  parseFloat(conservative.maxDrawdown) < parseFloat(aggressive.maxDrawdown) ? 'conservative' : 'tie',
          difference: (parseFloat(aggressive.maxDrawdown) - parseFloat(conservative.maxDrawdown)).toFixed(2) + '%'
        },
        {
          metric: 'Open Positions',
          aggressive: aggressive.openPositions,
          conservative: conservative.openPositions,
          winner: null,
          difference: Math.abs(aggressive.openPositions - conservative.openPositions)
        },
        {
          metric: 'Current Value',
          aggressive: `$${aggressive.totalValue.toFixed(2)}`,
          conservative: `$${conservative.totalValue.toFixed(2)}`,
          winner: aggressive.totalValue > conservative.totalValue ? 'aggressive' : 
                  conservative.totalValue > aggressive.totalValue ? 'conservative' : 'tie',
          difference: `$${Math.abs(aggressive.totalValue - conservative.totalValue).toFixed(2)}`
        }
      ],
      overallWinner: this.calculateOverallWinner(aggressive, conservative),
      keyInsights: this.generateInsights(aggressive, conservative)
    };
  }

  /**
   * Calculate overall winner based on multiple factors
   */
  calculateOverallWinner(aggressive, conservative) {
    let aggressiveScore = 0;
    let conservativeScore = 0;

    // Return comparison
    if (aggressive.totalReturn > conservative.totalReturn) aggressiveScore += 2;
    else if (conservative.totalReturn > aggressive.totalReturn) conservativeScore += 2;
    else { aggressiveScore += 1; conservativeScore += 1; }

    // Win rate comparison
    if (parseFloat(aggressive.winRate) > parseFloat(conservative.winRate)) aggressiveScore += 1;
    else if (parseFloat(conservative.winRate) > parseFloat(aggressive.winRate)) conservativeScore += 1;

    // Risk-adjusted (lower drawdown is better)
    if (parseFloat(aggressive.maxDrawdown) < parseFloat(conservative.maxDrawdown)) aggressiveScore += 1;
    else if (parseFloat(conservative.maxDrawdown) < parseFloat(aggressive.maxDrawdown)) conservativeScore += 1;

    if (aggressiveScore > conservativeScore) return { winner: 'aggressive', score: `${aggressiveScore}-${conservativeScore}` };
    if (conservativeScore > aggressiveScore) return { winner: 'conservative', score: `${conservativeScore}-${aggressiveScore}` };
    return { winner: 'tie', score: `${aggressiveScore}-${conservativeScore}` };
  }

  /**
   * Generate key insights
   */
  generateInsights(aggressive, conservative) {
    const insights = [];

    if (aggressive.totalReturn > conservative.totalReturn + 5) {
      insights.push('Aggressive strategy significantly outperforming on returns');
    } else if (conservative.totalReturn > aggressive.totalReturn + 5) {
      insights.push('Conservative strategy significantly outperforming on returns');
    }

    if (parseFloat(aggressive.maxDrawdown) > 15) {
      insights.push('Aggressive account approaching max drawdown limit');
    }

    if (aggressive.totalTrades > conservative.totalTrades * 3) {
      insights.push('Aggressive account trading at 3x+ frequency of conservative');
    }

    if (parseFloat(conservative.winRate) > 60) {
      insights.push('Conservative strategy showing strong win rate discipline');
    }

    return insights;
  }

  /**
   * Calculate detailed performance metrics
   */
  async calculatePerformanceMetrics(manager) {
    const accounts = ['aggressive', 'conservative'];
    const metrics = {};

    for (const accountId of accounts) {
      const account = manager.getAccount(accountId);
      if (!account) continue;

      const trades = account.portfolio.trades;
      const closedTrades = trades.filter(t => t.realizedPnl !== undefined);

      if (closedTrades.length === 0) {
        metrics[accountId] = { status: 'no_trades' };
        continue;
      }

      const wins = closedTrades.filter(t => t.realizedPnl > 0);
      const losses = closedTrades.filter(t => t.realizedPnl < 0);

      const avgWin = wins.length > 0 ? wins.reduce((sum, t) => sum + t.realizedPnl, 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? losses.reduce((sum, t) => sum + t.realizedPnl, 0) / losses.length : 0;
      
      metrics[accountId] = {
        totalTrades: trades.length,
        closedTrades: closedTrades.length,
        winningTrades: wins.length,
        losingTrades: losses.length,
        winRate: closedTrades.length > 0 ? (wins.length / closedTrades.length * 100).toFixed(1) : 0,
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        profitFactor: avgLoss !== 0 ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length)).toFixed(2) : 'N/A',
        largestWin: wins.length > 0 ? Math.max(...wins.map(t => t.realizedPnl)).toFixed(2) : 0,
        largestLoss: losses.length > 0 ? Math.min(...losses.map(t => t.realizedPnl)).toFixed(2) : 0,
        avgTradeSize: trades.length > 0 ? (trades.reduce((sum, t) => sum + (t.totalCost || 0), 0) / trades.length).toFixed(2) : 0,
        totalVolume: trades.reduce((sum, t) => sum + (t.totalCost || 0), 0).toFixed(2)
      };
    }

    return metrics;
  }

  /**
   * Analyze strategy performance across both accounts
   */
  analyzeStrategyPerformance(manager) {
    const accounts = manager.getAllAccounts();
    const allStrategies = {};

    accounts.forEach(account => {
      const accountId = account.id;
      
      for (const [strategy, stats] of Object.entries(account.strategyPerformance || {})) {
        if (!allStrategies[strategy]) {
          allStrategies[strategy] = {
            name: strategy,
            accounts: {},
            totalTrades: 0,
            totalWins: 0,
            totalPnl: 0
          };
        }

        allStrategies[strategy].accounts[accountId] = stats;
        allStrategies[strategy].totalTrades += stats.trades;
        allStrategies[strategy].totalWins += stats.wins;
        allStrategies[strategy].totalPnl += stats.pnl;
      }
    });

    // Calculate aggregate stats
    for (const strategy of Object.values(allStrategies)) {
      strategy.overallWinRate = strategy.totalTrades > 0 ? 
        (strategy.totalWins / strategy.totalTrades * 100).toFixed(1) : 0;
      strategy.avgPnl = strategy.totalTrades > 0 ? 
        (strategy.totalPnl / strategy.totalTrades).toFixed(2) : 0;
    }

    return {
      strategies: Object.values(allStrategies),
      bestStrategy: this.findBestStrategy(allStrategies),
      worstStrategy: this.findWorstStrategy(allStrategies)
    };
  }

  findBestStrategy(strategies) {
    const sorted = Object.values(strategies).sort((a, b) => b.totalPnl - a.totalPnl);
    return sorted.length > 0 ? sorted[0] : null;
  }

  findWorstStrategy(strategies) {
    const sorted = Object.values(strategies).sort((a, b) => a.totalPnl - b.totalPnl);
    return sorted.length > 0 ? sorted[0] : null;
  }

  /**
   * Analyze risk metrics
   */
  analyzeRiskMetrics(manager) {
    const accounts = manager.getAllAccounts();
    const riskAnalysis = {};

    accounts.forEach(account => {
      const { id, metrics, portfolio } = account;
      const trades = portfolio.trades;
      
      riskAnalysis[id] = {
        maxDrawdown: metrics.maxDrawdown,
        currentDrawdown: this.calculateCurrentDrawdown(account),
        dailyLossUtilization: this.calculateDailyLossUtilization(account),
        positionConcentration: this.calculatePositionConcentration(account),
        var95: this.calculateVaR(trades, 0.95),
        riskRating: this.calculateRiskRating(account)
      };
    });

    return riskAnalysis;
  }

  calculateCurrentDrawdown(account) {
    const { metrics, portfolio } = account;
    const currentValue = portfolio.cash + account.metrics.totalPnl;
    if (metrics.peakBalance <= 0) return 0;
    return ((metrics.peakBalance - currentValue) / metrics.peakBalance * 100).toFixed(2);
  }

  calculateDailyLossUtilization(account) {
    const { portfolio, config } = account;
    const dailyLoss = Math.abs(portfolio.dailyStats.losses || 0);
    const limit = config.dailyLossLimit;
    return ((dailyLoss / limit) * 100).toFixed(1);
  }

  calculatePositionConcentration(account) {
    const { portfolio } = account;
    const openPositions = Object.values(portfolio.positions).filter(p => p.status === 'open');
    if (openPositions.length === 0) return 0;
    
    const totalValue = portfolio.cash + openPositions.reduce((sum, p) => sum + p.entryCost, 0);
    const largestPosition = Math.max(...openPositions.map(p => p.entryCost));
    return ((largestPosition / totalValue) * 100).toFixed(1);
  }

  calculateVaR(trades, confidence) {
    if (trades.length < 10) return 'N/A';
    
    const returns = trades.map(t => t.realizedPnl || 0).sort((a, b) => a - b);
    const index = Math.floor((1 - confidence) * returns.length);
    return Math.abs(returns[index]).toFixed(2);
  }

  calculateRiskRating(account) {
    const drawdown = parseFloat(account.metrics.maxDrawdown) || 0;
    if (drawdown < 5) return 'Low';
    if (drawdown < 10) return 'Moderate';
    if (drawdown < 15) return 'High';
    return 'Critical';
  }

  /**
   * Generate trading recommendations
   */
  generateRecommendations(aggressive, conservative) {
    const recommendations = [];

    if (aggressive.totalReturn > conservative.totalReturn + 10) {
      recommendations.push({
        type: 'rebalance',
        action: 'Consider shifting capital to aggressive strategy',
        confidence: 'medium'
      });
    }

    if (parseFloat(aggressive.maxDrawdown) > 12) {
      recommendations.push({
        type: 'risk_management',
        action: 'Reduce position sizes in aggressive account',
        confidence: 'high'
      });
    }

    if (conservative.totalTrades < 5 && conservative.totalReturn < 0) {
      recommendations.push({
        type: 'activity',
        action: 'Conservative account under-trading, may need lower edge threshold',
        confidence: 'medium'
      });
    }

    return recommendations;
  }

  /**
   * Get reporting period from first trade to now
   */
  async getReportingPeriod(manager) {
    const accounts = manager.getAllAccounts();
    let earliest = Date.now();
    let latest = 0;

    accounts.forEach(account => {
      const trades = account.portfolio.trades;
      if (trades.length > 0) {
        const first = new Date(trades[0].timestamp).getTime();
        const last = new Date(trades[trades.length - 1].timestamp).getTime();
        earliest = Math.min(earliest, first);
        latest = Math.max(latest, last);
      }
    });

    return {
      start: earliest === Date.now() ? null : new Date(earliest).toISOString(),
      end: latest === 0 ? new Date().toISOString() : new Date(latest).toISOString(),
      days: earliest === Date.now() ? 0 : Math.ceil((latest - earliest) / (1000 * 60 * 60 * 24))
    };
  }

  /**
   * Export report to specified format
   */
  async exportReport(report, format = 'json') {
    const timestamp = new Date().toISOString().split('T')[0];
    const filename = `multi-account-report-${timestamp}.${format}`;
    const filepath = path.join(this.dataDir, filename);

    if (format === 'json') {
      await fs.writeFile(filepath, JSON.stringify(report, null, 2));
    } else if (format === 'csv') {
      const csv = this.convertToCSV(report);
      await fs.writeFile(filepath, csv);
    }

    return { filepath, format };
  }

  /**
   * Convert report to CSV format
   */
  convertToCSV(report) {
    const rows = [];
    
    // Header
    rows.push('Metric,Aggressive,Conservative,Difference,Winner');
    
    // Comparison metrics
    report.comparison.metrics.forEach(m => {
      rows.push(`${m.metric},${m.aggressive},${m.conservative},${m.difference},${m.winner || 'N/A'}`);
    });
    
    rows.push('');
    rows.push(`Overall Winner,${report.comparison.overallWinner.winner},,,Score: ${report.comparison.overallWinner.score}`);
    
    rows.push('');
    rows.push('Key Insights');
    report.comparison.keyInsights.forEach(insight => {
      rows.push(insight);
    });

    return rows.join('\n');
  }
}

module.exports = CombinedReporting;
