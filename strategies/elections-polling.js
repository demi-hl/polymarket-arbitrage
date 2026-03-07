/**
 * Elections & Polling Strategy
 *
 * Polymarket's highest-volume category. Compares prediction market pricing
 * against polling aggregators, forecasting models, and historical base rates.
 *
 * Edge sources:
 * - Polling averages update before markets reprice (lag)
 * - RCP/538/Silver Bulletin aggregates vs market-implied probability
 * - Primary calendar events create predictable volatility
 * - Incumbency advantage and partisan lean base rates
 * - Debate/scandal event-driven mispricing windows
 */

const axios = require('axios');
const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

const ELECTION_KEYWORDS = [
  'president', 'election', 'nominee', 'primary', 'caucus', 'delegate',
  'senate', 'house', 'governor', 'congress', 'electoral', 'ballot',
  'democrat', 'republican', 'gop', 'dnc', 'rnc', 'biden', 'trump',
  'vote', 'polling', 'swing state', 'battleground', 'midterm',
  'runoff', 'incumbent', 'challenger', 'party', 'cabinet',
  'speaker', 'majority', 'filibuster', 'impeach', 'confirmation',
  'scotus', 'supreme court', 'attorney general', 'secretary',
  'vp', 'vice president', 'running mate', 'ticket',
];

// RealClearPolitics scrape endpoint (public polling averages)
const RCP_API = 'https://www.realclearpolling.com/api';
// FiveThirtyEight / Silver Bulletin models
const SILVER_API = 'https://projects.fivethirtyeight.com';

let _pollCache = { data: null, ts: 0 };
const POLL_TTL = 600_000; // 10 min — polls update slowly

// Historical base rates for common political market types
const BASE_RATES = {
  'incumbent_wins': 0.67,         // Incumbents win ~67% of general elections
  'party_holds_seat': 0.82,       // Sitting party holds ~82% of safe seats
  'primary_frontrunner': 0.73,    // Polling leader wins primary ~73% of time
  'debate_bounce': 0.55,          // Debate "winner" gets temporary bounce ~55%
  'confirmation_passes': 0.85,    // Presidential nominees confirmed ~85%
  'midterm_opposition': 0.72,     // Opposition gains seats in midterms ~72%
};

/**
 * Fetch polling data from public aggregators
 */
async function fetchPollingData() {
  if (_pollCache.data && Date.now() - _pollCache.ts < POLL_TTL) return _pollCache.data;

  const polls = { races: {}, lastUpdate: Date.now() };

  // Try multiple polling sources
  try {
    const res = await axios.get('https://projects.fivethirtyeight.com/polls/polls.json', {
      timeout: 10000,
      headers: { 'User-Agent': 'DEMI-Bot/1.0' },
    });
    if (Array.isArray(res.data)) {
      for (const poll of res.data.slice(0, 200)) {
        const race = poll.race_id || poll.question_id || 'unknown';
        if (!polls.races[race]) polls.races[race] = [];
        polls.races[race].push({
          candidate: poll.candidate_name || poll.answer,
          pct: parseFloat(poll.pct || 0),
          pollster: poll.pollster,
          date: poll.end_date || poll.created_at,
          sampleSize: poll.sample_size,
          grade: poll.pollster_rating_name,
        });
      }
    }
  } catch {}

  // Fallback: Use RCP API
  try {
    const res = await axios.get(`${RCP_API}/polls`, { timeout: 8000 });
    if (res.data?.polls) {
      for (const poll of res.data.polls) {
        const race = poll.slug || poll.title;
        if (!polls.races[race]) polls.races[race] = [];
        polls.races[race].push({
          candidate: poll.candidate,
          pct: parseFloat(poll.spread || poll.value || 0),
          source: 'rcp',
        });
      }
    }
  } catch {}

  _pollCache = { data: polls, ts: Date.now() };
  return polls;
}

/**
 * Extract candidate names from market question
 */
function extractCandidates(text) {
  // Common name patterns in political markets
  const namePattern = /(?:Will|win|nominee|become|elected|appointed|confirmed)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/gi;
  const matches = [];
  let m;
  while ((m = namePattern.exec(text)) !== null) {
    matches.push(m[1].trim());
  }
  return matches;
}

/**
 * Estimate probability from polling data + base rates
 */
