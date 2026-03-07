/**
 * Smart Money Detector
 *
 * Detects large trades on the Polymarket CLOB that indicate informed flow.
 * Uses the CLOB WebSocket trade stream (when available) or REST API fallback.
 *
 * Signal logic:
 *   1. Fetch recent trades for high-volume markets
 *   2. Identify "whale" trades (> $500 or top 5% by size)
 *   3. If multiple large trades are in the same direction within
 *      a short window, that's "smart money consensus"
 *   4. Trade in the direction of the consensus
 *
 * This is a flow-following strategy, not arbitrage.
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');
const gpu = require('../lib/gpu-singleton');

const CLOB_API = 'https://clob.polymarket.com';

async function fetchRecentTrades(tokenId) {
  try {
    const res = await axios.get(`${CLOB_API}/trades`, {
      params: { asset_id: tokenId, limit: 50 },
      timeout: 5000,
    });
    return res.data || [];
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
    prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
  } catch { return null; }
  if (!prices || prices.length < 2) return null;
  return { yes: parseFloat(prices[0]) || 0, no: parseFloat(prices[1]) || 0 };
}

const smartMoneyDetector = {
  name: 'smart-money-detector',
  type: 'flow',
  riskLevel: 'high',

  async scan(bot) {
    const TIMEOUT = 20000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('smart-money timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[smart-money-detector]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const markets = await fetchMarketsOnce();
      const liquid = markets
        .filter(m => {
          if (m.active === false || m.closed) return false;
          return (m.liquidity || 0) >= 20000 && (m.volume || 0) >= 10000;
        })
        .sort((a, b) => (b.volume || 0) - (a.volume || 0))
        .slice(0, 10);

      const opportunities = [];

      for (let i = 0; i < liquid.length; i += 3) {
        const batch = liquid.slice(i, i + 3);
        const results = await Promise.allSettled(batch.map(async m => {
          const tokens = parseTokens(m);
          if (!tokens) return null;

          const trades = await fetchRecentTrades(tokens[0]);
          if (trades.length < 5) return null;

          const sizes = trades.map(t => parseFloat(t.size || t.amount || 0)).filter(s => s > 0);
          if (sizes.length === 0) return null;

          const avgSize = sizes.reduce((a, b) => a + b, 0) / sizes.length;
          const whaleThreshold = Math.max(avgSize * 3, 500);
          const oneHourAgo = Date.now() - 3600000;

          let buyPressure = 0, sellPressure = 0, whaleCount = 0;

          for (const trade of trades) {
            const size = parseFloat(trade.size || trade.amount || 0);
            const ts = trade.timestamp ? new Date(trade.timestamp).getTime() : (trade.match_time ? trade.match_time * 1000 : 0);
            if (ts < oneHourAgo) continue;

            if (size >= whaleThreshold) {
              whaleCount++;
              const side = trade.side || (trade.is_buy ? 'buy' : 'sell');
              if (side === 'buy' || side === 'BUY') buyPressure += size;
              else sellPressure += size;
            }
          }

          if (whaleCount < 2) return null;

          const totalPressure = buyPressure + sellPressure;
          if (totalPressure === 0) return null;

          const buyRatio = buyPressure / totalPressure;
          const dominance = Math.abs(buyRatio - 0.5) * 2;

          if (dominance < 0.3) return null;

          return { market: m, buyRatio, dominance, whaleCount, totalPressure };
        }));

        for (const r of results) {
          if (r.status !== 'fulfilled' || !r.value) continue;
          const { market, buyRatio, dominance, whaleCount, totalPressure } = r.value;

          const prices = parsePrice(market);
          if (!prices) continue;
          if (prices.yes < 0.1 || prices.yes > 0.9) continue;

          const direction = buyRatio > 0.5 ? 'BUY_YES' : 'BUY_NO';
          const rawEdge = dominance * 0.03;
          const netEdge = Math.max(0, rawEdge - 0.004);

          if (netEdge < 0.02) continue;

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice: prices.yes,
            noPrice: prices.no,
            sum: prices.yes + prices.no,
            edge: rawEdge,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min((market.liquidity || 0) * 0.008, 200),
            expectedReturn: netEdge,
            confidence: Math.min(dominance + (whaleCount / 10), 1),
            strategy: 'smart-money-detector',
            whaleCount,
            buyRatio: parseFloat(buyRatio.toFixed(2)),
            dominance: parseFloat(dominance.toFixed(2)),
            totalPressure: Math.round(totalPressure),
          });
        }
      }

      // ── GPU: Edge prediction to filter false positives ──
      if (opportunities.length > 0) {
        try {
          const predictions = await gpu.predictEdge(opportunities.map(o => ({
            edge: o.edgePercent,
            liquidity: o.liquidity,
            volume: o.volume,
            price: o.yesPrice,
            confidence: o.confidence,
            strategy: 'smart-money-detector',
          })));
          if (predictions) {
            for (let i = 0; i < opportunities.length && i < predictions.length; i++) {
              const winProb = predictions[i]?.winProbability || predictions[i]?.win_probability || 0.5;
              opportunities[i].gpuWinProb = winProb;
              // Boost or penalize edge based on GPU model prediction
              if (winProb > 0.6) {
                opportunities[i].edgePercent *= 1 + (winProb - 0.5); // up to 50% boost
              } else if (winProb < 0.35) {
                opportunities[i].edgePercent *= winProb; // heavy penalty for low win prob
              }
            }
          }
        } catch {}
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 8);
    } catch (err) {
      console.error('[smart-money-detector]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.02 && opp.whaleCount >= 2;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [smartMoneyDetector];
