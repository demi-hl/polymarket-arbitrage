/**
 * Event Calendar
 *
 * Scrapes real event calendars (Congress, crypto, sports) to improve
 * the event-catalyst strategy's resolution timing. Provides event
 * matching and resolution boost for Polymarket markets.
 */
const axios = require('axios');

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const REQUEST_TIMEOUT_MS = 10000;

// --- Static Sports Calendar 2026 ---
const STATIC_SPORTS_2026 = [
  { type: 'sports', title: '2026 FIFA World Cup', date: '2026-06-11', category: 'soccer', source: 'static' },
  { type: 'sports', title: '2026 FIFA World Cup Final', date: '2026-07-19', category: 'soccer', source: 'static' },
  { type: 'sports', title: '2026 Super Bowl', date: '2026-02-08', category: 'nfl', source: 'static' },
  { type: 'sports', title: '2026 NBA Finals', date: '2026-06-15', category: 'nba', source: 'static' },
  { type: 'sports', title: '2026 NBA Finals Game 7', date: '2026-06-22', category: 'nba', source: 'static' },
  { type: 'sports', title: '2026 MLB World Series', date: '2026-10-25', category: 'mlb', source: 'static' },
  { type: 'sports', title: '2026 MLB World Series Game 7', date: '2026-11-01', category: 'mlb', source: 'static' },
  { type: 'sports', title: '2026 March Madness Final Four', date: '2026-04-04', category: 'ncaa', source: 'static' },
  { type: 'sports', title: '2026 March Madness Championship', date: '2026-04-06', category: 'ncaa', source: 'static' },
  { type: 'sports', title: '2026 Summer Olympics', date: '2026-07-14', category: 'olympics', source: 'static' },
  { type: 'sports', title: '2026 Summer Olympics Closing', date: '2026-07-30', category: 'olympics', source: 'static' },
];

// --- Static Crypto Calendar ---
const STATIC_CRYPTO = [
  { type: 'crypto', title: 'Bitcoin Halving', date: '2028-04-01', category: 'halving', source: 'static' },
  { type: 'crypto', title: 'Major Token Unlock - Generic', date: '2026-01-15', category: 'unlock', source: 'static' },
  { type: 'crypto', title: 'Major Token Unlock - Generic', date: '2026-03-01', category: 'unlock', source: 'static' },
  { type: 'crypto', title: 'Major Token Unlock - Generic', date: '2026-06-01', category: 'unlock', source: 'static' },
  { type: 'crypto', title: 'ETF Decision Deadline - Generic', date: '2026-01-31', category: 'etf', source: 'static' },
  { type: 'crypto', title: 'ETF Decision Deadline - Generic', date: '2026-06-30', category: 'etf', source: 'static' },
  { type: 'crypto', title: 'Ethereum Major Upgrade', date: '2026-03-15', category: 'eth', source: 'static' },
];

class EventCalendar {
  constructor() {
    this._cache = null;
    this._cacheExpiry = 0;
  }

  _isCacheValid() {
    return this._cache !== null && Date.now() < this._cacheExpiry;
  }

  _setCache(events) {
    this._cache = events;
    this._cacheExpiry = Date.now() + CACHE_TTL_MS;
  }

