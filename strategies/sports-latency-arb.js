/**
 * Sports Latency Arbitrage Strategy
 *
 * Exploits the 15-40 second delay between real-time sports events and when
 * Polymarket odds update. TV broadcasts run behind live stadium data feeds.
 * Traders watching broadcasts react late — the bot reacts instantly.
 *
 * Architecture:
 *   1. Real-time sports data via API (Sportradar, The Odds API live scores,
 *      ESPN rapid API) — zero broadcast delay
 *   2. Map live events to Polymarket sports markets
 *   3. When a score-changing event happens (goal, touchdown, run, etc.),
 *      compute new fair probability BEFORE the market reprices
 *   4. Buy underpriced shares in the 15-40 second window
 *   5. Exit when market catches up to reality
 *
 * The swisstony pattern: $5 → $4.7M on 50k trades exploiting this exact gap.
 * Average profit per trade: ~$92 (varies by sport and event magnitude).
 *
 * Risk: high — requires fast execution, stale data can cause losses,
 *        and Polymarket may eventually close the latency gap.
 */

const axios = require('axios');
const EventEmitter = require('events');
const { fetchMarketsOnce, toBotOpportunity } = require('./lib/with-scanner');
const gpu = require('../lib/gpu-singleton');

// ── Configuration ──────────────────────────────────────────────────────

const ODDS_API_KEY = process.env.ODDS_API_KEY || '';
const SPORTRADAR_KEY = process.env.SPORTRADAR_API_KEY || '';
const ESPN_RAPID_KEY = process.env.ESPN_RAPID_KEY || '';

// How often to poll live scores (lower = more aggressive but more API calls)
const LIVE_POLL_MS = parseInt(process.env.SPORTS_LATENCY_POLL_MS || '5000');  // 5s default
const SIGNAL_DECAY_MS = 45_000;  // Signal expires after 45s (broadcast catches up)
const MIN_EDGE = 0.04;           // 4% minimum edge to trade
const MIN_LIQUIDITY = 5000;      // $5k minimum market liquidity
const MAX_SIGNALS = 20;
const MAX_POSITION = 200;        // $200 max per trade (like swisstony: small but frequent)

// Sports event categories and their broadcast delays
const BROADCAST_DELAYS = {
  basketball: { avg: 20, max: 35 },  // NBA/NCAAB
  football:   { avg: 25, max: 40 },  // NFL
  soccer:     { avg: 15, max: 30 },  // EPL/UCL
  baseball:   { avg: 20, max: 35 },  // MLB
  hockey:     { avg: 18, max: 30 },  // NHL
  mma:        { avg: 10, max: 20 },  // UFC — shorter delay
  tennis:     { avg: 12, max: 25 },
};

// Keywords for identifying sports markets on Polymarket
const SPORT_PATTERNS = {
  basketball: /\b(nba|ncaa|basketball|lakers|celtics|warriors|bucks|nuggets|76ers|knicks|heat|suns|march madness)\b/i,
  football:   /\b(nfl|super bowl|touchdown|quarterback|chiefs|eagles|49ers|cowboys|ravens|lions)\b/i,
  soccer:     /\b(premier league|champions league|epl|ucl|la liga|serie a|bundesliga|world cup|euro|copa|goal)\b/i,
  baseball:   /\b(mlb|world series|baseball|yankees|dodgers|braves|astros|phillies)\b/i,
  hockey:     /\b(nhl|stanley cup|hockey|bruins|panthers|oilers|rangers)\b/i,
  mma:        /\b(ufc|mma|fight|bout|knockout|submission|octagon)\b/i,
  tennis:     /\b(atp|wta|wimbledon|us open|french open|australian open|grand slam|tennis)\b/i,
};

// Mapping for The Odds API sport keys
const ODDS_API_SPORTS = {
  basketball: ['basketball_nba', 'basketball_ncaab'],
  football:   ['americanfootball_nfl', 'americanfootball_ncaaf'],
  soccer:     ['soccer_epl', 'soccer_uefa_champs_league', 'soccer_spain_la_liga'],
  baseball:   ['baseball_mlb'],
  hockey:     ['icehockey_nhl'],
  mma:        ['mma_mixed_martial_arts'],
  tennis:     ['tennis_atp_french_open', 'tennis_atp_us_open', 'tennis_atp_wimbledon'],
};

// ── Live Score Feed ────────────────────────────────────────────────────