function estimateFromPolls(market, polls) {
  const text = (market.question || market.title || '').toLowerCase();
  const candidates = extractCandidates(market.question || market.title || '');

  // Try to match market question to polling data
  let bestMatch = null;
  let bestScore = 0;

  for (const [raceId, racePolls] of Object.entries(polls.races)) {
    const raceText = raceId.toLowerCase();
    // Score match quality
    let matchScore = 0;
    for (const candidate of candidates) {
      if (raceText.includes(candidate.toLowerCase())) matchScore += 3;
      for (const poll of racePolls) {
        if (poll.candidate?.toLowerCase().includes(candidate.toLowerCase())) matchScore += 2;
      }
    }
    if (matchScore > bestScore) {
      bestScore = matchScore;
      bestMatch = racePolls;
    }
  }

  if (bestMatch && bestMatch.length >= 2) {
    // Calculate polling average
    const sorted = [...bestMatch].sort((a, b) => b.pct - a.pct);
    const leader = sorted[0];
    const trailer = sorted[1];
    const spread = leader.pct - trailer.pct;

    // Convert polling spread to win probability (simplified)
    // Historical: 5pt lead → ~75% win, 10pt → ~90%, 15pt+ → ~95%
    let probability;
    if (spread >= 15) probability = 0.95;
    else if (spread >= 10) probability = 0.88;
    else if (spread >= 7) probability = 0.80;
    else if (spread >= 5) probability = 0.72;
    else if (spread >= 3) probability = 0.62;
    else if (spread >= 1) probability = 0.55;
    else probability = 0.50;

    // Check if market is asking about leader or trailer
    const marketCandidateLower = candidates[0]?.toLowerCase();
    if (marketCandidateLower && trailer.candidate?.toLowerCase().includes(marketCandidateLower)) {
      probability = 1 - probability;
    }

    return { probability, source: 'polling-average', spread, leader: leader.candidate };
  }

  // Fall back to base rates for generic political markets
  if (/incumbent/.test(text) || /re-?elect/.test(text)) {
    return { probability: BASE_RATES.incumbent_wins, source: 'base-rate-incumbent' };
  }
  if (/confirm/.test(text) || /nominate/.test(text)) {
    return { probability: BASE_RATES.confirmation_passes, source: 'base-rate-confirmation' };
  }
  if (/primary|nominee/.test(text)) {
    return { probability: BASE_RATES.primary_frontrunner, source: 'base-rate-primary' };
  }
  if (/midterm|opposition/.test(text)) {
    return { probability: BASE_RATES.midterm_opposition, source: 'base-rate-midterm' };
  }

  return null;
}

const electionsPollingStrategy = {
  name: 'elections-polling',
  type: 'political',
  riskLevel: 'medium',

  async scan(bot) {
    const [markets, polls] = await Promise.all([
      fetchMarketsOnce(),
      fetchPollingData(),
    ]);
    if (!markets || markets.length === 0) return [];

    const politicalMarkets = markets.filter(m => {
      const text = (m.question || m.title || '').toLowerCase() + ' ' + (m.description || '').toLowerCase();
      return ELECTION_KEYWORDS.some(kw => text.includes(kw));
    });

    const opportunities = [];

    for (const market of politicalMarkets) {
      try {
        const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
        if (yesPrice <= 0.02 || yesPrice >= 0.98) continue;

        const estimate = estimateFromPolls(market, polls);
        if (!estimate) continue;

        const edge = estimate.probability - yesPrice;
        const absEdge = Math.abs(edge);
        if (absEdge < 0.03) continue;

        const side = edge > 0 ? 'YES' : 'NO';
        const confidence = Math.min(absEdge * 6, 0.9);

        opportunities.push({
          type: 'election-mispricing',
          market: (market.question || market.title || '').slice(0, 120),
          conditionId: market.conditionId || market.id,
          tokenId: market.clobTokenIds?.[edge > 0 ? 0 : 1],
          side,
          currentPrice: edge > 0 ? yesPrice : (1 - yesPrice),
          modelPrice: edge > 0 ? estimate.probability : (1 - estimate.probability),
          edge: absEdge,
          edgePercent: (absEdge * 100).toFixed(1) + '%',
          expectedReturn: absEdge,
          confidence,
          source: estimate.source,
          liquidity: parseFloat(market.volume || market.liquidityClob || 0),
          maxPosition: Math.min(absEdge * 600, 150),
          executionSpeed: 0.5,
        });
      } catch {}
    }

    return opportunities;
  },

  async validate(opp) {
    return opp && typeof opp.edge === 'number' && opp.edge > 0.03 && opp.confidence > 0.15;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [electionsPollingStrategy];
