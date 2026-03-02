/**
 * Flow-based strategies: orderbook-scalper.
 * whale-tracker removed (Polymarket subgraph dropped `pnls` field).
 */
const { toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');
const ClobClient = require('../clob-client');

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
