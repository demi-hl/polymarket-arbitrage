/**
 * Feature Engine
 * Computes ML-ready features for each trading opportunity from historical data.
 * Features are used by the edge model to estimate true profitability.
 */

/**
 * Human-readable names for each feature dimension (index-aligned with toVector output).
 * Used by edge-model for importance reports.
 */
const FEATURE_NAMES = [
  'Gross Edge',
  'Executable Edge',
  'Has CLOB Data',
  'Urgency (Time Decay)',
  'Log Liquidity (norm)',
  'Liquidity Bucket',
  'Depth Ratio (Yes/No)',
  'Spread',
  'Price Mid-Deviation',
  'Price Extreme Flag',
  'Log Volume (norm)',
  'Price Velocity',
  'Price Volatility',
  'Has History Flag',
  'Category Win Rate',
  'Strategy Win Rate',
  'Whale Consensus',
  'Whale Count (norm)',
  'Is Buy-Both Flag',
];

// Keyword sets for market type classification
const MARKET_TYPE_KEYWORDS = {
  crypto: ['bitcoin', 'btc', 'eth', 'ethereum', 'solana', 'crypto', 'price', 'defi', 'token'],
  politics: ['election', 'president', 'senate', 'congress', 'vote', 'political', 'trump', 'biden', 'democrat', 'republican'],
  sports: ['nfl', 'nba', 'mlb', 'game', 'match', 'win', 'championship', 'team', 'player', 'score'],
  entertainment: ['oscar', 'grammy', 'movie', 'film', 'album', 'award', 'box office'],
  science: ['temperature', 'climate', 'space', 'nasa', 'discovery'],
};

class FeatureEngine {
  constructor(dataStore, whaleTracker) {
    this.store = dataStore;
    this.whaleTracker = whaleTracker;
    this._categoryStats = {};
  }

  /**
   * Classify a market question into a type using keyword matching.
   * Returns one of: crypto, politics, sports, entertainment, science, other.
   */
  getMarketType(question) {
    if (!question) return 'other';
    const q = question.toLowerCase();
    let bestType = 'other';
    let bestCount = 0;

    for (const [type, keywords] of Object.entries(MARKET_TYPE_KEYWORDS)) {
      const count = keywords.filter(kw => q.includes(kw)).length;
      if (count > bestCount) {
        bestCount = count;
        bestType = type;
      }
    }

    return bestType;
  }

  /**
   * Compute a feature vector for a given opportunity.
   * All features are normalized to [0, 1] or small numeric ranges.
   */
  computeFeatures(opportunity) {
    const features = {};

    features.grossEdge = opportunity.edgePercent || 0;
    features.executableEdge = opportunity.executableEdge ?? features.grossEdge;
    features.hasClobData = opportunity.pricingSource === 'clob' ? 1 : 0;

    // Time to resolution
    const endDate = opportunity.endDate ? new Date(opportunity.endDate).getTime() : 0;
    const msLeft = endDate > 0 ? Math.max(0, endDate - Date.now()) : 30 * 24 * 3600 * 1000;
    features.daysToResolution = msLeft / (24 * 3600 * 1000);
    features.urgency = features.daysToResolution > 0 ? 1 / (1 + features.daysToResolution) : 0;

    // Liquidity features
    const liq = opportunity.liquidity || 0;
    features.logLiquidity = Math.log10(Math.max(liq, 1));
    features.liquidityBucket = liq < 5000 ? 0 : liq < 20000 ? 1 : liq < 100000 ? 2 : 3;

    // Orderbook depth
    features.clobYesDepth = opportunity.clobYesDepth || 0;
    features.clobNoDepth = opportunity.clobNoDepth || 0;
    features.depthRatio = features.clobYesDepth > 0 && features.clobNoDepth > 0
      ? Math.min(features.clobYesDepth, features.clobNoDepth) / Math.max(features.clobYesDepth, features.clobNoDepth)
      : 0;

    // Spread
    features.spread = opportunity.spread || 0;

    // Price features
    features.yesPrice = opportunity.yesPrice || 0;
    features.noPrice = opportunity.noPrice || 0;
    features.priceMidDeviation = Math.abs(features.yesPrice - 0.5);
    features.priceExtreme = (features.yesPrice > 0.9 || features.yesPrice < 0.1) ? 1 : 0;

    // Volume
    features.logVolume = Math.log10(Math.max(opportunity.volume || 1, 1));

    // Price velocity & volatility from historical snapshots
    const history = this.store
      ? this.store.getMarketHistory(opportunity.marketId)
      : { velocity: 0, volatility: 0 };
    features.priceVelocity = history.velocity;
    features.priceVolatility = history.volatility;
    features.hasHistory = history.snapshots > 5 ? 1 : 0;

    // Category performance
    const catStats = this._getCategoryWinRate(opportunity.category);
    features.categoryWinRate = catStats.winRate;
    features.categoryTradeCount = catStats.total;

    // Strategy historical performance
    const stratStats = this._getStrategyWinRate(opportunity.strategy);
    features.strategyWinRate = stratStats.winRate;
    features.strategyTradeCount = stratStats.total;

    // Whale consensus
    if (this.whaleTracker && opportunity.conditionId) {
      const signal = this.whaleTracker.getConsensus(opportunity.conditionId);
      features.whaleConsensus = signal ? signal.confidence : 0;
      features.whaleCount = signal ? signal.wallets.length : 0;
    } else {
      features.whaleConsensus = 0;
      features.whaleCount = 0;
    }

    // Direction encoding
    features.isBuyBoth = opportunity.direction === 'BUY_BOTH' ? 1 : 0;

    return features;
  }

