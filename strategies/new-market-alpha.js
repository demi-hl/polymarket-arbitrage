/**
 * New Market Alpha Strategy
 *
 * First-mover advantage on newly created Polymarket markets. Fresh markets
 * are systematically mispriced because:
 * - Initial liquidity is thin (wide spreads)
 * - Early traders set anchoring prices with limited information
 * - Market makers haven't arrived yet to tighten spreads
 * - Informed traders haven't had time to analyze
 *
 * Edge sources:
 * - Detect markets created within last 24-72 hours
 * - Apply base rate models before market reaches efficiency
 * - Exploit anchoring bias in initial pricing
 * - Trade before market makers compress spreads
 */

const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

// How old can a market be to still be considered "new" (hours)
const NEW_MARKET_WINDOW_HOURS = 72;

// Base rate models for common market types
const BASE_RATE_MODELS = {
  // Binary yes/no markets tend to have specific base rates by category
  politics: {
    keywords: ['election', 'president', 'congress', 'senate', 'vote', 'bill', 'law', 'pass'],
    baseRate: 0.45, // Most political predictions don't happen (status quo bias)
    uncertainty: 0.15,
  },
  crypto: {
    keywords: ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'token', 'blockchain', 'defi', 'nft'],
    baseRate: 0.40,
    uncertainty: 0.20,
  },
  technology: {
    keywords: ['ai', 'launch', 'release', 'product', 'acquisition', 'ipo', 'merger'],
    baseRate: 0.35,
    uncertainty: 0.18,
  },
  science: {
    keywords: ['study', 'research', 'vaccine', 'clinical', 'trial', 'fda', 'approval', 'discovery'],
    baseRate: 0.30,
    uncertainty: 0.20,
  },
  entertainment: {
    keywords: ['oscar', 'grammy', 'emmy', 'award', 'box office', 'streaming', 'movie', 'album'],
    baseRate: 0.25, // Multi-nominee markets — each nominee has low base rate
    uncertainty: 0.15,
  },
  sports: {
    keywords: ['championship', 'mvp', 'winner', 'title', 'playoff', 'super bowl', 'world series'],
    baseRate: 0.35,
    uncertainty: 0.20,
  },
  geopolitical: {
    keywords: ['war', 'conflict', 'invasion', 'sanctions', 'ceasefire', 'treaty', 'nato'],
    baseRate: 0.30,
    uncertainty: 0.25,
  },
  weather: {
    keywords: ['hurricane', 'temperature', 'storm', 'weather', 'rainfall', 'record'],
    baseRate: 0.25,
    uncertainty: 0.20,
  },
};

/**
 * Detect market category and return base rate model
 */
function categorizeMarket(text) {
  const lower = text.toLowerCase();
  for (const [category, model] of Object.entries(BASE_RATE_MODELS)) {
    const matches = model.keywords.filter(kw => lower.includes(kw));
    if (matches.length >= 2) return { category, ...model, matchStrength: matches.length };
    if (matches.length === 1) return { category, ...model, matchStrength: 1, uncertainty: model.uncertainty * 1.3 };
  }
  return { category: 'general', baseRate: 0.40, uncertainty: 0.25, matchStrength: 0 };
}

/**
 * Detect if a market is newly created
 */
function isNewMarket(market) {
  const createdAt = market.createdAt || market.created_at || market.startDate;
  if (!createdAt) return false;

  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const ageHours = (now - created) / (1000 * 60 * 60);

  return ageHours <= NEW_MARKET_WINDOW_HOURS;
}

/**
 * Calculate market age in hours
 */
function getMarketAgeHours(market) {
  const createdAt = market.createdAt || market.created_at || market.startDate;
  if (!createdAt) return Infinity;
  return (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60);
}

/**
 * Detect anchoring bias — prices suspiciously close to round numbers
 */
function hasAnchoringBias(price) {
  const roundNumbers = [0.10, 0.20, 0.25, 0.30, 0.33, 0.40, 0.50, 0.60, 0.67, 0.70, 0.75, 0.80, 0.90];
  return roundNumbers.some(r => Math.abs(price - r) < 0.015);
}

/**
 * Estimate mispricing on new markets
 */
function estimateNewMarketEdge(market, price) {
  const text = market.question || market.title || '';
  const model = categorizeMarket(text);
  const ageHours = getMarketAgeHours(market);

  // Younger markets have more mispricing
  const ageFactor = Math.max(0.3, 1 - (ageHours / NEW_MARKET_WINDOW_HOURS));

  // Anchoring bias amplifies mispricing
  const anchoringFactor = hasAnchoringBias(price) ? 1.3 : 1.0;

  // Low liquidity amplifies mispricing
  const volume = parseFloat(market.volume || market.liquidityClob || 0);
  const liquidityFactor = volume < 5000 ? 1.4 : volume < 20000 ? 1.2 : 1.0;

  // Calculate expected mispricing
  const rawEdge = Math.abs(price - model.baseRate);
  const adjustedEdge = rawEdge * ageFactor * anchoringFactor * liquidityFactor;

  // Only trade if edge exceeds uncertainty
  if (adjustedEdge < model.uncertainty * 0.5) return null;

  return {
    modelPrice: model.baseRate,
    edge: adjustedEdge,
    category: model.category,
    ageFactor,
    anchoringDetected: hasAnchoringBias(price),
    confidence: Math.min(adjustedEdge * 5, 0.85) * (model.matchStrength > 1 ? 1 : 0.7),
  };
}

const newMarketAlphaStrategy = {
  name: 'new-market-alpha',
  type: 'alpha',
  riskLevel: 'high',

  async scan(bot) {
    const markets = await fetchMarketsOnce();
    if (!markets || markets.length === 0) return [];

    const newMarkets = markets.filter(isNewMarket);
    if (newMarkets.length === 0) return [];

    const opportunities = [];

    for (const market of newMarkets) {
      try {
        const text = market.question || market.title || '';
        const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
        if (yesPrice <= 0.03 || yesPrice >= 0.97) continue;

        const estimate = estimateNewMarketEdge(market, yesPrice);
        if (!estimate || estimate.edge < 0.04) continue;

        const side = estimate.modelPrice > yesPrice ? 'YES' : 'NO';
        const ageHours = getMarketAgeHours(market);

        opportunities.push({
          type: 'new-market-mispricing',
          market: text.slice(0, 120),
          conditionId: market.conditionId || market.id,
          tokenId: market.clobTokenIds?.[side === 'YES' ? 0 : 1],
          side,
          currentPrice: yesPrice,
          modelPrice: estimate.modelPrice,
          edge: estimate.edge,
          edgePercent: (estimate.edge * 100).toFixed(1) + '%',
          expectedReturn: estimate.edge,
          confidence: estimate.confidence,
          source: `base-rate-${estimate.category}`,
          liquidity: parseFloat(market.volume || market.liquidityClob || 0),
          maxPosition: Math.min(estimate.edge * 300, 75), // Smaller sizing — higher uncertainty
          executionSpeed: 0.8,
          marketAgeHours: Math.round(ageHours),
          anchoringDetected: estimate.anchoringDetected,
          category: estimate.category,
        });
      } catch {}
    }

    // Sort by youngest first (most mispriced)
    opportunities.sort((a, b) => a.marketAgeHours - b.marketAgeHours);
    return opportunities;
  },

  async validate(opp) {
    return opp && opp.edge > 0.04 && opp.confidence > 0.15;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [newMarketAlphaStrategy];
