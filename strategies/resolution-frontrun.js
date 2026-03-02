/**
 * Resolution Front-Running Strategy
 *
 * Uses the UMA Oracle Monitor to detect markets about to resolve.
 * When a resolution proposal is submitted to UMA, there's a ~2 hour
 * liveness period before finalization. During this window, the market
 * price hasn't fully converged to $1 on the winning side.
 *
 * This strategy buys the proposed winning outcome at a discount,
 * holds until resolution, and collects the spread.
 *
 * Also detects "near-resolution" markets: <6 hours to close with
 * one side priced >95%. These have high probability of resolving
 * to the favored side.
 *
 * Risk: proposals can be disputed (rare, ~2% of the time).
 * Mitigation: conservative position sizing and only entering when
 * the discount exceeds 2%.
 */
const UmaOracleMonitor = require('../lib/uma-oracle-monitor');

let _monitor = null;
let _monitorStarted = false;

function getMonitor() {
  if (!_monitor) {
    _monitor = new UmaOracleMonitor();
  }
  if (!_monitorStarted) {
    _monitor.start();
    _monitorStarted = true;
  }
  return _monitor;
}

const resolutionFrontrun = {
  name: 'resolution-frontrun',
  type: 'fundamental',
  riskLevel: 'low',

  async scan(bot) {
    try {
      const monitor = getMonitor();
      const opportunities = monitor.toOpportunities();

      return opportunities
        .filter(opp => opp.edgePercent >= 0.02)
        .sort((a, b) => b.edgePercent - a.edgePercent)
        .slice(0, 10);
    } catch (err) {
      console.error('[resolution-frontrun]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp &&
      opp.edgePercent >= 0.02 &&
      opp.confidence >= 0.7 &&
      opp.liquidity >= 3000;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [resolutionFrontrun];
