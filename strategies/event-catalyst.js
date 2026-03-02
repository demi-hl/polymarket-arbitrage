/**
 * Event Catalyst Strategy
 *
 * Identifies markets approaching known catalysts (resolution dates,
 * scheduled events) where prices haven't yet reflected the time pressure.
 *
 * Key insight: markets with resolution dates within 24-72 hours often
 * underprice certainty. As time runs out, prices converge rapidly to
 * 0 or 1. This strategy buys the heavily-favored side when:
 *   - Resolution is within 72 hours
 *   - One side is priced above 75% (high conviction but not yet 95%+)
 *   - Liquidity is sufficient for exit
 *   - The "discount to certainty" exceeds transaction costs
 *
 * Also detects "momentum acceleration" — markets where the favored side
 * has been steadily climbing and resolution is near.
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');

const eventCatalystStrategy = {
  name: 'event-catalyst',
  type: 'fundamental',
  riskLevel: 'medium',

  async scan(bot) {
    const TIMEOUT = 15000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('event-catalyst timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[event-catalyst]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const markets = await fetchMarketsOnce();
      const now = Date.now();
      const opportunities = [];

      for (const market of markets) {
        if (market.active === false || market.closed) continue;

        const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
        if (endDate <= now) continue;

        const hoursLeft = (endDate - now) / (3600 * 1000);
        if (hoursLeft > 72 || hoursLeft < 1) continue;

        let prices;
        try {
          prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
        } catch { continue; }
        if (!prices || prices.length < 2) continue;

        const yesPrice = parseFloat(prices[0]) || 0;
        const noPrice = parseFloat(prices[1]) || 0;
        if (yesPrice <= 0 || yesPrice >= 1) continue;

        const highSide = Math.max(yesPrice, noPrice);
        const lowSide = Math.min(yesPrice, noPrice);

        // Zone 1: "Nearly certain" — 85-96% with hours left
        if (highSide >= 0.85 && highSide <= 0.96 && hoursLeft <= 48) {
          const discount = 1.0 - highSide;
          const annualized = (discount / (hoursLeft / 8760)) * 100;
          const timeDecayBonus = Math.max(0, (48 - hoursLeft) / 48) * 0.01;
          const rawEdge = discount + timeDecayBonus;
          const netEdge = Math.max(0, rawEdge - 0.004);

          if (netEdge < 0.005) continue;
          if ((market.liquidity || 0) < 3000) continue;

          const direction = yesPrice >= noPrice ? 'BUY_YES' : 'BUY_NO';

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice, noPrice,
            sum: yesPrice + noPrice,
            edge: rawEdge,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min((market.liquidity || 0) * 0.02, 300),
            expectedReturn: netEdge,
            confidence: Math.min(highSide + (1 - hoursLeft / 48) * 0.1, 1),
            strategy: 'event-catalyst',
            catalystMode: 'certainty-discount',
            hoursLeft: Math.round(hoursLeft),
            annualizedReturn: parseFloat(annualized.toFixed(0)),
            discount: parseFloat(discount.toFixed(4)),
          });
          continue;
        }

        // Zone 2: "Conviction building" — 70-85%, resolution within 24h
        if (highSide >= 0.70 && highSide < 0.85 && hoursLeft <= 24) {
          const conviction = highSide;
          const urgency = 1 - (hoursLeft / 24);
          const rawEdge = (conviction - 0.70) * urgency * 0.15;
          const netEdge = Math.max(0, rawEdge - 0.005);

          if (netEdge < 0.005) continue;
          if ((market.liquidity || 0) < 5000) continue;

          const direction = yesPrice >= noPrice ? 'BUY_YES' : 'BUY_NO';

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice, noPrice,
            sum: yesPrice + noPrice,
            edge: rawEdge,
            edgePercent: netEdge,
            executableEdge: netEdge,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min((market.liquidity || 0) * 0.015, 200),
            expectedReturn: netEdge,
            confidence: conviction * urgency,
            strategy: 'event-catalyst',
            catalystMode: 'conviction-building',
            hoursLeft: Math.round(hoursLeft),
            conviction: parseFloat(conviction.toFixed(3)),
            urgency: parseFloat(urgency.toFixed(2)),
          });
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 12);
    } catch (err) {
      console.error('[event-catalyst]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.005 && opp.hoursLeft > 0;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [eventCatalystStrategy];
