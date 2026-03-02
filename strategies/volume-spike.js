/**
 * Volume Spike Detector
 *
 * Detects markets where recent activity indicates informed flow:
 *   - Volume significantly higher than the historical average
 *   - Price has moved meaningfully (> 5 cents) in a direction
 *
 * Trades in the direction of the move, following the smart money.
 * This is a momentum/information-asymmetry strategy, not pure arbitrage.
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchMarketHistory(conditionId) {
  try {
    const res = await axios.get(`${GAMMA_API}/markets/${conditionId}/timeseries`, {
      params: { interval: 'hour', fidelity: 24 },
      timeout: 4000,
    });
    return res.data || [];
  } catch {
    return [];
  }
}

function parsePrice(market) {
  let prices;
  try {
    prices = typeof market.outcomePrices === 'string' ? JSON.parse(market.outcomePrices) : market.outcomePrices;
  } catch { return null; }
  if (!prices || prices.length < 2) return null;
  const yes = parseFloat(prices[0]) || 0;
  const no = parseFloat(prices[1]) || 0;
  if (yes <= 0 || yes >= 1) return null;
  return { yes, no };
}

const volumeSpikeDetector = {
  name: 'volume-spike-detector',
  type: 'flow',
  riskLevel: 'high',

  async scan(bot) {
    const TIMEOUT = 20000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('volume-spike scan timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[volume-spike-detector]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const markets = await fetchMarketsOnce();
      const active = markets.filter(m => {
        if (m.active === false || m.closed) return false;
        const liq = m.liquidity || 0;
        const vol = m.volume || 0;
        return liq >= 5000 && vol >= 10000;
      });

      active.sort((a, b) => (b.volume || 0) - (a.volume || 0));
      const candidates = active.slice(0, 15);

      const opportunities = [];

      const batchSize = 5;
      for (let i = 0; i < candidates.length; i += batchSize) {
        const batch = candidates.slice(i, i + batchSize);
        const histories = await Promise.allSettled(
          batch.map(m => fetchMarketHistory(m.conditionId))
        );

        for (let j = 0; j < batch.length; j++) {
          const market = batch[j];
          const histResult = histories[j];
          if (histResult.status !== 'fulfilled') continue;
          const history = histResult.value;
          if (!Array.isArray(history) || history.length < 6) continue;

          const prices = parsePrice(market);
          if (!prices) continue;

          const recent = history.slice(-3);
          const older = history.slice(0, -3);

          if (older.length === 0) continue;

          const recentVol = recent.reduce((s, h) => s + (h.volume || 0), 0);
          const olderAvgVol = older.reduce((s, h) => s + (h.volume || 0), 0) / older.length;
          const avgPeriodVol = olderAvgVol * recent.length;

          if (avgPeriodVol <= 0) continue;
          const volumeRatio = recentVol / avgPeriodVol;
          if (volumeRatio < 3) continue;

          const oldPrice = parseFloat(older[older.length - 1]?.price || older[older.length - 1]?.yes || 0);
          const currentPrice = prices.yes;
          const priceMove = currentPrice - oldPrice;
          const absPriceMove = Math.abs(priceMove);

          if (absPriceMove < 0.04) continue;

          if (currentPrice < 0.08 || currentPrice > 0.92) continue;

          const edge = absPriceMove * 0.3;
          const netEdge = Math.max(0, edge - 0.005);
          if (netEdge < 0.005) continue;

          const direction = priceMove > 0 ? 'BUY_YES' : 'BUY_NO';

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
            confidence: Math.min(volumeRatio / 10, 1),
            strategy: 'volume-spike-detector',
            volumeRatio: parseFloat(volumeRatio.toFixed(1)),
            priceMove: parseFloat(priceMove.toFixed(3)),
            recentVolume: Math.round(recentVol),
          });
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 10);
    } catch (err) {
      console.error('[volume-spike-detector]', err.message);
      return [];
    }
  },


  async validate(opp) {
    return opp && opp.edgePercent >= 0.005 && opp.volumeRatio >= 3;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [volumeSpikeDetector];
