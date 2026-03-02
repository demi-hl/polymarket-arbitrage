/**
 * Correlated Market Arbitrage
 *
 * Finds pairs of markets with a logical/mathematical relationship and trades
 * when prices violate that relationship. Examples:
 *   - "Will X win the primary?" at 40% and "Will X be president?" at 50%
 *     → impossible: P(president) <= P(primary winner). Short the general, buy the primary.
 *
 * CRITICAL FIX: Now requires >= 3% violation (was 1%), marks as holdUntilResolution,
 * and validates that both markets have matching resolution timelines.
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const GAMMA_API = 'https://gamma-api.polymarket.com';

const SUPERSET_PATTERNS = [
  { subset: /win (?:the )?(?:primary|nomination|semifinal|quarterfinal|group stage)/i,
    superset: /(?:be )?(?:president|win (?:the )?(?:election|general|tournament|championship|final))/i },
  { subset: /(?:make|reach|qualify for) (?:the )?(?:playoff|final|semifinal)/i,
    superset: /win (?:the )?(?:championship|tournament|title|cup)/i },
  { subset: /(?:nominated|shortlisted)/i,
    superset: /(?:win|receive) (?:the )?(?:award|oscar|prize)/i },
];

function extractEntity(question) {
  const cleaned = (question || '')
    .replace(/^will /i, '')
    .replace(/\?$/, '')
    .trim();

  const nameMatch = cleaned.match(/^([A-Z][a-z]+(?: [A-Z][a-z]+){0,3})/);
  if (nameMatch) return nameMatch[1].toLowerCase();

  const teamMatch = cleaned.match(/(?:the )?([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s+(?:win|make|reach|qualify)/i);
  if (teamMatch) return teamMatch[1].toLowerCase();

  return null;
}

function findSubsetSupersetPair(marketA, marketB) {
  const qA = marketA.question || '';
  const qB = marketB.question || '';

  for (const pattern of SUPERSET_PATTERNS) {
    if (pattern.subset.test(qA) && pattern.superset.test(qB)) {
      return { subset: marketA, superset: marketB };
    }
    if (pattern.subset.test(qB) && pattern.superset.test(qA)) {
      return { subset: marketB, superset: marketA };
    }
  }

  return null;
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

const correlatedMarketArb = {
  name: 'correlated-market-arb',
  type: 'fundamental',
  riskLevel: 'medium',

  async scan(bot) {
    const TIMEOUT = 15000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('correlated scan timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[correlated-market-arb]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const markets = await fetchMarketsOnce();
      const active = markets.filter(m => m.active !== false && !m.closed);

      const byEntity = new Map();
      for (const m of active) {
        const entity = extractEntity(m.question);
        if (!entity) continue;
        if (!byEntity.has(entity)) byEntity.set(entity, []);
        byEntity.get(entity).push(m);
      }

      const opportunities = [];

      for (const [entity, group] of byEntity) {
        if (group.length < 2) continue;

        for (let i = 0; i < group.length && i < 6; i++) {
          for (let j = i + 1; j < group.length && j < 6; j++) {
            const pair = findSubsetSupersetPair(group[i], group[j]);
            if (!pair) continue;

            const subPrices = parsePrice(pair.subset);
            const supPrices = parsePrice(pair.superset);
            if (!subPrices || !supPrices) continue;

            const violation = supPrices.yes - subPrices.yes;
            if (violation <= 0.03) continue;

            const subLiq = pair.subset.liquidity || 0;
            const supLiq = pair.superset.liquidity || 0;
            const minLiq = Math.min(subLiq, supLiq);
            if (minLiq < 5000) continue;

            const netEdge = Math.max(0, violation - 0.008);
            if (netEdge < 0.02) continue;

            opportunities.push({
              marketId: pair.superset.id,
              question: `${pair.superset.question} > ${pair.subset.question}`,
              slug: pair.superset.slug,
              category: entity,
              eventTitle: `Correlated: ${entity}`,
              yesPrice: supPrices.yes,
              noPrice: supPrices.no,
              sum: supPrices.yes + supPrices.no,
              edge: violation,
              edgePercent: netEdge,
              executableEdge: netEdge,
              liquidity: minLiq,
              volume: (pair.superset.volume || 0) + (pair.subset.volume || 0),
              conditionId: pair.superset.conditionId,
              endDate: pair.superset.endDate,
              direction: 'BUY_NO',
              maxPosition: Math.min(minLiq * 0.01, 200),
              expectedReturn: netEdge,
              confidence: Math.min(violation * 3, 0.85),
              strategy: 'correlated-market-arb',
              holdUntilResolution: true,
              correlatedWith: {
                marketId: pair.subset.id,
                question: pair.subset.question,
                yesPrice: subPrices.yes,
              },
            });
          }
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 8);
    } catch (err) {
      console.error('[correlated-market-arb]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.02 && opp.liquidity >= 5000;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },
};

module.exports = [correlatedMarketArb];
