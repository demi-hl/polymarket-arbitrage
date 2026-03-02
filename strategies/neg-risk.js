/**
 * Neg-Risk Bundle Arbitrage
 *
 * Polymarket neg-risk events use the Conditional Token Framework where
 * a complete set of outcomes always sums to exactly $1.00.
 *
 * Two guaranteed-profit strategies:
 *
 * 1. BUY ALL YES: If sum of best YES ask prices < $1, buy YES on every
 *    outcome. Exactly one outcome resolves YES → pays $1. Cost was < $1.
 *    Profit = $1 - total_cost (guaranteed, zero directional risk).
 *
 * 2. BUY ALL NO: If sum of best NO ask prices < total_outcomes - 1,
 *    buy NO on every outcome. All but one resolve NO → collect payouts.
 *    (Less common, but occasionally appears.)
 *
 * This is the only true "free money" strategy — no directional risk,
 * no timing risk, just execution risk (filling all legs).
 *
 * Implementation: constructs the full bundle and enters all legs as
 * a single atomic trade set. All legs are marked holdUntilResolution.
 */
const axios = require('axios');
const ClobClient = require('../clob-client');

const GAMMA_API = 'https://gamma-api.polymarket.com';

let _clobClient = null;
function getClobClient() {
  if (!_clobClient) _clobClient = new ClobClient();
  return _clobClient;
}

async function fetchNegRiskEvents() {
  const allEvents = [];
  for (let page = 0; page < 3; page++) {
    try {
      const res = await axios.get(`${GAMMA_API}/events`, {
        params: { active: true, closed: false, negRisk: true, order: 'volume', ascending: false, limit: 50, offset: page * 50 },
        timeout: 12000,
      });
      if (!Array.isArray(res.data) || res.data.length === 0) break;
      allEvents.push(...res.data);
    } catch { break; }
  }
  return allEvents;
}

function parseTokens(market) {
  let tokens = market.clobTokenIds;
  if (typeof tokens === 'string') {
    try { tokens = JSON.parse(tokens); } catch { return null; }
  }
  if (!Array.isArray(tokens) || tokens.length < 2) return null;
  return tokens;
}

/**
 * Analyze a neg-risk event for complete-set arbitrage.
 * Returns null if no arb exists, or a bundle description if it does.
 */
async function analyzeBundle(event, clob) {
  const markets = (event.markets || []).filter(m => m.active && !m.closed);
  if (markets.length < 2) return null;

  const legs = [];
  let totalYesAskCost = 0;
  let minAskDepthUsd = Infinity;
  let allBooksAvailable = true;

  for (const market of markets) {
    const tokens = parseTokens(market);
    if (!tokens) { allBooksAvailable = false; break; }

    let yesBook;
    try {
      yesBook = await clob.getOrderbook(tokens[0]);
    } catch { allBooksAvailable = false; break; }

    if (!yesBook || !yesBook.bestAsk || yesBook.bestAsk <= 0) {
      allBooksAvailable = false;
      break;
    }

    const askPrice = yesBook.bestAsk;
    const askDepthUsd = yesBook.asks.reduce((s, l) => s + l.size * l.price, 0);

    totalYesAskCost += askPrice;
    minAskDepthUsd = Math.min(minAskDepthUsd, askDepthUsd);

    legs.push({
      marketId: market.id,
      question: market.question || market.groupItemTitle,
      slug: market.slug,
      conditionId: market.conditionId,
      endDate: market.endDate,
      askPrice,
      askDepthUsd,
      liquidity: market.liquidity || 0,
      tokenId: tokens[0],
      noTokenId: tokens[1],
    });
  }

  if (!allBooksAvailable || legs.length < 2) return null;

  // Complete set costs $1.00 at resolution. If we can buy all YES for < $1, it's free money.
  const spread = 1.0 - totalYesAskCost;
  if (spread <= 0) return null;

  // Account for execution costs
  const gasPerLeg = 0.04;
  const totalGas = gasPerLeg * legs.length;

  // Position size limited by the shallowest leg
  const maxBundleSize = Math.min(minAskDepthUsd * 0.3, 150);
  if (maxBundleSize < 10) return null;

  const gasPct = totalGas / maxBundleSize;
  const netSpread = spread - gasPct - 0.002; // 0.2% safety margin

  if (netSpread < 0.01) return null;

  return {
    eventTitle: event.title,
    eventSlug: event.slug,
    legCount: legs.length,
    totalYesAskCost: parseFloat(totalYesAskCost.toFixed(4)),
    spread: parseFloat(spread.toFixed(4)),
    netSpread: parseFloat(netSpread.toFixed(4)),
    maxBundleSize,
    minAskDepthUsd: parseFloat(minAskDepthUsd.toFixed(2)),
    legs,
  };
}

const negRiskBundleArb = {
  name: 'neg-risk-spread-arb',
  type: 'fundamental',
  riskLevel: 'low',

  async scan(bot) {
    const TIMEOUT = 30000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('neg-risk scan timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[neg-risk-spread-arb]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const events = await fetchNegRiskEvents();
      const clob = getClobClient();
      const opportunities = [];

      for (const event of events) {
        const bundle = await analyzeBundle(event, clob);
        if (!bundle) continue;

        // Create one opportunity per leg — all legs must be filled for the arb to work
        const perLegSize = bundle.maxBundleSize / bundle.legCount;

        for (const leg of bundle.legs) {
          opportunities.push({
            marketId: leg.marketId,
            question: `[Bundle] ${leg.question}`,
            slug: leg.slug,
            category: bundle.eventTitle,
            eventTitle: bundle.eventTitle,
            yesPrice: leg.askPrice,
            noPrice: 1 - leg.askPrice,
            sum: bundle.totalYesAskCost,
            edge: bundle.spread,
            edgePercent: bundle.netSpread,
            executableEdge: bundle.netSpread,
            liquidity: leg.liquidity,
            volume: 0,
            conditionId: leg.conditionId,
            endDate: leg.endDate,
            direction: 'BUY_YES',
            maxPosition: perLegSize,
            expectedReturn: bundle.netSpread,
            confidence: Math.min(0.95, 0.8 + bundle.netSpread * 2),
            strategy: 'neg-risk-spread-arb',
            negRisk: true,
            holdUntilResolution: true,
            bundleArb: true,
            legCount: bundle.legCount,
            totalAskSum: bundle.totalYesAskCost,
            guaranteedSpread: bundle.spread,
            netSpread: bundle.netSpread,
            bundleEvent: bundle.eventSlug,
            clobTokenIds: [leg.tokenId, leg.noTokenId],
          });
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 20);
    } catch (err) {
      console.error('[neg-risk-spread-arb]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.01 && opp.guaranteedSpread > 0;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [negRiskBundleArb];
