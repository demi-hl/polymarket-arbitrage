/**
 * PredictIt Integration — public market data (no auth required).
 * Used for cross-platform price comparison; all trades execute on Polymarket.
 */
const axios = require('axios');

const ALL_MARKETS_URL = 'https://www.predictit.org/api/marketdata/all/';
const TIMEOUT = 15000;

class PredictItScanner {
  constructor(config = {}) {
    this.url = config.url || ALL_MARKETS_URL;
    this.timeout = config.timeout || TIMEOUT;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = config.cacheTTL || 60000;
  }

  async fetchMarkets() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._cacheTTL) return this._cache;

    const allMarkets = [];

    try {
      const { data } = await axios.get(this.url, { timeout: this.timeout });
      const markets = data.markets || data.Markets || [];

      for (const m of markets) {
        const contracts = m.contracts || m.Contracts || [];
        for (const c of contracts) {
          const yesPrice = parseFloat(c.lastTradePrice ?? c.LastTradePrice ?? 0);
          const bestYesBuy = parseFloat(c.bestBuyYesCost ?? c.BestBuyYesCost ?? 0);
          const bestNoBuy = parseFloat(c.bestBuyNoCost ?? c.BestBuyNoCost ?? 0);

          const marketQuestion = m.name || m.Name || '';
          const contractName = c.name || c.Name || '';
          const fullTitle = marketQuestion.includes(contractName)
            ? marketQuestion
            : `${marketQuestion} — ${contractName}`;

          allMarkets.push({
            platform: 'predictit',
            id: `pi-${m.id || m.ID}-${c.id || c.ID}`,
            marketId: m.id || m.ID,
            contractId: c.id || c.ID,
            title: fullTitle,
            marketName: marketQuestion,
            contractName,
            shortName: c.shortName || c.ShortName || '',
            yesPrice,
            noPrice: yesPrice > 0 ? 1 - yesPrice : 0,
            bestYesBuy,
            bestNoBuy,
            volume: 0,
            status: (m.status || m.Status || '').toLowerCase() === 'open' ? 'open' : 'closed',
            _raw: c,
          });
        }
      }
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 503) {
        console.error('[PredictIt] API unavailable (may be geo-restricted or down):', err.message);
      } else {
        console.error('[PredictIt] fetch failed:', err.message);
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

module.exports = { PredictItScanner };
