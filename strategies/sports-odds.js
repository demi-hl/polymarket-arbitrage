/**
 * Sports Odds Arbitrage Strategy
 *
 * Cross-references Polymarket sports markets against established sportsbook
 * odds from The Odds API. Sharp sportsbooks (Pinnacle, Betfair) have
 * efficient pricing — Polymarket sports markets are often mispriced
 * relative to these benchmarks.
 *
 * Edge sources:
 * - Pinnacle/Betfair efficient market pricing vs Polymarket retail pricing
 * - Opening line movements that haven't propagated to prediction markets
 * - Injury/roster news reflected in sportsbooks but not yet in PM
 * - Tournament/playoff bracket math vs market-implied probabilities
 */

const axios = require('axios');
const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

const SPORTS_KEYWORDS = [
  'nba', 'nfl', 'mlb', 'nhl', 'mls', 'premier league', 'champions league',
  'super bowl', 'world series', 'stanley cup', 'finals', 'playoff',
  'championship', 'mvp', 'winner', 'title', 'trophy', 'seed',
  'ufc', 'mma', 'fight', 'boxing', 'bout',
  'tennis', 'grand slam', 'wimbledon', 'us open', 'french open',
  'f1', 'formula 1', 'nascar', 'race', 'qualifying',
  'world cup', 'euro', 'copa', 'olympics', 'medal',
  'march madness', 'ncaa', 'college', 'bowl game',
  'cricket', 'ipl', 'ashes', 'rugby',
  'esports', 'league of legends', 'dota', 'cs2', 'valorant',
  'game', 'match', 'series', 'sweep', 'overtime',
  'points', 'goals', 'touchdowns', 'runs', 'score',
];

// The Odds API (free tier: 500 requests/month)
const ODDS_API = 'https://api.the-odds-api.com/v4';
const ODDS_KEY = process.env.ODDS_API_KEY || '';

let _oddsCache = { data: null, ts: 0 };
const ODDS_TTL = 300_000; // 5 min cache

// Sport key mapping for The Odds API
const SPORT_KEYS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_uefa_champs_league',
  'mma_mixed_martial_arts',
  'tennis_atp_french_open',
  'tennis_atp_us_open',
  'tennis_atp_wimbledon',
];

/**
 * Fetch odds from The Odds API
 */
async function fetchSportsbookOdds() {
  if (_oddsCache.data && Date.now() - _oddsCache.ts < ODDS_TTL) return _oddsCache.data;
  if (!ODDS_KEY) return buildFallbackOdds();

  const allOdds = {};

  try {
    // Fetch from multiple sports in parallel
    const fetches = SPORT_KEYS.slice(0, 4).map(sport =>
      axios.get(`${ODDS_API}/sports/${sport}/odds`, {
        params: {
          apiKey: ODDS_KEY,
          regions: 'us,eu',
          markets: 'h2h,outrights',
          bookmakers: 'pinnacle,betfair_ex_eu,draftkings,fanduel',
        },
        timeout: 8000,
      }).catch(() => null)
    );

    const results = await Promise.all(fetches);

    for (const res of results) {
      if (!res?.data) continue;
      for (const event of res.data) {
        const key = normalizeTeamName(event.home_team) + ' vs ' + normalizeTeamName(event.away_team);
        const pinnacle = event.bookmakers?.find(b => b.key === 'pinnacle');
        const bestBook = pinnacle || event.bookmakers?.[0];

        if (!bestBook) continue;

        const h2h = bestBook.markets?.find(m => m.key === 'h2h');
        if (!h2h?.outcomes) continue;

        allOdds[key] = {
          home: event.home_team,
          away: event.away_team,
          sport: event.sport_key,
          commence: event.commence_time,
          outcomes: h2h.outcomes.map(o => ({
            name: o.name,
            price: americanToDecimal(o.price),
            impliedProb: 1 / americanToDecimal(o.price),
          })),
          source: bestBook.key,
        };
      }
    }
  } catch {}

  _oddsCache = { data: allOdds, ts: Date.now() };
  return allOdds;
}

/**
 * Build fallback odds from historical base rates when no API key
 */
function buildFallbackOdds() {
  return {
    __fallback: true,
    // Home team advantage base rates by sport
    baseRates: {
      nba: 0.58, nfl: 0.57, mlb: 0.54, nhl: 0.55,
      soccer: 0.46, // Home advantage less in soccer
      mma: 0.50, tennis: 0.50, // No home advantage
    },
  };
}

