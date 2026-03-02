/**
 * Adaptive Edge Model
 * Estimates true profitability of an opportunity using logistic regression
 * trained on historical trade outcomes. Replaces fixed edge thresholds.
 *
 * The model learns:
 *   P(profitable | features) = sigmoid(w . x + b)
 *
 * Training uses online gradient descent so the model improves with each trade.
 * Falls back to a rule-based estimator when insufficient training data exists.
 */
const FeatureEngine = require('./feature-engine');

const MIN_TRAINING_SAMPLES = 20;
const LEARNING_RATE = 0.01;
const REGULARIZATION = 0.001;

class EdgeModel {
  constructor(dataStore, whaleTracker) {
    this.featureEngine = new FeatureEngine(dataStore, whaleTracker);
    this.store = dataStore;

    this.weights = null;
    this.bias = 0;
    this.trainingSamples = 0;
    this.modelReady = false;

    this._strategyMultipliers = new Map();
    this._riskFreeRate = 0.0001; // ~3.6% annualized daily
  }

  async init() {
    if (this.store) {
      const trades = this.store.getClosedTrades();
      if (trades.length >= MIN_TRAINING_SAMPLES) {
        this._trainBatch(trades);
      }
    }
    this._updateStrategyMultipliers();
    return this;
  }

  /**
   * Estimate profitability probability for an opportunity.
   * Returns { probability, adjustedEdge, confidence, source }.
   */
  estimate(opportunity) {
    const features = this.featureEngine.computeFeatures(opportunity);
    const vector = this.featureEngine.toVector(features);

    if (this.modelReady && this.weights) {
      const logit = this._dotProduct(this.weights, vector) + this.bias;
      const probability = this._sigmoid(logit);
      const confidence = Math.min(this.trainingSamples / 200, 1);

      const rawEdge = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;
      const adjustedEdge = rawEdge * probability * (1 + features.whaleConsensus * 0.5);

      return {
        probability,
        adjustedEdge,
        confidence,
        source: 'ml',
        features,
      };
    }

    return this._ruleBased(opportunity, features);
  }

  /**
   * Rule-based fallback when ML model hasn't been trained yet.
   */
  _ruleBased(opportunity, features) {
    const rawEdge = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;
    let multiplier = 1.0;

    if (features.hasClobData) multiplier *= 1.1;
    if (features.urgency > 0.3) multiplier *= 1.15;
    if (features.logLiquidity > 4) multiplier *= 1.05;
    if (features.priceExtreme) multiplier *= 0.7;
    if (features.spread > 0.05) multiplier *= 0.8;
    if (features.whaleConsensus > 0.5) multiplier *= 1.3;

    const stratMult = this._strategyMultipliers.get(opportunity.strategy) || 1.0;
    multiplier *= stratMult;

    const adjustedEdge = rawEdge * multiplier;
    const probability = Math.min(0.5 + adjustedEdge * 5, 0.95);

    return {
      probability,
      adjustedEdge,
      confidence: 0.3,
      source: 'rules',
      features,
    };
  }

  /**
   * Train the model on a batch of closed trades.
   */
  _trainBatch(trades) {
    const dim = this.featureEngine.featureNames.length;
    if (!this.weights) {
      this.weights = new Array(dim).fill(0);
      this.bias = 0;
    }

    for (const trade of trades) {
      const label = (trade.realizedPnl ?? trade.expectedProfit ?? 0) > 0 ? 1 : 0;

      const opp = {
        marketId: trade.marketId,
        edgePercent: trade.grossEdge || trade.netEdge || 0,
        executableEdge: trade.executableEdge || trade.grossEdge || 0,
        pricingSource: trade.pricingSource || 'gamma',
        liquidity: 10000,
        volume: 10000,
        yesPrice: trade.yesPrice || 0.5,
        noPrice: trade.noPrice || 0.5,
        strategy: trade.strategy,
        conditionId: trade.conditionId,
        direction: trade.direction,
        endDate: null,
        spread: trade.slippageCost || 0,
        clobYesDepth: 0,
        clobNoDepth: 0,
        category: trade.category,
      };

      const features = this.featureEngine.computeFeatures(opp);
      const x = this.featureEngine.toVector(features);
      this._gradientStep(x, label);
      this.trainingSamples++;
    }

    this.modelReady = this.trainingSamples >= MIN_TRAINING_SAMPLES;
  }

