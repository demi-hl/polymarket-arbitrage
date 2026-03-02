/**
 * Advanced Risk Manager
 *
 * Layered risk controls:
 *   1. Kelly Criterion Sizing — optimal bet size based on estimated edge
 *   2. Correlation Limits — prevent overexposure to similar markets
 *   3. Max Drawdown Circuit Breaker — pause trading if equity drops too far
 *   4. Sector Concentration Limits — cap exposure per category
 *   5. Daily Loss Limit — stop opening new trades after daily losses hit cap
 *   6. Per-Strategy Performance Tracking — auto-pause losing strategies
 */

const MAX_KELLY_FRACTION = 0.15;
const MAX_PORTFOLIO_RISK_PCT = 0.60;
const MAX_SINGLE_POSITION_PCT = 0.03;
const MAX_SECTOR_PCT = 0.25;
const CIRCUIT_BREAKER_DRAWDOWN = 0.12;
const DAILY_LOSS_LIMIT_PCT = 0.05;
const MAX_CORRELATED_POSITIONS = 2;

const STRATEGY_PAUSE_THRESHOLD = 8;
const STRATEGY_PAUSE_WIN_RATE = 0.35;

class RiskManager {
  constructor(portfolio) {
    this.portfolio = portfolio;
    this.peakEquity = portfolio.cash || 10000;
    this.dailyPnl = 0;
    this.dailyReset = this._todayKey();
    this.paused = false;
    this.pauseReason = null;
    this.strategyStats = new Map();
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  _resetDailyIfNeeded() {
    const today = this._todayKey();
    if (today !== this.dailyReset) {
      this.dailyPnl = 0;
      this.dailyReset = today;
      if (this.pauseReason === 'daily-loss-limit') {
        this.paused = false;
        this.pauseReason = null;
      }
    }
  }

  update(portfolio) {
    this.portfolio = portfolio;
    this._resetDailyIfNeeded();

    const equity = portfolio.cash + (portfolio.pnl?.unrealized || 0) +
      Object.values(portfolio.positions || {})
        .filter(p => p.status === 'open')
        .reduce((s, p) => s + (p.entryCost || 0), 0);

    if (equity > this.peakEquity) this.peakEquity = equity;

    const drawdown = (this.peakEquity - equity) / this.peakEquity;
    if (drawdown >= CIRCUIT_BREAKER_DRAWDOWN) {
      this.paused = true;
      this.pauseReason = 'circuit-breaker';
    } else if (this.pauseReason === 'circuit-breaker') {
      this.paused = false;
      this.pauseReason = null;
    }
  }

  recordClosedTrade(pnl, strategy) {
    this._resetDailyIfNeeded();
    this.dailyPnl += pnl;
    if (this.dailyPnl <= -(this.peakEquity * DAILY_LOSS_LIMIT_PCT)) {
      this.paused = true;
      this.pauseReason = 'daily-loss-limit';
    }

    if (strategy) {
      if (!this.strategyStats.has(strategy)) {
        this.strategyStats.set(strategy, { wins: 0, losses: 0, totalPnl: 0 });
      }
      const stats = this.strategyStats.get(strategy);
      stats.totalPnl += pnl;
      if (pnl > 0) stats.wins++;
      else stats.losses++;
    }
  }

  isStrategyPaused(strategyName) {
    const stats = this.strategyStats.get(strategyName);
    if (!stats) return false;
    const total = stats.wins + stats.losses;
    if (total < STRATEGY_PAUSE_THRESHOLD) return false;
    const winRate = stats.wins / total;
    return winRate < STRATEGY_PAUSE_WIN_RATE;
  }

  /**
   * Kelly Criterion: f* = (bp - q) / b
   * where b = net odds (payout ratio), p = win probability, q = 1-p
   * Fractional Kelly for safety.
   */
  kellySize(edge, winProb, bankroll) {
    if (edge <= 0 || winProb <= 0 || winProb >= 1) return 0;
    const b = edge;
    const p = winProb;
    const q = 1 - p;
    const kelly = (b * p - q) / b;
    if (kelly <= 0) return 0;
    const fractional = kelly * MAX_KELLY_FRACTION;
    const maxSize = bankroll * MAX_SINGLE_POSITION_PCT;
    return Math.max(0, Math.min(fractional * bankroll, maxSize));
  }

  check(opportunity, requestedSize) {
    this._resetDailyIfNeeded();

    if (this.paused) {
      return { allowed: false, reason: `Trading paused: ${this.pauseReason}`, suggestedSize: 0 };
    }

    const stratName = opportunity.strategy;
    if (stratName && this.isStrategyPaused(stratName)) {
      return { allowed: false, reason: `Strategy ${stratName} auto-paused (low win rate)`, suggestedSize: 0 };
    }

    const positions = Object.values(this.portfolio.positions || {}).filter(p => p.status === 'open');
    const totalInvested = positions.reduce((s, p) => s + (p.entryCost || 0), 0);
    const equity = this.portfolio.cash + totalInvested + (this.portfolio.pnl?.unrealized || 0);

    if (totalInvested / equity > MAX_PORTFOLIO_RISK_PCT) {
      return { allowed: false, reason: `Portfolio risk limit (${(MAX_PORTFOLIO_RISK_PCT * 100)}% invested)`, suggestedSize: 0 };
    }

    const maxSingleSize = equity * MAX_SINGLE_POSITION_PCT;
    let size = Math.min(requestedSize, maxSingleSize);

    const category = (opportunity.category || opportunity.eventTitle || '').toLowerCase();
    if (category) {
      const sectorExposure = positions
        .filter(p => (p.question || '').toLowerCase().includes(category) || (p.strategy || '').includes(category))
        .reduce((s, p) => s + (p.entryCost || 0), 0);
      if (sectorExposure / equity > MAX_SECTOR_PCT) {
        return { allowed: false, reason: `Sector concentration limit (${category})`, suggestedSize: 0 };
      }
    }

    const similarPositions = positions.filter(p => {
      if (p.marketId === opportunity.marketId) return true;
      if (p.strategy === opportunity.strategy && p.strategy !== 'event-catalyst') return true;
      return false;
    });
    if (similarPositions.length >= MAX_CORRELATED_POSITIONS) {
      return { allowed: false, reason: `Correlated position limit (${similarPositions.length} similar)`, suggestedSize: 0 };
    }

    const edge = opportunity.executableEdge || opportunity.edgePercent || 0;
    const winProb = opportunity.confidence || 0.55;
    const kellyOptimal = this.kellySize(edge, winProb, equity);
    if (kellyOptimal > 0 && kellyOptimal < size) {
      size = kellyOptimal;
    }

    if (size < 5) {
      return { allowed: false, reason: 'Position too small after risk adjustments', suggestedSize: 0 };
    }

    return { allowed: true, reason: 'passed', suggestedSize: Math.round(size * 100) / 100 };
  }

  getStatus() {
    const pausedStrategies = [];
    for (const [name, stats] of this.strategyStats) {
      const total = stats.wins + stats.losses;
      if (total >= STRATEGY_PAUSE_THRESHOLD && stats.wins / total < STRATEGY_PAUSE_WIN_RATE) {
        pausedStrategies.push({ name, winRate: (stats.wins / total * 100).toFixed(1) + '%', trades: total });
      }
    }

    return {
      paused: this.paused,
      pauseReason: this.pauseReason,
      peakEquity: this.peakEquity,
      dailyPnl: this.dailyPnl,
      dailyLossLimit: -(this.peakEquity * DAILY_LOSS_LIMIT_PCT),
      circuitBreakerThreshold: CIRCUIT_BREAKER_DRAWDOWN,
      pausedStrategies,
      strategyStats: Object.fromEntries(this.strategyStats),
    };
  }
}

module.exports = RiskManager;
