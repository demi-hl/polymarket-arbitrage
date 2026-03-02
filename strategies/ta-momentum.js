/**
 * TA Momentum + Mean Reversion Strategy
 *
 * Uses the technical analysis engine to find markets where TA signals
 * converge on a directional bet. Combines:
 *   - EMA 9/21 crossover for trend direction
 *   - RSI for overbought/oversold confirmation
 *   - Bollinger Bands for mean-reversion entries
 *   - ADX for trend strength filtering
 *   - OBV for volume confirmation
 *
 * Two modes:
 *   MOMENTUM: EMA cross + RSI confirmation + strong ADX → ride the trend
 *   MEAN_REVERSION: BB extreme + RSI divergence + weak ADX → fade the move
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');
const { analyze } = require('../lib/technical-analysis');

const CLOB_API = 'https://clob.polymarket.com';

async function fetchPriceHistory(tokenId) {
  try {
    const endTs = Math.floor(Date.now() / 1000);
    const startTs = endTs - 7 * 24 * 3600;
    const res = await axios.get(`${CLOB_API}/prices-history`, {
      params: { market: tokenId, startTs, endTs, interval: '1h', fidelity: 60 },
      timeout: 5000,
    });
    return res.data?.history || [];
  } catch { return []; }
}

function parseTokens(market) {
  let tokens = market.clobTokenIds;
  if (typeof tokens === 'string') {
    try { tokens = JSON.parse(tokens); } catch { return null; }
  }
  if (!Array.isArray(tokens) || tokens.length < 1) return null;
  return tokens;
}

function parsePrice(market) {
  let prices;
  try {
    prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
  } catch { return null; }
  if (!prices || prices.length < 2) return null;
  return { yes: parseFloat(prices[0]) || 0, no: parseFloat(prices[1]) || 0 };
}

const taMomentumStrategy = {
  name: 'ta-momentum',
  type: 'technical',
  riskLevel: 'medium',

  async scan(bot) {
    const TIMEOUT = 25000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('ta-momentum timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[ta-momentum]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const markets = await fetchMarketsOnce();
      const liquid = markets.filter(m => {
        if (m.active === false || m.closed) return false;
        const liq = m.liquidity || 0;
        const vol = m.volume || 0;
        return liq >= 10000 && vol >= 5000;
      });

      liquid.sort((a, b) => (b.volume || 0) - (a.volume || 0));
      const candidates = liquid.slice(0, 15);

      const opportunities = [];

      for (let i = 0; i < candidates.length; i += 5) {
        const batch = candidates.slice(i, i + 5);
        const results = await Promise.allSettled(batch.map(async m => {
          const tokens = parseTokens(m);
          if (!tokens) return null;

          const candles = await fetchPriceHistory(tokens[0]);
          if (candles.length < 30) return null;

          const ta = analyze(candles);
          if (!ta) return null;

          const prices = parsePrice(m);
          if (!prices) return null;
          if (prices.yes < 0.1 || prices.yes > 0.9) return null;

          return { market: m, ta, prices };
        }));

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { market, ta, prices } = r.value;

          let edge = 0, direction = null, mode = null;

          // MOMENTUM MODE: strong trend + EMA aligned + RSI confirms
          if (ta.strongTrend && ta.adx > 30) {
            if (ta.emaTrend === 'bullish' && !ta.rsiOverbought && ta.momentum >= 1.5) {
              edge = Math.min(ta.adx / 100 * 0.05, 0.04);
              direction = 'BUY_YES';
              mode = 'momentum';
            } else if (ta.emaTrend === 'bearish' && !ta.rsiOversold && ta.momentum <= -1.5) {
              edge = Math.min(ta.adx / 100 * 0.05, 0.04);
              direction = 'BUY_NO';
              mode = 'momentum';
            }
          }

          // MEAN REVERSION MODE: weak trend + BB extreme + RSI divergence
          if (!mode && !ta.strongTrend) {
            if (ta.bbBelowLower && ta.rsiOversold) {
              edge = Math.min(Math.abs(ta.bbPosition) * 0.03, 0.035);
              direction = 'BUY_YES';
              mode = 'mean-reversion';
            } else if (ta.bbAboveUpper && ta.rsiOverbought) {
              edge = Math.min(Math.abs(1 - ta.bbPosition) * 0.03, 0.035);
              direction = 'BUY_NO';
              mode = 'mean-reversion';
            }
          }

          if (!direction || edge < 0.005) continue;
          const netEdge = Math.max(0, edge - 0.003);
          if (netEdge < 0.005) continue;

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice: prices.yes,
            noPrice: prices.no,
            sum: prices.yes + prices.no,
            edge,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min((market.liquidity || 0) * 0.01, 200),
            expectedReturn: netEdge,
            confidence: Math.min(Math.abs(ta.momentum) / 4, 1),
            strategy: 'ta-momentum',
            taMode: mode,
            taSignal: ta.signal,
            rsi: ta.rsi ? parseFloat(ta.rsi.toFixed(1)) : null,
            adx: parseFloat(ta.adx.toFixed(1)),
            bbPosition: parseFloat(ta.bbPosition.toFixed(3)),
            emaTrend: ta.emaTrend,
          });
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 10);
    } catch (err) {
      console.error('[ta-momentum]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.005 && opp.liquidity >= 5000;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [taMomentumStrategy];