  async _fetchCongressBills() {
    const key = process.env.CONGRESS_API_KEY;
    if (!key) return [];

    try {
      const { data } = await axios.get(
        'https://api.congress.gov/v3/bill?format=json&limit=20&sort=updateDate+desc',
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'X-API-Key': key },
        }
      );
      const bills = data?.bills || data?.results || [];
      return bills.map((b) => ({
        type: 'political',
        title: b.title || b.shortTitle || `Bill ${b.number || b.url}`,
        date: b.updateDate || b.introducedDate || new Date().toISOString().slice(0, 10),
        category: 'congress',
        source: 'congress.gov',
      }));
    } catch {
      return [];
    }
  }

  async _fetchProPublicaVotes() {
    const key = process.env.PROPUBLICA_KEY;
    if (!key) return [];

    try {
      const { data } = await axios.get(
        'https://api.propublica.org/congress/v1/both/votes/recent.json',
        {
          timeout: REQUEST_TIMEOUT_MS,
          headers: { 'X-API-Key': key },
        }
      );
      const votes = data?.results?.votes || [];
      return votes.map((v) => ({
        type: 'political',
        title: v.question || v.description || `Vote ${v.roll_call || ''}`,
        date: v.date || new Date().toISOString().slice(0, 10),
        category: 'congress',
        source: 'propublica',
      }));
    } catch {
      return [];
    }
  }

  async _fetchCoinGeckoEvents() {
    try {
      const { data } = await axios.get('https://api.coingecko.com/api/v3/events', {
        timeout: REQUEST_TIMEOUT_MS,
      });
      const events = data?.data || data?.events || [];
      return events.map((e) => ({
        type: 'crypto',
        title: e.title || e.name || String(e),
        date: e.start_date || e.date || e.start || new Date().toISOString().slice(0, 10),
        category: e.type || 'general',
        source: 'coingecko',
      }));
    } catch {
      return [];
    }
  }

  async fetchUpcomingEvents() {
    if (this._isCacheValid()) return this._cache;

    const all = [];

    // Congressional (skip silently if no key or API fails)
    const congress = await this._fetchCongressBills();
    all.push(...congress);

    const propublica = await this._fetchProPublicaVotes();
    all.push(...propublica);

    // Crypto: try CoinGecko, fallback to static
    const coingecko = await this._fetchCoinGeckoEvents();
    if (coingecko.length > 0) {
      all.push(...coingecko);
    } else {
      all.push(...STATIC_CRYPTO);
    }

    // Sports: always include static calendar
    all.push(...STATIC_SPORTS_2026);

    // Normalize dates and filter to upcoming
    const now = Date.now();
    const normalized = all.map((e) => {
      let d = e.date;
      if (typeof d === 'string' && d.length >= 10) d = d.slice(0, 10);
      const ts = new Date(d).getTime();
      return { ...e, date: typeof e.date === 'string' ? e.date.slice(0, 10) : e.date, _ts: ts };
    });

    const upcoming = normalized
      .filter((e) => e._ts >= now - 7 * 24 * 3600 * 1000) // include last 7 days
      .sort((a, b) => a._ts - b._ts)
      .map(({ _ts, ...e }) => e);

    this._setCache(upcoming);
    return upcoming;
  }

  /**
   * Returns confidence score (0-1) for how well an event matches a market.
   * Uses keyword matching on event title vs market question.
   */
  matchEventToMarket(event, market) {
    const question = (market?.question || market || '').toLowerCase();
    const title = (event?.title || '').toLowerCase();
    if (!question || !title) return 0;

    const qWords = question.split(/\s+/).filter((w) => w.length > 2);
    const tWords = title.split(/\s+/).filter((w) => w.length > 2);
    const qSet = new Set(qWords);
    const tSet = new Set(tWords);

    let matches = 0;
    for (const w of qSet) {
      if (tSet.has(w)) matches++;
      else if ([...tSet].some((tw) => tw.includes(w) || w.includes(tw))) matches += 0.5;
    }
    const recall = qSet.size > 0 ? matches / qSet.size : 0;
    const precision = tSet.size > 0 ? matches / tSet.size : 0;
    const f1 = recall + precision > 0 ? (2 * recall * precision) / (recall + precision) : 0;

    // Boost for exact substring
    const exactMatch = question.includes(title) || title.includes(question);
    const score = Math.min(1, f1 * 0.8 + (exactMatch ? 0.3 : 0));
    return Math.round(score * 100) / 100;
  }

  /**
   * Checks if any known event aligns with market resolution.
   * Returns { boost: 0-0.03, reason: string }.
   */
  async getResolutionBoost(marketQuestion, endDate) {
    const events = await this.fetchUpcomingEvents();
    const endTs = endDate ? new Date(endDate).getTime() : 0;
    if (endTs <= 0) return { boost: 0, reason: '' };

    const dayMs = 24 * 60 * 60 * 1000;
    let best = { boost: 0, reason: '' };

    for (const event of events) {
      const eventTs = new Date(event.date).getTime();
      const daysDiff = Math.abs(endTs - eventTs) / dayMs;

      if (daysDiff > 7) continue;

      const matchScore = this.matchEventToMarket(event, { question: marketQuestion });
      if (matchScore < 0.2) continue;

      const proximityFactor = Math.max(0, 1 - daysDiff / 7);
      const boost = Math.min(0.03, matchScore * proximityFactor * 0.03);
      if (boost > best.boost) {
        best = {
          boost: Math.round(boost * 10000) / 10000,
          reason: `Event "${event.title}" (${event.date}) aligns with resolution`,
        };
      }
    }

    return best;
  }
}

module.exports = EventCalendar;
