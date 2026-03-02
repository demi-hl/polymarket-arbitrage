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
const EventCalendar = require('../lib/event-calendar');

const calendar = new EventCalendar();

const CRYPTO_PRICE_PATTERN = /\b(?:bitcoin|btc|ethereum|eth|solana|sol|crypto|doge)\b.*\b(?:price|above|below|between|dip|reach|hit)\b|\b(?:price|above|below|between|dip|reach|hit)\b.*\b(?:bitcoin|btc|ethereum|eth|solana|sol|crypto|doge)\b/i;
const ESPORTS_PATTERN = /\b(?:esports?|lol|league of legends|counter-?strike|cs2|csgo|dota|valorant|overwatch|nongshim|t1|gen\.?g|weibo|fnatic|LoL:|CS2?:)\b/i;

const CRYPTO_PRICE_MAX_POSITION = 50;
const ESPORTS_MAX_POSITION = 50;

const eventCatalystStrategy = {
  name: 'event-catalyst',
  type: 'fundamental',
  riskLevel: 'medium',

  _isCryptoPriceMarket(question) {
    return CRYPTO_PRICE_PATTERN.test(question || '');
  },

  _isEsportsMarket(question, category) {
    return ESPORTS_PATTERN.test(question || '') || ESPORTS_PATTERN.test(category || '');
  },

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

      // Pre-fetch event calendar for resolution boost
      let calendarEvents = [];
      try { calendarEvents = await calendar.fetchUpcomingEvents(); } catch {}

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

        // Zone 1: "Nearly certain" — 88-96% with hours left
        if (highSide >= 0.88 && highSide <= 0.96 && hoursLeft <= 48) {
          const discount = 1.0 - highSide;
          const annualized = (discount / (hoursLeft / 8760)) * 100;
          const timeDecayBonus = Math.max(0, (48 - hoursLeft) / 48) * 0.01;
          let calendarBoost = 0;
          let calendarReason = '';
          try {
            const boost = calendar.getResolutionBoost(market.question, market.endDate);
            calendarBoost = boost.boost || 0;
            calendarReason = boost.reason || '';
          } catch {}

          const rawEdge = discount + timeDecayBonus + calendarBoost;
          const netEdge = Math.max(0, rawEdge - 0.005);

          if (netEdge < 0.02) continue;
          if ((market.liquidity || 0) < 5000) continue;

          const question = market.question || '';
          const category = market.category || market.eventTitle || '';
          const isCrypto = this._isCryptoPriceMarket(question);
          const isEsports = this._isEsportsMarket(question, category);

          if (isCrypto) continue;

          const direction = yesPrice >= noPrice ? 'BUY_YES' : 'BUY_NO';
          let posCap = Math.min((market.liquidity || 0) * 0.01, 150);
          if (isEsports) posCap = Math.min(posCap, ESPORTS_MAX_POSITION);

          opportunities.push({
            marketId: market.id,
            question,
            slug: market.slug,
            category,
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
            maxPosition: posCap,
            expectedReturn: netEdge,
            confidence: Math.min(highSide + (1 - hoursLeft / 48) * 0.1, 1),
            strategy: 'event-catalyst',
            catalystMode: 'certainty-discount',
            hoursLeft: Math.round(hoursLeft),
            annualizedReturn: parseFloat(annualized.toFixed(0)),
            discount: parseFloat(discount.toFixed(4)),
            calendarBoost,
            calendarReason,
            isEsports,
          });
          continue;
        }

        // Zone 2: "Conviction building" — 75-88%, resolution within 12h
        if (highSide >= 0.75 && highSide < 0.88 && hoursLeft <= 12) {
          const conviction = highSide;
          const urgency = 1 - (hoursLeft / 12);
          const rawEdge = (conviction - 0.75) * urgency * 0.2;
          const netEdge = Math.max(0, rawEdge - 0.006);

          if (netEdge < 0.02) continue;
          if ((market.liquidity || 0) < 8000) continue;

          const question = market.question || '';
          const category = market.category || market.eventTitle || '';
          const isCrypto = this._isCryptoPriceMarket(question);
          const isEsports = this._isEsportsMarket(question, category);

          if (isCrypto) continue;

          const direction = yesPrice >= noPrice ? 'BUY_YES' : 'BUY_NO';
          let posCap = Math.min((market.liquidity || 0) * 0.008, 100);
          if (isEsports) posCap = Math.min(posCap, ESPORTS_MAX_POSITION);

          opportunities.push({
            marketId: market.id,
            question,
            slug: market.slug,
            category,
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
            maxPosition: posCap,
            expectedReturn: netEdge,
            confidence: conviction * urgency,
            strategy: 'event-catalyst',
            catalystMode: 'conviction-building',
            hoursLeft: Math.round(hoursLeft),
            conviction: parseFloat(conviction.toFixed(3)),
            urgency: parseFloat(urgency.toFixed(2)),
            isEsports,
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
    return opp && opp.edgePercent >= 0.02 && opp.hoursLeft > 0;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [eventCatalystStrategy];
