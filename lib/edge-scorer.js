/**
 * ML Edge Scorer
 *
 * Learns from past trade outcomes to score new opportunities.
 * Uses a simple logistic-regression-style model trained on features
 * extracted from each trade:
 *   - edge magnitude, liquidity, volume, time to expiry
 *   - strategy type, direction, market category
 *   - spread, depth imbalance (if available)
 *
 * The model updates weights after each closed trade using online
 * gradient descent. Scores are used to re-rank opportunities and
 * as a confidence multiplier for position sizing.
 *
 * No external dependencies — pure JS with JSON persistence.
 */
const fs = require('fs').promises;
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', 'data', 'edge-model.json');

const DEFAULT_WEIGHTS = {
  bias: 0,
  edge: 1.0,
  logLiquidity: 0.1,
  logVolume: 0.1,
  hoursToExpiry: -0.01,
  spreadCost: -2.0,
  isMultiOutcome: 0.3,
  isCrossPlatform: 0.5,
  isTA: 0.1,
  isArb: 0.2,
  confidence: 0.5,
};

const LEARNING_RATE = 0.01;

function sigmoid(x) {
  return 1 / (1 + Math.exp(-Math.max(-10, Math.min(10, x))));
}

function extractFeatures(opp) {
  const edge = opp.edgePercent || opp.edge || 0;
  const liq = opp.liquidity || 0;
  const vol = opp.volume || 0;
  const strat = opp.strategy || '';
  const hoursToExpiry = opp.endDate
    ? Math.max(0, (new Date(opp.endDate).getTime() - Date.now()) / 3600000)
    : 720;

  return {
    edge: edge * 100,
    logLiquidity: liq > 0 ? Math.log10(liq) : 0,
    logVolume: vol > 0 ? Math.log10(vol) : 0,
    hoursToExpiry: Math.min(hoursToExpiry, 720) / 720,
    spreadCost: opp.spreadCost || opp.slippageCost || 0,
    isMultiOutcome: strat.includes('multi-outcome') ? 1 : 0,
    isCrossPlatform: strat.includes('kalshi') || strat.includes('predictit') || strat.includes('three-way') ? 1 : 0,
    isTA: strat.includes('ta-') ? 1 : 0,
    isArb: strat.includes('arb') ? 1 : 0,
    confidence: opp.confidence || 0.5,
  };
}

function predict(weights, features) {
  let z = weights.bias || 0;
  for (const key of Object.keys(features)) {
    z += (weights[key] || 0) * features[key];
  }
  return sigmoid(z);
}

function updateWeights(weights, features, predicted, actual) {
  const error = actual - predicted;
  const updated = { ...weights };
  updated.bias = (updated.bias || 0) + LEARNING_RATE * error;
  for (const key of Object.keys(features)) {
    updated[key] = (updated[key] || 0) + LEARNING_RATE * error * features[key];
  }
  return updated;
}

class EdgeScorer {
  constructor() {
    this.weights = { ...DEFAULT_WEIGHTS };
    this.trainCount = 0;
    this._loaded = false;
  }

  async load() {
    if (this._loaded) return;
    try {
      const data = JSON.parse(await fs.readFile(MODEL_PATH, 'utf8'));
      this.weights = { ...DEFAULT_WEIGHTS, ...data.weights };
      this.trainCount = data.trainCount || 0;
    } catch {
      this.weights = { ...DEFAULT_WEIGHTS };
      this.trainCount = 0;
    }
    this._loaded = true;
  }

  async save() {
    try {
      await fs.writeFile(MODEL_PATH, JSON.stringify({
        weights: this.weights,
        trainCount: this.trainCount,
        updatedAt: new Date().toISOString(),
      }, null, 2));
    } catch {}
  }

  score(opportunity) {
    const features = extractFeatures(opportunity);
    return predict(this.weights, features);
  }

  async train(trade) {
    await this.load();
    const features = extractFeatures(trade);
    const predicted = predict(this.weights, features);
    const actual = (trade.realizedPnl || 0) > 0 ? 1 : 0;
    this.weights = updateWeights(this.weights, features, predicted, actual);
    this.trainCount++;
    if (this.trainCount % 5 === 0) await this.save();
  }

  async trainBatch(trades) {
    await this.load();
    const closed = trades.filter(t => t.realizedPnl != null);
    for (const trade of closed) {
      const features = extractFeatures(trade);
      const predicted = predict(this.weights, features);
      const actual = trade.realizedPnl > 0 ? 1 : 0;
      this.weights = updateWeights(this.weights, features, predicted, actual);
      this.trainCount++;
    }
    await this.save();
    return closed.length;
  }

  rerank(opportunities) {
    return opportunities
      .map(opp => {
        const mlScore = this.score(opp);
        return {
          ...opp,
          mlScore,
          adjustedEdge: opp.edgePercent * (0.5 + mlScore),
        };
      })
      .sort((a, b) => b.adjustedEdge - a.adjustedEdge);
  }
}

module.exports = EdgeScorer;
