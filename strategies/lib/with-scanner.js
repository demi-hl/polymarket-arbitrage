/**
 * Shared scanner helper with market cache.
 * All strategies share ONE API call per scan cycle (30s TTL).
 */
const PolymarketScanner = require('../../scanner');

const DEFAULT_EDGE = 0.03;

let _cachedMarkets = null;
let _cacheTime = 0;
let _cacheKey = '';
const CACHE_TTL = 120000; // 2min — covers full scan cycle so strategies share one fetch
let _fetchPromise = null;

function getScanner(bot, minEdge = null) {
  const threshold = minEdge ?? bot.scanThreshold ?? bot.edgeThreshold ?? DEFAULT_EDGE;
  const sectors = bot.sectors;
  return new PolymarketScanner({
    edgeThreshold: threshold,
    minLiquidity: 5000,
    ...(sectors && sectors.length ? { sectors } : {})
  });
}

/**
 * Fetch markets once per cycle; cache is keyed by sectors so politics,sports,crypto gets its own cache.
 * @param {object} [options] - { sectors: string[] } e.g. ['politics','sports','crypto']
 */
async function fetchMarketsOnce(options = {}) {
  const sectors = options.sectors ?? options?.bot?.sectors;
  const key = Array.isArray(sectors) && sectors.length ? sectors.slice().sort().join(',') : '';
  const now = Date.now();
  if (_cachedMarkets && _cacheKey === key && now - _cacheTime < CACHE_TTL) return _cachedMarkets;
  if (_fetchPromise && _cacheKey === key) return _fetchPromise;

  _fetchPromise = (async () => {
    try {
      const scanner = new PolymarketScanner({
        minLiquidity: 5000,
        ...(key ? { sectors: sectors } : {})
      });
      const markets = await scanner.fetchMarkets({ sectors: key ? sectors : undefined });
      _cachedMarkets = markets;
      _cacheKey = key;
      _cacheTime = Date.now();
      return markets;
    } finally {
      _fetchPromise = null;
    }
  })();

  return _fetchPromise;
}

/**
 * Get opportunities using shared market cache.
 * @param {object} bot
 * @param {object} options - { threshold, filter: (market, arb) => boolean }
 */
async function getOpportunities(bot, options = {}) {
  const strategyThreshold = options.threshold ?? bot.edgeThreshold ?? DEFAULT_EDGE;
  const threshold = bot.scanThreshold != null
    ? Math.min(bot.scanThreshold, strategyThreshold)
    : strategyThreshold;
  const scanner = getScanner(bot, threshold);
  const customFilter = options.filter || (() => true);
  const sectors = options.sectors ?? bot?.sectors;

  const markets = await fetchMarketsOnce({ sectors });
  const opportunities = [];

  for (const market of markets) {
    const arb = scanner.calculateArbitrage(market);
    if (!arb || arb.edgePercent < threshold) continue;
    if (!customFilter(market, arb)) continue;
    opportunities.push(arb);
  }

  opportunities.sort((a, b) => (b.edgePercent || 0) - (a.edgePercent || 0));
  return opportunities;
}

function toBotOpportunity(opp) {
  const liquidity = opp.liquidity || 0;
  const positionCap = Math.min(liquidity * 0.02, 500);
  return {
    marketId: opp.marketId,
    question: opp.question,
    slug: opp.slug,
    category: opp.category,
    eventTitle: opp.eventTitle,
    yesPrice: opp.yesPrice,
    noPrice: opp.noPrice,
    sum: opp.sum,
    edge: opp.edge,
    edgePercent: opp.edgePercent,
    liquidity,
    volume: opp.volume,
    conditionId: opp.conditionId,
    endDate: opp.endDate,
    direction: opp.direction || (opp.sum < 1 ? 'BUY_BOTH' : 'SELL_BOTH'),
    maxPosition: opp.maxPosition ?? positionCap,
    expectedReturn: opp.edgePercent
  };
}

function clearCache() {
  _cachedMarkets = null;
  _cacheTime = 0;
  _cacheKey = '';
}

module.exports = { getScanner, getOpportunities, toBotOpportunity, DEFAULT_EDGE, clearCache, fetchMarketsOnce };
