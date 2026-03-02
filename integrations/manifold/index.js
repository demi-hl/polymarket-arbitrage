/**
 * Manifold Markets Integration — public market data (no auth required).
 * Used for cross-platform price comparison; all trades execute on Polymarket.
 */
const axios = require('axios');

const BASE_URL = 'https://api.manifold.markets/v0';
const SEARCH_MARKETS_URL = `${BASE_URL}/search-markets`;
const TIMEOUT = 15000;
const MIN_LIQUIDITY = 100;

class ManifoldScanner {
  constructor(config = {}) {
    this.url = config.url || SEARCH_MARKETS_URL;
    this.timeout = config.timeout || TIMEOUT;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = config.cacheTTL || 60000;
  }

  _getLiquidity(market) {
    if (market.totalLiquidity != null && typeof market.totalLiquidity === 'number') {
      return market.totalLiquidity;
    }
    const pool = market.pool;
    if (pool == null) return 0;
    if (typeof pool === 'number') return pool;
    if (typeof pool === 'object') {
      const yes = pool.YES ?? pool.yes ?? pool.outcome ?? 0;
      const no = pool.NO ?? pool.no ?? 0;
      return (typeof yes === 'number' ? yes : 0) + (typeof no === 'number' ? no : 0);
    }
    return 0;
  }

  async fetchMarkets() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._cacheTTL) return this._cache;

    const allMarkets = [];

    try {
      const { data } = await axios.get(this.url, {
        params: { term: '', sort: 'liquidity', limit: 500, filter: 'open' },
        timeout: this.timeout,
      });
      const markets = Array.isArray(data) ? data : [];

      for (const m of markets) {
        if (m.isResolved) continue;

        const liquidity = this._getLiquidity(m);
        if (liquidity < MIN_LIQUIDITY) continue;

        const probability = parseFloat(m.probability ?? 0);
        const yesPrice = Math.max(0, Math.min(1, probability));
        const noPrice = 1 - yesPrice;

        allMarkets.push({
          platform: 'manifold',
          id: `mf-${m.id}`,
          title: m.question || '',
          yesPrice,
          noPrice,
          volume: parseFloat(m.volume ?? 0) || 0,
          liquidity,
          endDate: m.closeTime ?? null,
          _raw: m,
        });
      }
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 503) {
        console.error('[Manifold] API unavailable:', err.message);
      } else {
        console.error('[Manifold] fetch failed:', err.message);
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

module.exports = { ManifoldScanner };