  /**
   * Online update: single gradient descent step (logistic regression).
   */
  _gradientStep(x, label) {
    const logit = this._dotProduct(this.weights, x) + this.bias;
    const pred = this._sigmoid(logit);
    const error = pred - label;

    for (let i = 0; i < this.weights.length; i++) {
      this.weights[i] -= LEARNING_RATE * (error * x[i] + REGULARIZATION * this.weights[i]);
    }
    this.bias -= LEARNING_RATE * error;
  }

  /**
   * Record a trade outcome and retrain incrementally.
   */
  recordOutcome(trade) {
    const label = (trade.realizedPnl ?? 0) > 0 ? 1 : 0;
    const dim = this.featureEngine.featureNames.length;
    if (!this.weights) {
      this.weights = new Array(dim).fill(0);
    }

    const opp = {
      marketId: trade.marketId,
      edgePercent: trade.grossEdge || trade.netEdge || 0,
      executableEdge: trade.executableEdge || 0,
      pricingSource: trade.pricingSource || 'gamma',
      liquidity: 10000,
      volume: 10000,
      yesPrice: trade.yesPrice || 0.5,
      noPrice: trade.noPrice || 0.5,
      strategy: trade.strategy,
      direction: trade.direction,
      endDate: null,
      spread: trade.slippageCost || 0,
      clobYesDepth: 0, clobNoDepth: 0,
      category: trade.category,
      conditionId: trade.conditionId,
    };

    const features = this.featureEngine.computeFeatures(opp);
    const x = this.featureEngine.toVector(features);
    this._gradientStep(x, label);
    this.trainingSamples++;
    this.modelReady = this.trainingSamples >= MIN_TRAINING_SAMPLES;

    this._updateStrategyMultipliers();
  }

  /**
   * Auto-promote/demote strategies based on historical win rates.
   */
  _updateStrategyMultipliers() {
    if (!this.store) return;
    const stats = this.store.getStrategyStats();

    for (const [name, s] of Object.entries(stats)) {
      if (s.total < 10) {
        this._strategyMultipliers.set(name, 1.0);
        continue;
      }

      if (s.winRate >= 0.65) {
        this._strategyMultipliers.set(name, 1.2);
      } else if (s.winRate >= 0.55) {
        this._strategyMultipliers.set(name, 1.0);
      } else if (s.winRate >= 0.45) {
        this._strategyMultipliers.set(name, 0.8);
      } else {
        this._strategyMultipliers.set(name, 0.5);
      }
    }
  }

  /**
   * Get optimal Kelly fraction for position sizing.
   */
  getKellyFraction(opportunity) {
    const est = this.estimate(opportunity);
    const p = est.probability;
    const b = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;

    if (b <= 0 || p <= 0) return 0;

    const odds = (1 + b) / 1;
    const kelly = (p * odds - (1 - p)) / odds;
    const halfKelly = Math.max(0, kelly * 0.5);

    return Math.min(halfKelly, 0.1);
  }

  getReport() {
    return {
      modelReady: this.modelReady,
      trainingSamples: this.trainingSamples,
      source: this.modelReady ? 'ml' : 'rules',
      featureCount: this.featureEngine.featureNames.length,
      featureNames: this.featureEngine.featureNames,
      strategyMultipliers: Object.fromEntries(this._strategyMultipliers),
      weights: this.weights ? this.weights.map(w => parseFloat(w.toFixed(6))) : null,
      bias: parseFloat((this.bias || 0).toFixed(6)),
    };
  }

  // ── Math helpers ──

  _sigmoid(x) {
    if (x >= 0) {
      const ex = Math.exp(-x);
      return 1 / (1 + ex);
    }
    const ex = Math.exp(x);
    return ex / (1 + ex);
  }

  _dotProduct(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      sum += (a[i] || 0) * (b[i] || 0);
    }
    return sum;
  }
}

module.exports = EdgeModel;
