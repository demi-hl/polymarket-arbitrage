/**
 * Cross-platform + value strategies (23-26).
 * REALISTIC: strict matching, fee-aware, liquidity-capped position sizing.
 * All trades execute on Polymarket only.
 */
const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');
const { KalshiScanner } = require('../integrations/kalshi');
const { PredictItScanner } = require('../integrations/predictit');
const { matchMarkets } = require('../integrations/matcher');

const kalshi = new KalshiScanner();
const predictit = new PredictItScanner();

let _externalCache = { kalshi: null, predictit: null, time: 0 };
const EXTERNAL_TTL = 90000;

const REALISTIC_SPREAD_COST = 0.005;  // 0.5% average spread/slippage
const KALSHI_FEE_EQUIVALENT = 0.007;  // Kalshi fee priced into their odds
const PREDICTIT_FEE_DRAG = 0.015;     // PredictIt's 10% profit fee + withdrawal drag on effective price

async function fetchExternalMarkets() {
  const now = Date.now();
  if (_externalCache.kalshi && now - _externalCache.time < EXTERNAL_TTL) {
    return _externalCache;
  }
  const [kalshiMarkets, predictitMarkets] = await Promise.allSettled([
    kalshi.fetchMarkets(),
    predictit.fetchMarkets(),
  ]);
  _externalCache = {
    kalshi: kalshiMarkets.status === 'fulfilled' ? kalshiMarkets.value : [],
    predictit: predictitMarkets.status === 'fulfilled' ? predictitMarkets.value : [],
    time: Date.now(),
  };
  return _externalCache;
}

function crossPlatformOpportunity(match, source) {
  const pm = match.polyMarket;
  const liquidity = pm.liquidity || 0;

  const positionCap = Math.min(liquidity * 0.02, 500);

  let feeDrag = REALISTIC_SPREAD_COST;
  if (source === 'kalshi') feeDrag += KALSHI_FEE_EQUIVALENT;
  if (source === 'predictit') feeDrag += PREDICTIT_FEE_DRAG;

  const grossEdge = match.edgePercent;
  const netEdge = Math.max(0, grossEdge - feeDrag);

  return {
    marketId: pm.id,
    question: pm.question,
    slug: pm.slug,
    yesPrice: pm.yesPrice,
    noPrice: pm.noPrice,
    sum: pm.yesPrice + pm.noPrice,
    edge: grossEdge,
    edgePercent: netEdge,
    grossEdge,
    feeDrag,
    liquidity,
    volume: pm.volume,
    conditionId: pm.conditionId,
    endDate: pm.endDate,
    direction: match.direction,
    maxPosition: positionCap,
    expectedReturn: netEdge,
    externalSource: match.externalMarket.platform,
    externalTitle: match.externalMarket.title,
    externalYesPrice: match.externalMarket.yesPrice,
    matchScore: match.matchScore,
    note: `${match.externalMarket.platform} YES=${(match.externalMarket.yesPrice * 100).toFixed(1)}¢ vs Poly YES=${(pm.yesPrice * 100).toFixed(1)}¢ | gross ${(grossEdge * 100).toFixed(1)}% - fees ${(feeDrag * 100).toFixed(1)}% = net ${(netEdge * 100).toFixed(1)}%`,
  };
}

const MIN_NET_EDGE = 0.005; // 0.5% minimum net edge after fees to even consider

const kalshiArbitrage = {
  name: 'kalshi-arbitrage',
  type: 'cross-platform',
  riskLevel: 'low',
  async scan(bot) {
    const minEdge = bot.scanThreshold ?? bot.edgeThreshold ?? 0.02;
    try {
      const [polyMarkets, external] = await Promise.all([
        fetchMarketsOnce(),
        fetchExternalMarkets(),
      ]);
      const kalshiList = external.kalshi || [];
      if (kalshiList.length === 0) return [];

      const matches = matchMarkets(polyMarkets, kalshiList, {
        minSimilarity: 0.65,
        minEdge,
        maxEdge: 0.08,
        minLiquidity: 2000,
      });
      return matches
        .map(m => crossPlatformOpportunity(m, 'kalshi'))
        .filter(o => o.edgePercent >= MIN_NET_EDGE);
    } catch (err) {
      console.error('[kalshi-arbitrage]', err.message);
      return [];
    }
  },
  async validate(opp) {
    return opp && opp.edgePercent >= MIN_NET_EDGE && opp.matchScore >= 0.55 && opp.maxPosition >= 5;
  },
  async execute(bot, opp) { return bot.execute(opp, {}); },
};

