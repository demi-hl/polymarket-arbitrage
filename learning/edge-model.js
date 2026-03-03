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
const { FEATURE_NAMES } = require('./feature-engine');

const MIN_TRAINING_SAMPLES = 20;
const LEARNING_RATE = 0.01;
const REGULARIZATION = 0.001;

// Threshold candidates for strategy-specific optimization
const THRESHOLD_CANDIDATES = [0.02, 0.05, 0.08, 0.10, 0.15, 0.20];
const THRESHOLD_MIN_TRADES = 10;
const THRESHOLD_RECALC_INTERVAL = 100;

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

    // Strategy-specific optimal thresholds cache
    this._optimalThresholds = new Map();
    this._thresholdTradeCount = new Map(); // tracks trade count at last recalc

    // Market-type performance stats
    this._marketTypeStats = new Map();
  }

  async init() {
    if (this.store) {
      const trades = this.store.getClosedTrades();
      if (trades.length >= MIN_TRAINING_SAMPLES) {
        this._trainBatch(trades);
      }
      // Rebuild market-type stats from historical trades
      this._rebuildMarketTypeStats(trades);
    }
    this._updateStrategyMultipliers();
    return this;
  }

  /**
   * Estimate profitability probability for an opportunity.
   * Returns { probability, adjustedEdge, confidence, source, marketType }.
   */
  estimate(opportunity) {
    const features = this.featureEngine.computeFeatures(opportunity);
    const vector = this.featureEngine.toVector(features);

    // Market type multiplier based on historical performance by category
    const marketType = this.featureEngine.getMarketType(opportunity.question);
    const marketTypeMultiplier = this.getMarketTypeMultiplier(marketType);

    if (this.modelReady && this.weights) {
      const logit = this._dotProduct(this.weights, vector) + this.bias;
      const probability = this._sigmoid(logit);
      const confidence = Math.min(this.trainingSamples / 200, 1);

      const rawEdge = opportunity.executableEdge ?? opportunity.edgePercent ?? 0;
      const adjustedEdge = rawEdge * probability * (1 + features.whaleConsensus * 0.5) * marketTypeMultiplier;

      return {
        probability,
        adjustedEdge,
        confidence,
        source: 'ml',
        features,
        marketType,
        marketTypeMultiplier,
      };
    }

    const result = this._ruleBased(opportunity, features);
    result.adjustedEdge *= marketTypeMultiplier;
    result.marketType = marketType;
    result.marketTypeMultiplier = marketTypeMultiplier;
    return result;
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
      question: trade.question,
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

    // Update market-type performance stats
    const marketType = this.featureEngine.getMarketType(trade.question);
    this._updateMarketTypeStats(marketType, trade);

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

  /**
   * Get the optimal edge threshold for a specific strategy.
   * Analyzes closed trades for that strategy across candidate thresholds,
   * computing avg PnL for trades with edge >= threshold.
   * Returns the threshold with best risk-adjusted return.
   * Results are cached and recalculated every THRESHOLD_RECALC_INTERVAL trades.
   */
  getOptimalThreshold(strategyName) {
    if (!this.store || !strategyName) return null;

    const trades = this.store.getClosedTrades();
    const stratTrades = trades.filter(t => t.strategy === strategyName && t.realizedPnl != null);

    // Not enough data — return null so caller falls back to default
    if (stratTrades.length < THRESHOLD_MIN_TRADES) return null;

    // Check if cache is still valid (recalculate every THRESHOLD_RECALC_INTERVAL trades)
    const lastCount = this._thresholdTradeCount.get(strategyName) || 0;
    if (this._optimalThresholds.has(strategyName) && stratTrades.length - lastCount < THRESHOLD_RECALC_INTERVAL) {
      return this._optimalThresholds.get(strategyName);
    }

    let bestThreshold = null;
    let bestScore = -Infinity;

    for (const threshold of THRESHOLD_CANDIDATES) {
      const qualifying = stratTrades.filter(t => {
        const edge = t.executableEdge ?? t.grossEdge ?? t.netEdge ?? 0;
        return edge >= threshold;
      });

      if (qualifying.length < 3) continue; // need minimum sample at each threshold

      const avgPnl = qualifying.reduce((sum, t) => sum + t.realizedPnl, 0) / qualifying.length;
      const pnlValues = qualifying.map(t => t.realizedPnl);
      const mean = avgPnl;
      const variance = pnlValues.reduce((s, p) => s + (p - mean) ** 2, 0) / pnlValues.length;
      const stdDev = Math.sqrt(variance) || 0.001; // avoid division by zero

      // Risk-adjusted score: Sharpe-like ratio (avgPnl / stdDev) weighted by sample count
      const sampleWeight = Math.min(qualifying.length / stratTrades.length, 1);
      const score = (avgPnl / stdDev) * sampleWeight;

      if (score > bestScore) {
        bestScore = score;
        bestThreshold = threshold;
      }
    }

    if (bestThreshold !== null) {
      this._optimalThresholds.set(strategyName, bestThreshold);
      this._thresholdTradeCount.set(strategyName, stratTrades.length);
    }

    return bestThreshold;
  }

  /**
   * Get a confidence multiplier for a market type based on historical performance.
   * win rate > 65%: 1.2x (boost)
   * win rate > 55%: 1.0x (neutral)
   * win rate > 45%: 0.8x (cautious)
   * else: 0.6x (defensive)
   */
  getMarketTypeMultiplier(type) {
    const stats = this._marketTypeStats.get(type);
    if (!stats || (stats.wins + stats.losses) < THRESHOLD_MIN_TRADES) return 1.0;

    const total = stats.wins + stats.losses;
    const winRate = stats.wins / total;

    if (winRate > 0.65) return 1.2;
    if (winRate > 0.55) return 1.0;
    if (winRate > 0.45) return 0.8;
    return 0.6;
  }

  /**
   * Update market-type stats with a single trade outcome.
   */
  _updateMarketTypeStats(marketType, trade) {
    if (!this._marketTypeStats.has(marketType)) {
      this._marketTypeStats.set(marketType, { wins: 0, losses: 0, totalPnl: 0, avgEdge: 0, _edgeSum: 0, _count: 0 });
    }
    const stats = this._marketTypeStats.get(marketType);
    const pnl = trade.realizedPnl ?? 0;

    if (pnl > 0) stats.wins++;
    else stats.losses++;
    stats.totalPnl += pnl;

    const edge = trade.executableEdge ?? trade.grossEdge ?? trade.netEdge ?? 0;
    stats._edgeSum += edge;
    stats._count++;
    stats.avgEdge = stats._edgeSum / stats._count;
  }

  /**
   * Rebuild market-type stats from a batch of historical trades.
   */
  _rebuildMarketTypeStats(trades) {
    this._marketTypeStats.clear();
    for (const trade of trades) {
      if (trade.realizedPnl == null) continue;
      const marketType = this.featureEngine.getMarketType(trade.question);
      this._updateMarketTypeStats(marketType, trade);
    }
  }

  // ── Feature Importance Analysis ──

  /**
   * Compute feature importance using two approaches:
   *
   * A. Weight-based (instant): |weight[i]| / sum(|weights|)
   *    Good for understanding raw model signal per feature.
   *
   * B. Permutation importance (data-driven, optional):
   *    Shuffle each feature across all samples, measure accuracy drop.
   *    Higher drop = more important. Only computed when permutation=true.
   *
   * @param {{ permutation?: boolean }} opts
   * @returns {{ weightBased: Array, permutationBased?: Array }}
   */
  getFeatureImportance(opts = {}) {
    const names = FEATURE_NAMES;
    const result = { weightBased: [], permutationBased: null };

    // ── A. Weight-based importance ──
    if (this.weights && this.weights.length > 0) {
      const absWeights = this.weights.map(w => Math.abs(w));
      const sumAbs = absWeights.reduce((s, v) => s + v, 0) || 1;

      const items = names.map((name, i) => ({
        index: i,
        feature: name,
        featureKey: this.featureEngine.featureNames[i],
        weight: parseFloat((this.weights[i] || 0).toFixed(6)),
        absWeight: parseFloat(absWeights[i].toFixed(6)),
        importance: parseFloat((absWeights[i] / sumAbs).toFixed(6)),
        direction: (this.weights[i] || 0) >= 0 ? 'positive' : 'negative',
      }));

      items.sort((a, b) => b.importance - a.importance);
      result.weightBased = items;
    }

    // ── B. Permutation importance (expensive) ──
    if (opts.permutation && this.store && this.weights) {
      result.permutationBased = this._computePermutationImportance();
    }

    return result;
  }

  /**
   * Permutation importance implementation.
   * For each feature, shuffle its values across all samples and measure
   * how much accuracy degrades compared to baseline.
   */
  _computePermutationImportance() {
    const trades = this.store.getClosedTrades();
    if (trades.length < MIN_TRAINING_SAMPLES) return null;

    // Build feature matrix + labels
    const X = [];
    const y = [];
    for (const trade of trades) {
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
      X.push(this.featureEngine.toVector(features));
      y.push((trade.realizedPnl ?? trade.expectedProfit ?? 0) > 0 ? 1 : 0);
    }

    // Compute baseline accuracy
    const baselineAcc = this._accuracy(X, y);

    // For each feature, shuffle and measure accuracy drop
    const names = FEATURE_NAMES;
    const dim = this.weights.length;
    const importances = [];

    for (let f = 0; f < dim; f++) {
      // Deep-copy feature column, then shuffle it
      const original = X.map(row => row[f]);
      const shuffled = [...original];
      // Fisher-Yates shuffle
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      // Replace feature f with shuffled values
      for (let r = 0; r < X.length; r++) {
        X[r][f] = shuffled[r];
      }

      const shuffledAcc = this._accuracy(X, y);
      const drop = baselineAcc - shuffledAcc;

      importances.push({
        index: f,
        feature: names[f] || `feature_${f}`,
        featureKey: this.featureEngine.featureNames[f],
        importanceDrop: parseFloat(drop.toFixed(6)),
        baselineAccuracy: parseFloat(baselineAcc.toFixed(6)),
        shuffledAccuracy: parseFloat(shuffledAcc.toFixed(6)),
      });

      // Restore original values
      for (let r = 0; r < X.length; r++) {
        X[r][f] = original[r];
      }
    }

    importances.sort((a, b) => b.importanceDrop - a.importanceDrop);
    return importances;
  }

  /**
   * Compute classification accuracy on a feature matrix.
   */
  _accuracy(X, y) {
    let correct = 0;
    for (let i = 0; i < X.length; i++) {
      const logit = this._dotProduct(this.weights, X[i]) + this.bias;
      const pred = this._sigmoid(logit) >= 0.5 ? 1 : 0;
      if (pred === y[i]) correct++;
    }
    return correct / X.length;
  }

  /**
   * Full feature analysis report:
   * - Weight-based importance ranking
   * - Feature statistics (mean, std, min, max) across training data
   * - Point-biserial correlation (feature vs binary outcome)
   * - Top 5 / Bottom 5 features
   */
  getFeatureReport() {
    const importance = this.getFeatureImportance();
    const names = FEATURE_NAMES;
    const dim = this.featureEngine.featureNames.length;

    // Compute feature statistics + correlations from closed trades
    const featureStats = new Array(dim).fill(null).map(() => ({
      sum: 0, sumSq: 0, min: Infinity, max: -Infinity, count: 0,
      // For point-biserial correlation
      sumPos: 0, sumNeg: 0, countPos: 0, countNeg: 0,
    }));

    const trades = this.store ? this.store.getClosedTrades() : [];

    for (const trade of trades) {
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
      const vec = this.featureEngine.toVector(features);
      const isWin = (trade.realizedPnl ?? trade.expectedProfit ?? 0) > 0;

      for (let i = 0; i < dim; i++) {
        const v = vec[i] || 0;
        const s = featureStats[i];
        s.sum += v;
        s.sumSq += v * v;
        s.min = Math.min(s.min, v);
        s.max = Math.max(s.max, v);
        s.count++;

        if (isWin) {
          s.sumPos += v;
          s.countPos++;
        } else {
          s.sumNeg += v;
          s.countNeg++;
        }
      }
    }

    // Build per-feature stats + point-biserial correlation
    const statistics = [];
    for (let i = 0; i < dim; i++) {
      const s = featureStats[i];
      const n = s.count || 1;
      const mean = s.sum / n;
      const variance = (s.sumSq / n) - (mean * mean);
      const std = Math.sqrt(Math.max(variance, 0));

      // Point-biserial correlation: r_pb = (M1 - M0) / s_n * sqrt(n1*n0 / n^2)
      let correlation = 0;
      if (s.countPos > 0 && s.countNeg > 0 && std > 0) {
        const meanPos = s.sumPos / s.countPos;
        const meanNeg = s.sumNeg / s.countNeg;
        const proportion = Math.sqrt((s.countPos * s.countNeg) / (n * n));
        correlation = ((meanPos - meanNeg) / std) * proportion;
        // Clamp to [-1, 1]
        correlation = Math.max(-1, Math.min(1, correlation));
      }

      statistics.push({
        index: i,
        feature: names[i] || `feature_${i}`,
        featureKey: this.featureEngine.featureNames[i],
        mean: parseFloat(mean.toFixed(6)),
        std: parseFloat(std.toFixed(6)),
        min: s.min === Infinity ? 0 : parseFloat(s.min.toFixed(6)),
        max: s.max === -Infinity ? 0 : parseFloat(s.max.toFixed(6)),
        samples: s.count,
        correlation: parseFloat(correlation.toFixed(6)),
      });
    }

    // Sort by absolute correlation for insight
    const statsByCorrelation = [...statistics].sort(
      (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)
    );

    // Top 5 / Bottom 5 from weight-based importance
    const top5 = importance.weightBased.slice(0, 5);
    const bottom5 = importance.weightBased.slice(-5).reverse();

    return {
      modelReady: this.modelReady,
      trainingSamples: this.trainingSamples,
      totalClosedTrades: trades.length,
      weightBasedImportance: importance.weightBased,
      statistics,
      statisticsByCorrelation: statsByCorrelation,
      top5Features: top5,
      bottom5Features: bottom5,
      summary: {
        mostImportant: top5.map(f => f.feature),
        leastImportant: bottom5.map(f => f.feature),
        strongestPositiveCorrelation: statsByCorrelation.filter(s => s.correlation > 0).slice(0, 3).map(s => ({
          feature: s.feature,
          correlation: s.correlation,
        })),
        strongestNegativeCorrelation: statsByCorrelation.filter(s => s.correlation < 0).slice(0, 3).map(s => ({
          feature: s.feature,
          correlation: s.correlation,
        })),
      },
    };
  }

  getReport() {
    // Serialize market-type stats for report
    const marketTypeStats = {};
    for (const [type, stats] of this._marketTypeStats) {
      const total = stats.wins + stats.losses;
      marketTypeStats[type] = {
        wins: stats.wins,
        losses: stats.losses,
        totalPnl: parseFloat(stats.totalPnl.toFixed(2)),
        avgEdge: parseFloat(stats.avgEdge.toFixed(4)),
        winRate: total > 0 ? parseFloat((stats.wins / total).toFixed(3)) : 0,
        multiplier: this.getMarketTypeMultiplier(type),
      };
    }

    return {
      modelReady: this.modelReady,
      trainingSamples: this.trainingSamples,
      source: this.modelReady ? 'ml' : 'rules',
      featureCount: this.featureEngine.featureNames.length,
      featureNames: this.featureEngine.featureNames,
      strategyMultipliers: Object.fromEntries(this._strategyMultipliers),
      optimalThresholds: Object.fromEntries(this._optimalThresholds),
      marketTypeStats,
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