/**
 * Convert American odds to decimal
 */
function americanToDecimal(odds) {
  if (typeof odds !== 'number') return 2.0;
  if (odds > 0) return (odds / 100) + 1;
  return (100 / Math.abs(odds)) + 1;
}

/**
 * Normalize team names for matching
 */
function normalizeTeamName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\b(the|fc|cf|sc|afc|united|city|real|inter|ac)\b/gi, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Try to match a Polymarket sports market to sportsbook odds
 */
function matchMarketToOdds(marketText, odds) {
  if (odds.__fallback) return null;

  const normalized = normalizeTeamName(marketText);

  let bestMatch = null;
  let bestScore = 0;

  for (const [key, data] of Object.entries(odds)) {
    const homeNorm = normalizeTeamName(data.home);
    const awayNorm = normalizeTeamName(data.away);

    let score = 0;
    if (normalized.includes(homeNorm) && homeNorm.length > 3) score += homeNorm.length;
    if (normalized.includes(awayNorm) && awayNorm.length > 3) score += awayNorm.length;

    // Check individual team name parts
    for (const part of homeNorm.split(' ')) {
      if (part.length > 3 && normalized.includes(part)) score += 2;
    }
    for (const part of awayNorm.split(' ')) {
      if (part.length > 3 && normalized.includes(part)) score += 2;
    }

    if (score > bestScore && score >= 6) {
      bestScore = score;
      bestMatch = data;
    }
  }

  return bestMatch;
}

const sportsOddsStrategy = {
  name: 'sports-odds-arb',
  type: 'sports',
  riskLevel: 'low',

  async scan(bot) {
    const [markets, odds] = await Promise.all([
      fetchMarketsOnce(),
      fetchSportsbookOdds(),
    ]);
    if (!markets || markets.length === 0) return [];

    const sportsMarkets = markets.filter(m => {
      const text = (m.question || m.title || '').toLowerCase() + ' ' + (m.description || '').toLowerCase();
      return SPORTS_KEYWORDS.some(kw => text.includes(kw));
    });

    const opportunities = [];

    for (const market of sportsMarkets) {
      try {
        const text = market.question || market.title || '';
        const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
        if (yesPrice <= 0.02 || yesPrice >= 0.98) continue;

        const matchedOdds = matchMarketToOdds(text, odds);
        if (!matchedOdds) continue;

        // Find the relevant outcome
        let modelProbability = null;
        const textLower = text.toLowerCase();

        for (const outcome of matchedOdds.outcomes) {
          const outcomeLower = normalizeTeamName(outcome.name);
          if (textLower.includes(outcomeLower) || outcomeLower.split(' ').some(p => p.length > 3 && textLower.includes(p))) {
            // Remove vig: normalize probabilities to sum to 1
            const totalImplied = matchedOdds.outcomes.reduce((sum, o) => sum + o.impliedProb, 0);
            modelProbability = outcome.impliedProb / totalImplied;
            break;
          }
        }

        if (modelProbability === null) continue;
        modelProbability = Math.max(0.02, Math.min(0.98, modelProbability));

        const edge = modelProbability - yesPrice;
        const absEdge = Math.abs(edge);
        if (absEdge < 0.02) continue; // Lower threshold for sports — sportsbook odds are very reliable

        const side = edge > 0 ? 'YES' : 'NO';
        const confidence = Math.min(absEdge * 10, 0.95); // High confidence — sportsbooks are sharp

        opportunities.push({
          type: 'sports-odds-mispricing',
          market: text.slice(0, 120),
          conditionId: market.conditionId || market.id,
          tokenId: market.clobTokenIds?.[edge > 0 ? 0 : 1],
          side,
          currentPrice: edge > 0 ? yesPrice : (1 - yesPrice),
          modelPrice: edge > 0 ? modelProbability : (1 - modelProbability),
          edge: absEdge,
          edgePercent: (absEdge * 100).toFixed(1) + '%',
          expectedReturn: absEdge,
          confidence,
          source: `sportsbook-${matchedOdds.source}`,
          liquidity: parseFloat(market.volume || market.liquidityClob || 0),
          maxPosition: Math.min(absEdge * 800, 200), // Higher sizing — sportsbook odds are reliable
          executionSpeed: 0.7,
        });
      } catch {}
    }

    return opportunities;
  },

  async validate(opp) {
    return opp && opp.edge > 0.02 && opp.confidence > 0.2;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [sportsOddsStrategy];
