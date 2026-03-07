/**
 * Whale Flow Strategy
 *
 * Real-time orderflow-based strategy that piggybacks on whale consensus.
 * Wraps OrderflowWatcher signals into the standard strategy interface.
 *
 * Signal: 3+ whale trades ($500+) in same direction within 5 minutes
 * Edge: whale dominance * 4% max, minus fees
 * Position: min(liquidity * 0.8%, $200)
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');
const gpu = require('../lib/gpu-singleton');

let _watcher = null;
function setOrderflowWatcher(watcher) { _watcher = watcher; }
function getOrderflowWatcher() { return _watcher; }

function parsePrice(market) {
  let prices;
  try {
    prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
  } catch { return null; }
  if (!prices || prices.length < 2) return null;
  return { yes: parseFloat(prices[0]) || 0, no: parseFloat(prices[1]) || 0 };
}

const whaleFlowStrategy = {
  name: 'whale-flow',
  type: 'flow',
  riskLevel: 'high',

  async scan(bot) {
    if (!_watcher) return [];
    const TIMEOUT = 10000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('whale-flow timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[whale-flow]', err.message); return []; });
  },

  async _doScan(_bot) {
    const consensusSignals = _watcher.drainSignals();
    if (consensusSignals.length === 0) return [];

    // Build token → market lookup
    let markets;
    try {
      markets = await fetchMarketsOnce();
    } catch { return []; }

    const marketByToken = new Map();
    for (const m of markets) {
      let tokens = m.clobTokenIds;
      if (typeof tokens === 'string') try { tokens = JSON.parse(tokens); } catch { continue; }
      if (Array.isArray(tokens)) {
        for (const t of tokens) marketByToken.set(t, m);
      }
    }

    const opportunities = [];

    for (const signal of consensusSignals) {
      const market = marketByToken.get(signal.assetId);
      if (!market) continue;
      if (market.active === false || market.closed) continue;

      const prices = parsePrice(market);
      if (!prices) continue;
      if (prices.yes < 0.08 || prices.yes > 0.92) continue;

      // Edge: whale directional dominance * 4% max
      const dominance = Math.abs(signal.buyRatio - 0.5) * 2;
      const volumeBoost = Math.min(signal.totalVolume / 50000, 0.5); // up to 0.5% extra for high volume
      const rawEdge = dominance * 0.04 + volumeBoost * 0.01;
      const netEdge = Math.max(0, rawEdge - 0.005); // subtract fees
      if (netEdge < 0.02) continue;

      // Liquidity check
      const liquidity = market.liquidity || 0;
      if (liquidity < 5000) continue;

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
        liquidity,
        volume: market.volume || 0,
        conditionId: market.conditionId,
        endDate: market.endDate,
        direction: signal.direction,
        maxPosition: Math.min(liquidity * 0.008, 200),
        expectedReturn: netEdge,
        confidence: Math.min(dominance + (signal.whaleCount / 10), 1),
        strategy: 'whale-flow',
        whaleCount: signal.whaleCount,
        weightedCount: signal.weightedCount,
        buyRatio: parseFloat(signal.buyRatio.toFixed(3)),
        totalVolume: Math.round(signal.totalVolume),
        dominantVolume: Math.round(signal.dominantVolume),
        signalType: 'realtime-consensus',
        clobTokenIds: market.clobTokenIds,
      });
    }

    // ── GPU: Edge prediction to validate whale signals ──
    if (opportunities.length > 0) {
      try {
        const predictions = await gpu.predictEdge(opportunities.map(o => ({
          edge: o.edgePercent,
          liquidity: o.liquidity,
          volume: o.volume,
          price: o.yesPrice,
          confidence: o.confidence,
          whaleCount: o.whaleCount,
          buyRatio: o.buyRatio,
          totalVolume: o.totalVolume,
          strategy: 'whale-flow',
        })));
        if (predictions) {
          for (let i = 0; i < opportunities.length && i < predictions.length; i++) {
            const winProb = predictions[i]?.winProbability || predictions[i]?.win_probability || 0.5;
            opportunities[i].gpuWinProb = winProb;
            if (winProb > 0.65) {
              opportunities[i].edgePercent *= 1.25; // GPU confirms whale signal
              opportunities[i].maxPosition = Math.min(opportunities[i].maxPosition * 1.3, 250);
            } else if (winProb < 0.3) {
              opportunities[i].edgePercent *= 0.4; // GPU rejects signal
            }
          }
        }
      } catch {}
    }

    opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
    return opportunities.slice(0, 5);
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.02 && opp.whaleCount >= 3;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = { strategies: [whaleFlowStrategy], setOrderflowWatcher, getOrderflowWatcher };
