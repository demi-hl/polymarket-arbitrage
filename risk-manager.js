/**
 * Risk Manager - Cross-Strategy Risk Limits
 * Production-grade risk controls for institutional deployment
 */

const EventEmitter = require('events');

class RiskManager extends EventEmitter {
  constructor(config = {}) {
    super();
    
    this.limits = {
      maxPositionSize: config.maxPositionSize || 5000,
      maxTotalExposure: config.maxTotalExposure || 25000,
      maxDailyLoss: config.maxDailyLoss || 1000,
      maxDrawdown: config.maxDrawdown || 0.10,
      maxConcentration: config.maxConcentration || 0.20,
      maxOpenPositions: config.maxOpenPositions || 10,
      minLiquidity: config.minLiquidity || 10000,
      cooldownPeriod: config.cooldownPeriod || 60000,
      maxDailyTrades: config.maxDailyTrades || 50,
      varLimit: config.varLimit || 0.05,
    };
    
    this.positions = new Map();
    this.dailyStats = { date: new Date().toDateString(), pnl: 0, trades: 0, wins: 0, losses: 0 };
    this.lastTradeTime = 0;
    this.peakPortfolioValue = config.initialPortfolioValue || 10000;
    this.currentPortfolioValue = config.initialPortfolioValue || 10000;
    this.tradeHistory = [];
    this.strategyLimits = new Map();
    this.circuitBreakers = { dailyLoss: false, drawdown: false, volatility: false };
  }

  setStrategyLimits(strategyName, limits) {
    this.strategyLimits.set(strategyName, {
      maxPositionSize: limits.maxPositionSize || this.limits.maxPositionSize,
      maxDailyTrades: limits.maxDailyTrades || 100,
      riskLevel: limits.riskLevel || 'medium',
      enabled: limits.enabled !== false,
      maxExposure: limits.maxExposure || this.limits.maxTotalExposure / 3,
    });
  }

  async validateTrade(opportunity, strategyName) {
    if (Object.values(this.circuitBreakers).some(v => v)) {
      return { allowed: false, reason: 'Circuit breaker active', riskScore: 1000 };
    }

    const checks = await Promise.all([
      this.checkDrawdown(), this.checkDailyLoss(), this.checkPositionSize(opportunity),
      this.checkConcentration(opportunity), this.checkLiquidity(opportunity),
      this.checkCooldown(), this.checkOpenPositions(), this.checkDailyTradeLimit(),
      this.checkVaR(opportunity), this.checkStrategyLimits(opportunity, strategyName),
    ]);

    const failedChecks = checks.filter(c => !c.passed);
    if (failedChecks.length > 0) {
      const criticalFailures = failedChecks.filter(c => c.severity === 'critical');
      if (criticalFailures.length > 0) this.triggerCircuitBreaker(criticalFailures[0].reason);
      return { allowed: false, reason: failedChecks.map(c => c.reason).join('; '), riskScore: this.calculateRiskScore(failedChecks) };
    }

    return { allowed: true, riskScore: 0, maxSize: this.getMaxPositionSize(opportunity) };
  }

  async checkDrawdown() {
    if (this.currentPortfolioValue <= 0) return { passed: true };
    const drawdown = (this.peakPortfolioValue - this.currentPortfolioValue) / this.peakPortfolioValue;
    if (drawdown >= this.limits.maxDrawdown) {
      this.circuitBreakers.drawdown = true;
      return { passed: false, reason: 'Drawdown limit exceeded: ' + (drawdown * 100).toFixed(2) + '%', severity: 'critical' };
    }
    return { passed: true };
  }

  async checkDailyLoss() {
    this.resetDailyStatsIfNeeded();
    if (this.dailyStats.pnl <= -this.limits.maxDailyLoss) {
      this.circuitBreakers.dailyLoss = true;
      return { passed: false, reason: 'Daily loss limit reached: $' + Math.abs(this.dailyStats.pnl).toFixed(2), severity: 'critical' };
    }
    return { passed: true };
  }

  async checkPositionSize(opportunity) {
    const size = opportunity.size || opportunity.investment || 0;
    if (size > this.limits.maxPositionSize) return { passed: false, reason: 'Position size exceeds limit', severity: 'medium' };
    return { passed: true };
  }

  async checkConcentration(opportunity) {
    const marketId = opportunity.market?.id || opportunity.marketId;
    if (!marketId) return { passed: true };
    const currentExposure = Array.from(this.positions.values()).filter(p => p.marketId === marketId).reduce((sum, p) => sum + p.size, 0);
    const newExposure = currentExposure + (opportunity.size || 0);
    const concentration = this.currentPortfolioValue > 0 ? newExposure / this.currentPortfolioValue : 0;
    if (concentration > this.limits.maxConcentration) return { passed: false, reason: 'Concentration exceeds limit', severity: 'medium' };
    return { passed: true };
  }

  async checkLiquidity(opportunity) {
    const liquidity = opportunity.market?.liquidity || opportunity.liquidity || 0;
    if (liquidity < this.limits.minLiquidity) return { passed: false, reason: 'Insufficient liquidity', severity: 'medium' };
    const size = opportunity.size || opportunity.investment || 0;
    if (size / liquidity > 0.05) return { passed: false, reason: 'Position too large for liquidity', severity: 'medium' };
    return { passed: true };
  }