  /**
   * Convert feature object to a numeric array for model input.
   */
  toVector(features) {
    return [
      features.grossEdge,
      features.executableEdge,
      features.hasClobData,
      features.urgency,
      features.logLiquidity / 6,       // normalize assuming max ~$1M
      features.liquidityBucket / 3,
      features.depthRatio,
      features.spread,
      features.priceMidDeviation,
      features.priceExtreme,
      features.logVolume / 8,           // normalize assuming max ~$100M
      features.priceVelocity,
      features.priceVolatility,
      features.hasHistory,
      features.categoryWinRate,
      features.strategyWinRate,
      features.whaleConsensus,
      Math.min(features.whaleCount / 10, 1),
      features.isBuyBoth,
    ];
  }

  get featureNames() {
    return [
      'grossEdge', 'executableEdge', 'hasClobData', 'urgency',
      'logLiquidity', 'liquidityBucket', 'depthRatio', 'spread',
      'priceMidDeviation', 'priceExtreme', 'logVolume',
      'priceVelocity', 'priceVolatility', 'hasHistory',
      'categoryWinRate', 'strategyWinRate',
      'whaleConsensus', 'whaleCount', 'isBuyBoth',
    ];
  }

  _getCategoryWinRate(category) {
    if (!this.store) return { winRate: 0.5, total: 0 };
    if (!this._categoryStats || Object.keys(this._categoryStats).length === 0) {
      this._rebuildCategoryStats();
    }
    return this._categoryStats[category] || { winRate: 0.5, total: 0 };
  }

  _getStrategyWinRate(strategy) {
    if (!this.store) return { winRate: 0.5, total: 0 };
    const stats = this.store.getStrategyStats();
    return stats[strategy] || { winRate: 0.5, total: 0 };
  }

  _rebuildCategoryStats() {
    if (!this.store) return;
    this._categoryStats = {};
    for (const snap of this.store.getAllSnapshots()) {
      const cat = snap.category || 'unknown';
      if (!this._categoryStats[cat]) this._categoryStats[cat] = { total: 0, wins: 0, winRate: 0.5 };
    }
    const trades = this.store.getAllTrades();
    for (const t of trades) {
      const cat = t.category || 'unknown';
      if (!this._categoryStats[cat]) this._categoryStats[cat] = { total: 0, wins: 0, winRate: 0.5 };
      this._categoryStats[cat].total++;
      if ((t.realizedPnl ?? t.expectedProfit ?? 0) > 0) this._categoryStats[cat].wins++;
    }
    for (const s of Object.values(this._categoryStats)) {
      s.winRate = s.total > 0 ? s.wins / s.total : 0.5;
    }
  }
}

module.exports = FeatureEngine;
module.exports.FEATURE_NAMES = FEATURE_NAMES;
