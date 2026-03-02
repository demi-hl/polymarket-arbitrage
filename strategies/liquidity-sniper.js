/**
 * Liquidity Gap Sniper
 *
 * Finds markets where the CLOB orderbook has thin levels that can be
 * exploited. Specifically targets:
 *   1. Wide bid-ask spreads with depth on one side only → market order
 *      through the thin side and exit on the thick side
 *   2. Imbalanced books where one side has 3x+ more depth → the heavy
 *      side acts as a wall, making the thin side likely to move
 *   3. Stale limit orders sitting far from mid that can be sniped
 *      when the market moves toward them
 */
const { toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');
const ClobClient = require('../clob-client');

let _clobClient = null;
function getClobClient() {
  if (!_clobClient) _clobClient = new ClobClient();
  return _clobClient;
}

function parseTokens(market) {
  let tokens = market.clobTokenIds;
  if (typeof tokens === 'string') {
    try { tokens = JSON.parse(tokens); } catch { return null; }
  }
  if (!Array.isArray(tokens) || tokens.length < 2) return null;
  return tokens;
}

const liquiditySniper = {
  name: 'liquidity-sniper',
  type: 'flow',
  riskLevel: 'high',

  async scan(bot) {
    const TIMEOUT = 20000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('liquidity-sniper timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[liquidity-sniper]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const clob = getClobClient();
      const markets = await fetchMarketsOnce();
      const opportunities = [];

      const eligible = markets
        .filter(m => {
          if (m.active === false || m.closed) return false;
          return (m.liquidity || 0) >= 5000 && (m.volume || 0) >= 3000;
        })
        .sort((a, b) => (b.volume || 0) - (a.volume || 0))
        .slice(0, 10);

      for (const market of eligible) {
        try {
          const tokens = parseTokens(market);
          if (!tokens) continue;

          const [yesBook, noBook] = await Promise.all([
            clob.getOrderbook(tokens[0]),
            clob.getOrderbook(tokens[1]),
          ]);

          if (!yesBook || !noBook) continue;
          if (!yesBook.bestBid || !yesBook.bestAsk) continue;

          const spread = yesBook.bestAsk - yesBook.bestBid;
          if (spread < 0.02) continue;

          const bidDepth = yesBook.bidDepth || 0;
          const askDepth = yesBook.askDepth || 0;
          if (bidDepth === 0 && askDepth === 0) continue;

          const depthRatio = bidDepth / (askDepth || 1);
          const imbalance = Math.abs(depthRatio - 1);

          if (imbalance < 0.5) continue;

          const thinSide = depthRatio > 1 ? 'ask' : 'bid';
          const direction = thinSide === 'ask' ? 'BUY_YES' : 'BUY_NO';

          const edgeFromSpread = spread * 0.35;
          const edgeFromImbalance = Math.min(imbalance * 0.01, 0.02);
          const rawEdge = edgeFromSpread + edgeFromImbalance;
          const netEdge = Math.max(0, rawEdge - 0.004);

          if (netEdge < 0.02) continue;

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice: yesBook.midpoint,
            noPrice: noBook.midpoint || (1 - yesBook.midpoint),
            sum: yesBook.midpoint + (noBook.midpoint || (1 - yesBook.midpoint)),
            edge: rawEdge,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min(Math.min(bidDepth, askDepth) * 0.3, 150),
            expectedReturn: netEdge,
            confidence: Math.min(imbalance / 3, 1),
            strategy: 'liquidity-sniper',
            spread: parseFloat(spread.toFixed(4)),
            depthRatio: parseFloat(depthRatio.toFixed(2)),
            thinSide,
            bidDepth: Math.round(bidDepth),
            askDepth: Math.round(askDepth),
          });
        } catch { continue; }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 8);
    } catch (err) {
      console.error('[liquidity-sniper]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.02 && opp.spread >= 0.02;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [liquiditySniper];