  async checkCooldown() {
    const timeSinceLastTrade = Date.now() - this.lastTradeTime;
    if (timeSinceLastTrade < this.limits.cooldownPeriod) return { passed: false, reason: 'Cooldown active', severity: 'low' };
    return { passed: true };
  }

  async checkOpenPositions() {
    if (this.positions.size >= this.limits.maxOpenPositions) return { passed: false, reason: 'Max positions reached', severity: 'medium' };
    return { passed: true };
  }

  async checkDailyTradeLimit() {
    this.resetDailyStatsIfNeeded();
    if (this.dailyStats.trades >= this.limits.maxDailyTrades) return { passed: false, reason: 'Daily trade limit reached', severity: 'medium' };
    return { passed: true };
  }

  async checkVaR(opportunity) {
    const volatility = opportunity.volatility || 0.2;
    const size = opportunity.size || opportunity.investment || 0;
    const var95 = size * volatility * 1.645;
    const varLimit = this.currentPortfolioValue * this.limits.varLimit;
    if (var95 > varLimit) return { passed: false, reason: 'VaR exceeds limit', severity: 'high' };
    return { passed: true };
  }

  async checkStrategyLimits(opportunity, strategyName) {
    const limits = this.strategyLimits.get(strategyName);
    if (!limits) return { passed: true };
    if (!limits.enabled) return { passed: false, reason: 'Strategy disabled', severity: 'high' };
    const size = opportunity.size || opportunity.investment || 0;
    if (size > limits.maxPositionSize) return { passed: false, reason: 'Strategy position limit exceeded', severity: 'medium' };
    const strategyExposure = this.getStrategyExposure(strategyName);
    if (strategyExposure + size > limits.maxExposure) return { passed: false, reason: 'Strategy exposure limit exceeded', severity: 'medium' };
    return { passed: true };
  }

  calculateRiskScore(failedChecks) {
    const weights = { critical: 100, high: 50, medium: 25, low: 10 };
    return failedChecks.reduce((score, check) => score + (weights[check.severity] || 10), 0);
  }

  getMaxPositionSize(opportunity) {
    const liquidity = opportunity.market?.liquidity || Infinity;
    const remaining = this.limits.maxTotalExposure - this.getTotalExposure();
    return Math.min(this.limits.maxPositionSize, liquidity * 0.05, remaining, this.currentPortfolioValue * 0.1);
  }

  getTotalExposure() { return Array.from(this.positions.values()).reduce((sum, p) => sum + p.size, 0); }
  getStrategyExposure(name) { return Array.from(this.positions.values()).filter(p => p.strategy === name).reduce((sum, p) => sum + p.size, 0); }

  recordPosition(position) {
    this.positions.set(position.id, { ...position, openedAt: Date.now() });
    this.lastTradeTime = Date.now();
    this.dailyStats.trades++;
    this.tradeHistory.push({ ...position, timestamp: Date.now() });
    this.emit('position:opened', position);
  }

  closePosition(positionId, exitPrice) {
    const position = this.positions.get(positionId);
    if (!position) return null;
    const pnl = (exitPrice - position.entryPrice) * position.size;
    this.dailyStats.pnl += pnl;
    pnl > 0 ? this.dailyStats.wins++ : this.dailyStats.losses++;
    this.positions.delete(positionId);
    this.currentPortfolioValue += pnl;
    if (this.currentPortfolioValue > this.peakPortfolioValue) this.peakPortfolioValue = this.currentPortfolioValue;
    this.emit('position:closed', { position, pnl });
    return { position, pnl };
  }

  resetDailyStatsIfNeeded() {
    if (new Date().toDateString() !== this.dailyStats.date) {
      this.dailyStats = { date: new Date().toDateString(), pnl: 0, trades: 0, wins: 0, losses: 0 };
      this.circuitBreakers.dailyLoss = false;
    }
  }

  triggerCircuitBreaker(reason) {
    console.error('🚨 CIRCUIT BREAKER:', reason);
    this.emit('circuitbreaker:triggered', { reason, timestamp: Date.now() });
  }

  resetCircuitBreakers() {
    this.circuitBreakers = { dailyLoss: false, drawdown: false, volatility: false };
    console.log('✅ Circuit breakers reset');
  }

  updatePortfolioValue(value) {
    this.currentPortfolioValue = value;
    if (value > this.peakPortfolioValue) this.peakPortfolioValue = value;
  }

  getRiskReport() {
    const exposure = this.getTotalExposure();
    const drawdown = this.peakPortfolioValue > 0 ? (this.peakPortfolioValue - this.currentPortfolioValue) / this.peakPortfolioValue : 0;
    return {
      portfolio: { value: this.currentPortfolioValue, peak: this.peakPortfolioValue, drawdown: (drawdown * 100).toFixed(2) + '%', exposure, cash: this.currentPortfolioValue - exposure },
      positions: { open: this.positions.size, max: this.limits.maxOpenPositions },
      daily: this.dailyStats,
      circuitBreakers: this.circuitBreakers,
      status: Object.values(this.circuitBreakers).some(v => v) ? 'HALTED' : 'ACTIVE',
    };
  }

  emergencyHalt(reason) {
    this.triggerCircuitBreaker(reason);
    for (const [name, limits] of this.strategyLimits) limits.enabled = false;
    return { halted: true, reason, positionsToClose: Array.from(this.positions.values()) };
  }
}

module.exports = RiskManager;