const predictitArbitrage = {
  name: 'predictit-arbitrage',
  type: 'cross-platform',
  riskLevel: 'medium',
  async scan(bot) {
    const minEdge = bot.scanThreshold ?? bot.edgeThreshold ?? 0.02;
    try {
      const [polyMarkets, external] = await Promise.all([
        fetchMarketsOnce(),
        fetchExternalMarkets(),
      ]);
      const piList = external.predictit || [];
      if (piList.length === 0) return [];

      const matches = matchMarkets(polyMarkets, piList, {
        minSimilarity: 0.65,
        minEdge,
        maxEdge: 0.08,
        minLiquidity: 2000,
      });
      return matches
        .map(m => crossPlatformOpportunity(m, 'predictit'))
        .filter(o => o.edgePercent >= MIN_NET_EDGE);
    } catch (err) {
      console.error('[predictit-arbitrage]', err.message);
      return [];
    }
  },
  async validate(opp) {
    return opp && opp.edgePercent >= MIN_NET_EDGE && opp.matchScore >= 0.55 && opp.maxPosition >= 5;
  },
  async execute(bot, opp) { return bot.execute(opp, {}); },
};

const threeWayArbitrage = {
  name: 'three-way-arbitrage',
  type: 'cross-platform',
  riskLevel: 'low',
  async scan(bot) {
    const minEdge = bot.scanThreshold ?? bot.edgeThreshold ?? 0.02;
    try {
      const [polyMarkets, external] = await Promise.all([
        fetchMarketsOnce(),
        fetchExternalMarkets(),
      ]);
      const allExternal = [
        ...(external.kalshi || []),
        ...(external.predictit || []),
      ];
      if (allExternal.length === 0) return [];

      const matches = matchMarkets(polyMarkets, allExternal, {
        minSimilarity: 0.65,
        minEdge,
        maxEdge: 0.06,
        minLiquidity: 10000,
      });

      const seen = new Set();
      const deduped = [];
      for (const m of matches) {
        if (seen.has(m.polyMarket.id)) continue;
        seen.add(m.polyMarket.id);
        deduped.push(m);
      }

      const source = 'kalshi'; // pessimistic fee assumption
      return deduped
        .map(m => ({ ...crossPlatformOpportunity(m, source), threeWay: true }))
        .filter(o => o.edgePercent >= MIN_NET_EDGE);
    } catch (err) {
      console.error('[three-way-arbitrage]', err.message);
      return [];
    }
  },
  async validate(opp) {
    return opp && opp.edgePercent >= MIN_NET_EDGE && opp.matchScore >= 0.55 && opp.maxPosition >= 5;
  },
  async execute(bot, opp) { return bot.execute(opp, {}); },
};

const valueBetting = {
  name: 'value-betting',
  type: 'fundamental',
  riskLevel: 'medium',
  async scan(bot) {
    const opps = await getOpportunities(bot, { threshold: 0.02 });
    return opps
      .map(o => {
        const base = toBotOpportunity(o);
        const edge = base.edgePercent || 0;
        const impliedYes = base.yesPrice || 0.5;
        const kelly = impliedYes > 0 && impliedYes < 1
          ? (edge - (1 - impliedYes)) / (1 - impliedYes) * impliedYes
          : 0;
        const kellyCapped = Math.max(0, Math.min(kelly, 0.05));
        return { ...base, kellyCapped };
      })
      .filter(o => o.kellyCapped > 0.001 && o.edgePercent > REALISTIC_SPREAD_COST)
      .sort((a, b) => b.kellyCapped - a.kellyCapped)
      .map(({ kellyCapped, ...rest }) => rest);
  },
  async validate(opp) { return opp && opp.edgePercent > REALISTIC_SPREAD_COST; },
  async execute(bot, opp) { return bot.execute(toBotOpportunity(opp), {}); },
};

module.exports = [
  kalshiArbitrage,
  predictitArbitrage,
  threeWayArbitrage,
  valueBetting,
];