class LiveScoreFeed extends EventEmitter {
  constructor() {
    super();
    this.scores = new Map();       // gameId → { home, away, homeScore, awayScore, period, clock, status, sport, lastEvent }
    this.polling = false;
    this.pollTimer = null;
    this.lastPoll = 0;
    this.errorCount = 0;
  }

  async start() {
    if (this.polling) return;
    this.polling = true;
    this._poll();
  }

  stop() {
    this.polling = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
  }

  async _poll() {
    if (!this.polling) return;

    try {
      await this._fetchLiveScores();
      this.errorCount = 0;
    } catch (err) {
      this.errorCount++;
      if (this.errorCount <= 3) {
        console.error(`[sports-latency] Feed error: ${err.message}`);
      }
    }

    // Schedule next poll with jitter to avoid synchronization
    const jitter = Math.random() * 2000;
    this.pollTimer = setTimeout(() => this._poll(), LIVE_POLL_MS + jitter);
  }

  async _fetchLiveScores() {
    const sources = [];

    // Source 1: The Odds API live scores (free tier available)
    if (ODDS_API_KEY) {
      sources.push(this._fetchOddsApiScores());
    }

    // Source 2: Sportradar (premium — most reliable)
    if (SPORTRADAR_KEY) {
      sources.push(this._fetchSportradarScores());
    }

    // Source 3: ESPN rapid API (free, decent latency)
    sources.push(this._fetchEspnScores());

    const results = await Promise.allSettled(sources);

    for (const result of results) {
      if (result.status !== 'fulfilled' || !result.value) continue;
      for (const game of result.value) {
        this._processGameUpdate(game);
      }
    }
  }

  async _fetchOddsApiScores() {
    const games = [];
    const sportKeys = Object.values(ODDS_API_SPORTS).flat().slice(0, 3); // Limit API calls

    for (const sport of sportKeys) {
      try {
        const { data } = await axios.get(
          `https://api.the-odds-api.com/v4/sports/${sport}/scores`,
          {
            params: { apiKey: ODDS_API_KEY, daysFrom: 1 },
            timeout: 5000,
          }
        );
        for (const event of (data || [])) {
          if (!event.completed && event.scores) {
            games.push({
              id: `odds-${event.id}`,
              home: event.home_team,
              away: event.away_team,
              homeScore: parseInt(event.scores?.find(s => s.name === event.home_team)?.score || '0'),
              awayScore: parseInt(event.scores?.find(s => s.name === event.away_team)?.score || '0'),
              status: 'live',
              sport: sport.split('_')[0],
              source: 'odds-api',
              commence: event.commence_time,
            });
          }
        }
      } catch {}
    }

    return games;
  }

  async _fetchSportradarScores() {
    // Sportradar provides sub-second updates for live games
    // Requires paid API key — the most reliable source for latency arb
    const games = [];

    try {
      // NBA example endpoint
      const { data } = await axios.get(
        `https://api.sportradar.us/nba/production/v8/en/games/live/boxscore.json`,
        {
          params: { api_key: SPORTRADAR_KEY },
          timeout: 5000,
        }
      );

      for (const game of (data?.games || [])) {
        games.push({
          id: `sr-${game.id}`,
          home: game.home?.name || game.home?.alias,
          away: game.away?.name || game.away?.alias,
          homeScore: game.home?.points || 0,
          awayScore: game.away?.points || 0,
          period: game.quarter || game.period || 0,
          clock: game.clock || '',
          status: game.status === 'inprogress' ? 'live' : game.status,
          sport: 'basketball',
          source: 'sportradar',
        });
      }
    } catch {}

    return games;
  }

