/**
 * Neg-Risk Spread Arbitrage
 *
 * Polymarket neg-risk events allow buying a complete set of outcomes for $1.
 * If the sum of best YES ask prices across all outcomes < $1, buying all outcomes
 * guarantees a profit at resolution (exactly one outcome pays $1).
 *
 * This is a pure structural arbitrage with near-zero risk.
 * The only risk is execution: failing to fill all legs, or gas costs exceeding the edge.
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

const negRiskSpreadArb = {
  name: 'neg-risk-spread-arb',
  type: 'fundamental',
  riskLevel: 'low',

  async scan(bot) {
    const TIMEOUT = 25000;
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
        const markets = (event.markets || []).filter(m => m.active && !m.closed);
        if (markets.length < 2) continue;

        let totalAskSum = 0;
        let totalLiquidity = 0;
        let minAskLiquidity = Infinity;
        let allHaveBooks = true;
        const legs = [];

        for (const market of markets) {
          const tokens = parseTokens(market);
          if (!tokens) { allHaveBooks = false; break; }

          let yesBook;
          try {
            yesBook = await clob.getOrderbook(tokens[0]);
          } catch { allHaveBooks = false; break; }

          if (!yesBook || !yesBook.bestAsk || yesBook.bestAsk <= 0) {
            allHaveBooks = false; break;
          }

          const askPrice = yesBook.bestAsk;
          const askDepth = yesBook.askDepth || 0;
          totalAskSum += askPrice;
          totalLiquidity += (market.liquidity || 0);
          minAskLiquidity = Math.min(minAskLiquidity, askDepth);

          legs.push({
            marketId: market.id,
            question: market.question || market.groupItemTitle,
            slug: market.slug,
            conditionId: market.conditionId,
            endDate: market.endDate,
            askPrice,
            askDepth,
            liquidity: market.liquidity || 0,
            tokenId: tokens[0],
          });
        }

        if (!allHaveBooks || legs.length < 2) continue;

        const spread = 1.0 - totalAskSum;
        if (spread <= 0) continue;

        const gasPerLeg = 0.04;
        const totalGas = gasPerLeg * legs.length;
        const positionSize = Math.min(minAskLiquidity * 0.5, 200);
        const gasPct = positionSize > 0 ? totalGas / positionSize : 1;
        const netEdge = Math.max(0, spread - gasPct - 0.002);

        if (netEdge < 0.003) continue;

        for (const leg of legs) {
          opportunities.push({
            marketId: leg.marketId,
            question: `[NegRisk] ${leg.question}`,
            slug: leg.slug,
            category: event.title,
            eventTitle: event.title,
            yesPrice: leg.askPrice,
            noPrice: 1 - leg.askPrice,
            sum: totalAskSum,
            edge: spread,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: leg.liquidity,
            volume: 0,
            conditionId: leg.conditionId,
            endDate: leg.endDate,
            direction: 'BUY_YES',
            maxPosition: Math.min(positionSize / legs.length, 100),
            expectedReturn: netEdge,
            confidence: Math.min(spread * 10, 1),
            strategy: 'neg-risk-spread-arb',
            negRisk: true,
            legCount: legs.length,
            totalAskSum: parseFloat(totalAskSum.toFixed(4)),
            guaranteedSpread: parseFloat(spread.toFixed(4)),
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
    return opp && opp.edgePercent >= 0.003 && opp.guaranteedSpread > 0;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [negRiskSpreadArb];
