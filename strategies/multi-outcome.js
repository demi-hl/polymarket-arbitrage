/**
 * Multi-outcome event arbitrage strategy.
 * Scans events with 3+ outcomes where the YES price sum deviates from 100%.
 * - UNDERPRICED (sum < 100%): buy YES on cheapest outcomes → guaranteed payout at resolution.
 * - OVERPRICED  (sum > 100%): buy NO on most-overpriced outcomes.
 * Filters out non-mutually-exclusive events (e.g. "what price will X hit").
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const NON_EXCLUSIVE_PATTERNS = [
  /what price will .+ hit/i,
  /which companies will/i,
  /which teams will/i,
  /what will happen before/i,
  /market cap.*after launch/i,
  /sells any .+ by/i,
  /episode released by/i,
  /tweets .+ \d/i,
  /O\/U \d/i,
  /over\/under/i,
  /vs\./i,
  /FDV above/i,
  /above ___/i,
  /how many .+ will/i,
  /price .+ hit .+ in/i,
  /strike \d+ countries/i,
  /enter .+ by/i,
  /by ___/i,
  /released by\.\.\./i,
  /before \.\.\./i,
];

function isNonExclusive(title) {
  return NON_EXCLUSIVE_PATTERNS.some(p => p.test(title || ''));
}

function hasNonExclusiveOutcomes(markets) {
  for (const m of markets) {
    const q = (m.question || m.groupItemTitle || '').toLowerCase();
    if (/o\/u \d|over\/under|spread|handicap/i.test(q)) return true;
  }
  return false;
}

async function fetchMultiOutcomeEvents() {
  const pages = Math.max(1, parseInt(process.env.SCAN_MAX_EVENT_PAGES || '4', 10));
  const allEvents = [];
  for (let page = 0; page < pages; page++) {
    try {
      const res = await axios.get(`${GAMMA_API}/events`, {
        params: { active: true, closed: false, order: 'volume', ascending: false, limit: 100, offset: page * 100 },
        timeout: 12000,
      });
      if (!Array.isArray(res.data) || res.data.length === 0) break;
      allEvents.push(...res.data);
    } catch { break; }
  }
  return allEvents;
}

function analyzeEvent(event) {
  const markets = (event.markets || []).filter(m => m.active && !m.closed);
  if (markets.length < 3) return null;
  if (isNonExclusive(event.title)) return null;
  if (hasNonExclusiveOutcomes(markets)) return null;

  let yesSum = 0;
  let totalLiquidity = 0;
  const outcomes = [];

  for (const m of markets) {
    let prices, outcomeNames;
    try {
      prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      outcomeNames = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : m.outcomes;
    } catch { continue; }

    const yesPrice = parseFloat(prices[0]) || 0;
    const noPrice = parseFloat(prices[1]) || 0;
    const liquidity = parseFloat(m.liquidityNum || m.liquidity) || 0;

    if (yesPrice <= 0 || yesPrice >= 1) continue;

    yesSum += yesPrice;
    totalLiquidity += liquidity;
    outcomes.push({
      marketId: m.id,
      name: m.question || (outcomeNames && outcomeNames[0]) || m.groupItemTitle || '?',
      yesPrice,
      noPrice,
      liquidity,
      slug: m.slug,
      conditionId: m.conditionId,
      endDate: m.endDate,
    });
  }

  if (outcomes.length < 3) return null;

  const deviation = yesSum - 1.0;
  const absDeviation = Math.abs(deviation);

  if (absDeviation < 0.005) return null;
  if (yesSum > 1.15 || yesSum < 0.85) return null;

  const direction = deviation < 0 ? 'UNDERPRICED' : 'OVERPRICED';

  outcomes.sort((a, b) => {
    if (direction === 'UNDERPRICED') return a.yesPrice - b.yesPrice;
    return b.yesPrice - a.yesPrice;
  });

  return {
    eventTitle: event.title,
    eventSlug: event.slug,
    outcomeCount: outcomes.length,
    yesSum,
    deviation,
    absDeviation,
    deviationPct: deviation * 100,
    direction,
    totalLiquidity,
    outcomes,
  };
}

function buildOpportunities(analysis, maxLegs = 5) {
  const { direction, outcomes, absDeviation, eventTitle, totalLiquidity, deviationPct } = analysis;
  const opportunities = [];

  const legs = outcomes.slice(0, maxLegs);
  const minLegLiquidity = Math.min(...legs.map(l => l.liquidity));
  if (minLegLiquidity < 200) return [];

  const gasCostPerLeg = 0.08;
  const totalGas = gasCostPerLeg * legs.length;

  for (const leg of legs) {
    const side = direction === 'UNDERPRICED' ? 'BUY_YES' : 'BUY_NO';
    const entryPrice = side === 'BUY_YES' ? leg.yesPrice : leg.noPrice;

    const perLegEdge = absDeviation / legs.length;
    const gasAsPct = gasCostPerLeg / (entryPrice * 100);
    const netEdge = Math.max(0, perLegEdge - gasAsPct - 0.002);

    if (netEdge < 0.003) continue;

    const maxPos = Math.min(leg.liquidity * 0.015, 150);

    opportunities.push({
      marketId: leg.marketId,
      question: leg.name,
      slug: leg.slug,
      category: eventTitle,
      eventTitle,
      yesPrice: leg.yesPrice,
      noPrice: leg.noPrice,
      sum: leg.yesPrice + leg.noPrice,
      edge: perLegEdge,
      edgePercent: netEdge,
      executableEdge: netEdge,
      liquidity: leg.liquidity,
      volume: 0,
      conditionId: leg.conditionId,
      endDate: leg.endDate,
      direction: side,
      maxPosition: maxPos,
      expectedReturn: netEdge,
      confidence: Math.min(absDeviation * 10, 1),
      strategy: 'multi-outcome-arb',
      multiOutcome: true,
      eventDeviationPct: deviationPct,
      legCount: legs.length,
      totalEventLiquidity: totalLiquidity,
    });
  }

  return opportunities;
}

const multiOutcomeArb = {
  name: 'multi-outcome-arb',
  type: 'fundamental',
  riskLevel: 'low',

  async scan(bot) {
    try {
      const events = await fetchMultiOutcomeEvents();
      const allOpps = [];

      for (const event of events) {
        const analysis = analyzeEvent(event);
        if (!analysis) continue;
        if (analysis.absDeviation < 0.008) continue;
        const opps = buildOpportunities(analysis);
        allOpps.push(...opps);
      }

      allOpps.sort((a, b) => b.edgePercent - a.edgePercent);
      return allOpps.slice(0, 20);
    } catch (err) {
      console.error('[multi-outcome-arb]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent > 0.003 && opp.liquidity >= 200;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [multiOutcomeArb];
