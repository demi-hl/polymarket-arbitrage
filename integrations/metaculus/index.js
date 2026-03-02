/**
 * Metaculus Integration — public question data (no auth required).
 * Used for cross-platform price comparison; all trades execute on Polymarket.
 */
const axios = require('axios');

const BASE_URL = 'https://www.metaculus.com/api2';
const QUESTIONS_URL = `${BASE_URL}/questions/`;
const TIMEOUT = 15000;
const ESTIMATED_LIQUIDITY = 10000;

class MetaculusScanner {
  constructor(config = {}) {
    this.url = config.url || QUESTIONS_URL;
    this.timeout = config.timeout || TIMEOUT;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = config.cacheTTL || 120000;
  }

  async fetchMarkets() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._cacheTTL) return this._cache;

    const allMarkets = [];

    try {
      const { data } = await axios.get(this.url, {
        params: {
          status: 'open',
          type: 'binary',
          order_by: '-activity',
          limit: 200,
        },
        timeout: this.timeout,
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'PolymarketArbitrageBot/1.0 (price-comparison)',
        },
      });
      const results = data?.results ?? [];
      const questions = Array.isArray(results) ? results : [];

      for (const q of questions) {
        if (q.resolution != null && q.resolution !== '') continue;

        const pred = q.community_prediction;
        const q2 = pred?.full?.q2;
        if (q2 == null || typeof q2 !== 'number') continue;

        const yesPrice = Math.max(0, Math.min(1, q2));
        const noPrice = 1 - yesPrice;

        allMarkets.push({
          platform: 'metaculus',
          id: `mc-${q.id}`,
          title: q.title || '',
          yesPrice,
          noPrice,
          volume: 0,
          liquidity: ESTIMATED_LIQUIDITY,
          endDate: q.close_time ?? null,
          _raw: q,
        });
      }
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 503) {
        console.error('[Metaculus] API unavailable:', err.message);
      } else {
        console.error('[Metaculus] fetch failed:', err.message);
      }
    }

    this._cache = allMarkets;
    this._cacheTime = Date.now();
    return allMarkets;
  }

  clearCache() {
    this._cache = null;
    this._cacheTime = 0;
  }
}

module.exports = { MetaculusScanner };
