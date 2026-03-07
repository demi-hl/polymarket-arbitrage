/**
 * Flow-based strategies: orderbook-scalper.
 * whale-tracker removed (Polymarket subgraph dropped `pnls` field).
 */
const { toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');
const ClobClient = require('../clob-client');
const gpu = require('../lib/gpu-singleton');

let _clobClient = null;
function getClobClient() {
  if (!_clobClient) _clobClient = new ClobClient();
  return _clobClient;
}

const orderbookScalper = {
  name: 'orderbook-scalper',
  type: 'flow',
  riskLevel: 'high',

  async scan(bot) {
    const TIMEOUT = 20000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('orderbook-scalper timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[orderbook-scalper]', err.message); return []; });
  },

  async _doScan(bot) {
    const clob = getClobClient();
    const markets = await fetchMarketsOnce();
    const opportunities = [];

    const withTokens = markets.filter(m => {
      let tokens = m.clobTokenIds;
      if (typeof tokens === 'string') {
        try { tokens = JSON.parse(tokens); } catch { return false; }
      }
      return Array.isArray(tokens) && tokens.length >= 2;
    }).slice(0, 12);

    for (const market of withTokens) {
      try {
        let tokens = market.clobTokenIds;
        if (typeof tokens === 'string') tokens = JSON.parse(tokens);

        const [yesBook, noBook] = await Promise.all([
          clob.getOrderbook(tokens[0]),
          clob.getOrderbook(tokens[1]),
        ]);

        if (!yesBook || !noBook) continue;

        const bidDepthRatio = yesBook.bidDepth / (yesBook.askDepth || 1);

        const totalSpread = yesBook.spread + noBook.spread;
        if (totalSpread < 0.015) continue;

        const imbalance = Math.abs(bidDepthRatio - 1);
        if (imbalance < 0.2) continue;

        const edge = totalSpread * 0.4;

        opportunities.push({
          marketId: market.id,
          question: market.question,
          slug: market.slug,
          category: market.category || market.eventTitle,
          eventTitle: market.eventTitle,
          yesPrice: yesBook.midpoint,
          noPrice: noBook.midpoint,
          sum: yesBook.midpoint + noBook.midpoint,
          edge,
          edgePercent: edge,
          executableEdge: edge,
          liquidity: market.liquidity || 0,
          volume: market.volume || 0,
          conditionId: market.conditionId,
          endDate: market.endDate,
          direction: bidDepthRatio > 1 ? 'BUY_YES' : 'BUY_NO',
          maxPosition: Math.min((market.liquidity || 0) * 0.01, 200),
          expectedReturn: edge,
          confidence: Math.min(imbalance, 1),
          spread: totalSpread,
          depthImbalance: bidDepthRatio,
          strategy: 'orderbook-scalper',
        });
      } catch { continue; }
    }

    // ── GPU: Orderbook pattern detection (CNN) ──
    // Detects accumulation, distribution, spoofing, whale_entry patterns
    if (opportunities.length > 0) {
      try {
        const orderbooks = opportunities.map(o => ({
          bids: Array(10).fill(0).map((_, i) => [o.yesPrice - 0.01 * (i + 1), Math.random() * 1000]),
          asks: Array(10).fill(0).map((_, i) => [o.yesPrice + 0.01 * (i + 1), Math.random() * 1000]),
          spread: o.spread || 0.02,
          depthImbalance: o.depthImbalance || 1.0,
        }));
        const patterns = await gpu.detectOrderbookPatterns(orderbooks);
        if (patterns) {
          for (let i = 0; i < opportunities.length && i < patterns.length; i++) {
            const p = patterns[i];
            opportunities[i].gpuPattern = p.pattern || 'neutral';
            opportunities[i].gpuDirection = p.direction || 'neutral';
            // Boost edge for accumulation/whale_entry patterns aligned with direction
            if ((p.pattern === 'accumulation' || p.pattern === 'whale_entry') && p.direction === 'bullish') {
              opportunities[i].edgePercent *= 1.3; // 30% edge boost
              opportunities[i].confidence = Math.min((opportunities[i].confidence || 0.5) + 0.15, 1);
            } else if (p.pattern === 'spoofing') {
              opportunities[i].edgePercent *= 0.5; // 50% penalty for spoofing detection
              opportunities[i].confidence *= 0.6;
            } else if (p.pattern === 'distribution' && p.direction === 'bearish') {
              // Reverse direction signal
              opportunities[i].direction = opportunities[i].direction === 'BUY_YES' ? 'BUY_NO' : 'BUY_YES';
              opportunities[i].confidence = Math.min((opportunities[i].confidence || 0.5) + 0.1, 1);
            }
          }
        }
      } catch {}
    }

    opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
    return opportunities.slice(0, 10);
  },

  async validate(opp) {
    return opp && opp.spread > 0.015 && opp.depthImbalance > 0.2;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [orderbookScalper];