  async _fetchEspnScores() {
    // ESPN scoreboard — free, ~5-10s delay (still faster than TV)
    const games = [];
    const sports = [
      { url: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', sport: 'basketball' },
      { url: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard', sport: 'football' },
      { url: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', sport: 'baseball' },
      { url: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard', sport: 'hockey' },
      { url: 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard', sport: 'soccer' },
    ];

    for (const { url, sport } of sports) {
      try {
        const { data } = await axios.get(url, { timeout: 5000 });
        for (const event of (data?.events || [])) {
          const comp = event.competitions?.[0];
          if (!comp) continue;

          const status = comp.status?.type?.name;
          if (status !== 'STATUS_IN_PROGRESS' && status !== 'STATUS_HALFTIME') continue;

          const home = comp.competitors?.find(c => c.homeAway === 'home');
          const away = comp.competitors?.find(c => c.homeAway === 'away');
          if (!home || !away) continue;

          games.push({
            id: `espn-${event.id}`,
            home: home.team?.displayName || home.team?.shortDisplayName,
            away: away.team?.displayName || away.team?.shortDisplayName,
            homeScore: parseInt(home.score || '0'),
            awayScore: parseInt(away.score || '0'),
            period: comp.status?.period || 0,
            clock: comp.status?.displayClock || '',
            status: 'live',
            sport,
            source: 'espn',
          });
        }
      } catch {}
    }

    return games;
  }

  _processGameUpdate(game) {
    const prev = this.scores.get(game.id);
    const now = Date.now();

    // Detect score changes — this is the latency arb trigger
    if (prev) {
      const homeScored = game.homeScore > prev.homeScore;
      const awayScored = game.awayScore > prev.awayScore;

      if (homeScored || awayScored) {
        const event = {
          type: 'score_change',
          gameId: game.id,
          home: game.home,
          away: game.away,
          scorer: homeScored ? 'home' : 'away',
          scorerName: homeScored ? game.home : game.away,
          prevScore: `${prev.homeScore}-${prev.awayScore}`,
          newScore: `${game.homeScore}-${game.awayScore}`,
          pointsScored: homeScored
            ? game.homeScore - prev.homeScore
            : game.awayScore - prev.awayScore,
          sport: game.sport,
          period: game.period,
          clock: game.clock,
          timestamp: now,
          source: game.source,
        };

        this.emit('score_change', event);
      }
    }

    // Update stored state
    this.scores.set(game.id, {
      ...game,
      lastUpdate: now,
    });
  }
}

// ── Probability Models ─────────────────────────────────────────────────

/**
 * Estimate win probability shift from a score change.
 *
 * Uses sport-specific models based on historical data:
 * - Basketball: each point shifts ~0.5-2% depending on game state
 * - Football: touchdown shifts 8-15%, field goal 3-6%
 * - Soccer: goal shifts 15-30% (goals are rare → high info content)
 * - Baseball: run shifts 3-8% depending on inning
 * - Hockey: goal shifts 8-15%
 */
function estimateProbShift(event) {
  const { sport, pointsScored, period, scorer } = event;
  const isHome = scorer === 'home';

  let shift = 0;

  switch (sport) {
    case 'basketball':
      // NBA: ~100 points per game, each basket is ~1% of total
      // Late-game points worth more (period 4, under 5min)
      shift = pointsScored * 0.008;
      if (period >= 4) shift *= 1.5;  // Crunch time amplifier
      if (pointsScored >= 3) shift *= 1.3;  // Three-pointer premium
      break;

    case 'football':
      // NFL: touchdowns are rare and high-value
      if (pointsScored >= 6) shift = 0.12;       // TD
      else if (pointsScored >= 3) shift = 0.05;  // FG
      else shift = pointsScored * 0.02;           // Safety/PAT
      if (period >= 4) shift *= 1.4;  // 4th quarter amplifier
      break;

    case 'soccer':
      // Goals are rare → extremely high information content
      shift = 0.20;  // Each goal shifts ~20%
      if (period >= 75) shift = 0.25;  // Late goals worth more
      break;

    case 'baseball':
      // Runs: value depends heavily on inning
      shift = pointsScored * 0.05;
      if (period >= 7) shift *= 1.3;  // Late innings
      if (period >= 9) shift *= 1.5;  // 9th inning
      break;

    case 'hockey':
      // Goals: similar to soccer but slightly less impactful
      shift = 0.12;
      if (period >= 3) shift = 0.18;  // 3rd period
      break;

    case 'mma':
      // Knockdowns / significant events
      shift = 0.15;
      break;

    default:
      shift = 0.05;
  }

  // Direction: positive shift favors the scorer
  return isHome ? shift : -shift;
}

/**
 * Compute new fair probability after a score event.
 * Combines pre-event market price with the estimated shift.
 */
function computePostEventProb(preEventPrice, probShift) {
  const newProb = preEventPrice + probShift;
  return Math.max(0.02, Math.min(0.98, newProb));
}

// ── Market Matching ────────────────────────────────────────────────────

function normalizeTeam(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/\b(the|fc|cf|sc|afc|united|city|real|inter|ac)\b/gi, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a live game to Polymarket sports markets.
 * Returns array of matched markets with the team they reference.
 */
function matchGameToMarkets(game, markets) {
  const homeNorm = normalizeTeam(game.home);
  const awayNorm = normalizeTeam(game.away);
  const matched = [];

  for (const market of markets) {
    const text = ((market.question || '') + ' ' + (market.title || '')).toLowerCase();

    // Check if market references either team
    let referencesHome = false;
    let referencesAway = false;

    for (const part of homeNorm.split(' ')) {
      if (part.length > 3 && text.includes(part)) { referencesHome = true; break; }
    }
    for (const part of awayNorm.split(' ')) {
      if (part.length > 3 && text.includes(part)) { referencesAway = true; break; }
    }

    if (!referencesHome && !referencesAway) continue;

    // Determine which team the market is about (e.g., "Will Lakers win?")
    const marketTeam = referencesHome ? 'home' : 'away';

    let yesPrice = 0.5;
    try {
      const prices = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      if (prices && prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
    } catch { continue; }

    matched.push({
      market,
      marketTeam,
      yesPrice,
      liquidity: market.liquidity || market.volume || 0,
    });
  }

  return matched;
}

// ── Persistent State ───────────────────────────────────────────────────

const liveFeed = new LiveScoreFeed();
let activeSignals = [];    // Signals from recent score changes
let sportsMarketCache = [];
let lastMarketFetch = 0;
const MARKET_CACHE_TTL = 120_000;  // 2 min

// ── Strategy Implementation ────────────────────────────────────────────

const sportsLatencyArb = {
  name: 'sports-latency-arb',
  type: 'latency-arbitrage',
  riskLevel: 'high',
  description: 'Exploits 15-40s broadcast delay on live sports events via real-time data feeds',

  async scan(bot) {
    try {
      // Start live feed if not running
      if (!liveFeed.polling) {
        liveFeed.start();

        // Wire up score change listener → generate signals
        liveFeed.on('score_change', (event) => {
          const signal = {
            ...event,
            id: `${event.gameId}-${event.timestamp}`,
            createdAt: Date.now(),
            probShift: estimateProbShift(event),
          };
          activeSignals.push(signal);

          // Log the event
          const dir = signal.probShift > 0 ? '↑' : '↓';
          console.log(
            `  [sports-latency] SCORE: ${event.home} ${event.newScore} ${event.away} ` +
            `(${event.scorerName} +${event.pointsScored}) ${dir}${(Math.abs(signal.probShift) * 100).toFixed(1)}%`
          );
        });
      }

      // Expire old signals (beyond broadcast catch-up window)
      const now = Date.now();
      activeSignals = activeSignals.filter(s => now - s.createdAt < SIGNAL_DECAY_MS);

      // No live signals → nothing to trade
      if (activeSignals.length === 0) {
        return [];
      }

      // Fetch/cache sports markets
      if (now - lastMarketFetch > MARKET_CACHE_TTL) {
        const allMarkets = await fetchMarketsOnce();
        sportsMarketCache = allMarkets.filter(m => {
          const text = ((m.question || '') + ' ' + (m.title || '') + ' ' + (m.description || '')).toLowerCase();
          return Object.values(SPORT_PATTERNS).some(rx => rx.test(text));
        });
        lastMarketFetch = now;
      }

      if (sportsMarketCache.length === 0) return [];

      const opportunities = [];

      for (const signal of activeSignals) {
        // Find Polymarket markets for this game
        const matched = matchGameToMarkets(
          { home: signal.home, away: signal.away },
          sportsMarketCache
        );

        for (const match of matched) {
          if (match.liquidity < MIN_LIQUIDITY) continue;

          // Compute post-event fair probability
          // If market is about the home team and home scored → price should go UP
          const adjustedShift = match.marketTeam === 'home'
            ? signal.probShift
            : -signal.probShift;

          const fairPrice = computePostEventProb(match.yesPrice, adjustedShift);
          const ev = fairPrice - match.yesPrice;
          const absEv = Math.abs(ev);

          if (absEv < MIN_EDGE) continue;

          const side = ev > 0 ? 'YES' : 'NO';
          const effectivePrice = side === 'YES' ? match.yesPrice : (1 - match.yesPrice);

          // Time sensitivity — signal decays as broadcast catches up
          const signalAge = now - signal.createdAt;
          const broadcastDelay = BROADCAST_DELAYS[signal.sport] || { avg: 20, max: 35 };
          const decayPct = signalAge / (broadcastDelay.max * 1000);
          const freshness = Math.max(0, 1 - decayPct);

          if (freshness < 0.2) continue; // Too stale

          // Position size: small and frequent (the swisstony model)
          const posSize = Math.min(
            absEv * 1500 * freshness,  // Scale with edge and freshness
            MAX_POSITION
          );

          if (posSize < 10) continue;

          const confidence = Math.min(absEv * 8 * freshness, 0.95);

          opportunities.push({
            type: 'sports-latency-arb',
            market: (match.market.question || '').slice(0, 120),
            conditionId: match.market.conditionId || match.market.id,
            tokenId: match.market.clobTokenIds?.[ev > 0 ? 0 : 1],
            clobTokenIds: match.market.clobTokenIds || [],
            slug: match.market.slug || '',
            side,
            direction: side === 'YES' ? 'BUY' : 'BUY',
            outcome: side === 'YES' ? 0 : 1,
            currentPrice: effectivePrice,
            fairPrice,
            edge: absEv,
            edgePercent: (absEv * 100).toFixed(1) + '%',
            expectedReturn: absEv,
            confidence,
            liquidity: match.liquidity,
            maxPosition: Math.round(posSize),
            executionSpeed: 0.95,  // Must be fast — we're racing the broadcast

            // Latency-specific metadata
            latency: {
              gameId: signal.gameId,
              event: `${signal.home} ${signal.newScore} ${signal.away}`,
              scorer: signal.scorerName,
              pointsScored: signal.pointsScored,
              sport: signal.sport,
              probShift: adjustedShift,
              signalAge: Math.round(signalAge / 1000) + 's',
              freshness: (freshness * 100).toFixed(0) + '%',
              broadcastDelay: `${broadcastDelay.avg}-${broadcastDelay.max}s`,
              source: signal.source,
            },
          });
        }
      }

      if (opportunities.length > 0) {
        console.log(
          `  [sports-latency] ${activeSignals.length} live signals → ` +
          `${opportunities.length} tradeable (${liveFeed.scores.size} games tracked)`
        );
      }

      // ── GPU: Edge prediction for latency signals ──
      if (opportunities.length > 0) {
        try {
          const predictions = await gpu.predictEdge(opportunities.map(o => ({
            edge: o.edge,
            liquidity: o.liquidity,
            price: o.currentPrice,
            confidence: o.confidence,
            probShift: o.latency?.probShift || 0,
            sport: o.latency?.sport || 'unknown',
            freshness: parseFloat(o.latency?.freshness) / 100 || 0.5,
            strategy: 'sports-latency-arb',
          })));
          if (predictions) {
            for (let i = 0; i < opportunities.length && i < predictions.length; i++) {
              const winProb = predictions[i]?.winProbability || predictions[i]?.win_probability || 0.5;
              opportunities[i].gpuWinProb = winProb;
              // GPU validates the latency signal — high confidence signals get boosted
              if (winProb > 0.7) {
                opportunities[i].maxPosition = Math.min(opportunities[i].maxPosition * 1.4, MAX_POSITION * 1.5);
              } else if (winProb < 0.3) {
                opportunities[i].maxPosition = Math.round(opportunities[i].maxPosition * 0.5);
                opportunities[i].confidence *= 0.6;
              }
            }
          }
        } catch {}
      }

      return opportunities
        .sort((a, b) => (b.confidence * b.edge) - (a.confidence * a.edge))
        .slice(0, MAX_SIGNALS);
    } catch (err) {
      console.error('[sports-latency-arb]', err.message);
      return [];
    }
  },

  async validate(opp) {
    if (!opp) return false;
    if (opp.edge < MIN_EDGE * 0.5) return false; // Looser on validate — we need speed
    if (!opp.latency) return false;

    // Check freshness — signal must still be within broadcast window
    const signalAgeStr = opp.latency.signalAge || '0s';
    const signalAgeSec = parseInt(signalAgeStr);
    const delay = BROADCAST_DELAYS[opp.latency.sport] || { max: 35 };

    return signalAgeSec < delay.max;
  },

  async execute(bot, opp) {
    const size = opp.maxPosition;
    const lat = opp.latency || {};

    console.log(
      `[sports-latency] EXECUTING: ${opp.side} $${size} on "${(opp.market || '').slice(0, 60)}" ` +
      `edge=${opp.edgePercent} fair=${(opp.fairPrice * 100).toFixed(1)}% ` +
      `event="${lat.event}" scorer=${lat.scorer} ` +
      `age=${lat.signalAge} fresh=${lat.freshness} src=${lat.source}`
    );

    return bot.execute(opp, { size });
  },
};

module.exports = [sportsLatencyArb];

// Export internals for testing
module.exports._internals = {
  LiveScoreFeed,
  estimateProbShift,
  computePostEventProb,
  normalizeTeam,
  matchGameToMarkets,
  BROADCAST_DELAYS,
};
