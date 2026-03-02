/**
 * Fundamental strategies (1-6): same-market and structure arbitrage.
 */
const { getOpportunities, toBotOpportunity } = require('./lib/with-scanner');

function makeFundamentalStrategy(name, type, riskLevel, filter = () => true, minEdge = null) {
  return {
    name,
    type: 'fundamental',
    riskLevel,
    async scan(bot) {
      const opps = await getOpportunities(bot, {
        threshold: minEdge ?? bot.edgeThreshold ?? 0.03,
        filter: (market, arb) => filter(market, arb)
      });
      return opps.map(toBotOpportunity);
    },
    async validate(opportunity) {
      return opportunity && typeof opportunity.edgePercent === 'number' && opportunity.edgePercent > 0;
    },
    async execute(bot, opportunity) {
      const opp = toBotOpportunity(opportunity);
      return bot.execute(opp, { size: opp.maxPosition || opportunity.maxPosition });
    }
  };
}

// 1. basic-arbitrage: YES + NO != $1 on Polymarket
const basicArbitrage = makeFundamentalStrategy('basic-arbitrage', 'fundamental', 'low');

// 2. cross-market-arbitrage: REMOVED (stub — duplicated basic-arb without external data)

// 3. resolution-arbitrage (ENDGAME): buy near-certain outcomes (95-99¢) within 72hrs of resolution.
//    548% annualized documented — the highest-yield strategy on Polymarket.
//    Capital rotates fast: 1-5% profit in 1-3 days.
const resolutionArbitrage = {
  name: 'resolution-arbitrage',
  type: 'fundamental',
  riskLevel: 'low',
  async scan(bot) {
    const opps = await getOpportunities(bot, {
      threshold: 0.005,
      filter: (market, arb) => {
        const end = market.endDate ? new Date(market.endDate).getTime() : 0;
        const hoursLeft = (end - Date.now()) / (3600 * 1000);
        if (hoursLeft <= 0 || hoursLeft > 72) return false;

        const y = arb.yesPrice || 0;
        const n = arb.noPrice || 0;
        const highSide = Math.max(y, n);
        if (highSide < 0.93 || highSide > 0.995) return false;

        const discount = 1.0 - highSide;
        return discount >= 0.005;
      }
    });

    return opps.map(o => {
      const base = toBotOpportunity(o);
      const y = base.yesPrice || 0;
      const n = base.noPrice || 0;
      const highSide = Math.max(y, n);
      const discount = 1.0 - highSide;
      const end = o.endDate ? new Date(o.endDate).getTime() : 0;
      const hoursLeft = Math.max(1, (end - Date.now()) / (3600 * 1000));
      const annualized = (discount / (hoursLeft / 8760)) * 100;

      return {
        ...base,
        direction: y >= n ? 'BUY_YES' : 'BUY_NO',
        edgePercent: discount,
        executableEdge: discount,
        expectedReturn: discount,
        hoursLeft: Math.round(hoursLeft),
        annualizedReturn: annualized,
        strategy: 'resolution-arbitrage',
      };
    }).sort((a, b) => b.annualizedReturn - a.annualizedReturn);
  },
  async validate(opp) { return opp && opp.edgePercent >= 0.02; },
  async execute(bot, opp) { return bot.execute(opp, { size: opp.maxPosition }); }
};

module.exports = [
  basicArbitrage,
  resolutionArbitrage,
];
