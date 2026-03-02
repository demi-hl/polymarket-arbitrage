/**
 * Kalshi Integration — market data via v2 API.
 * Uses KALSHI_API_KEY; when KALSHI_API_SECRET or KALSHI_PRIVATE_KEY_PATH is set, signs requests (full auth).
 * Used for cross-platform price comparison; all trades execute on Polymarket.
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const TIMEOUT = 15000;
const PAGE_LIMIT = 200;

function loadPrivateKey(config) {
  const keyPath = config.privateKeyPath || process.env.KALSHI_PRIVATE_KEY_PATH;
  if (keyPath) {
    try {
      const fullPath = path.isAbsolute(keyPath) ? keyPath : path.join(process.cwd(), keyPath);
      return fs.readFileSync(fullPath, 'utf8');
    } catch (e) {
      return null;
    }
  }
  const secret = config.apiSecret || process.env.KALSHI_API_SECRET;
  if (secret) return secret.replace(/\\n/g, '\n');
  return null;
}

function signRequest(privateKeyPem, timestamp, method, pathWithoutQuery) {
  const message = `${timestamp}${method}${pathWithoutQuery}`;
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign('sha256', Buffer.from(message, 'utf8'), {
    key,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return sig.toString('base64');
}

class KalshiScanner {
  constructor(config = {}) {
    this.baseUrl = config.baseUrl || BASE_URL;
    this.timeout = config.timeout || TIMEOUT;
    this.apiKey = config.apiKey || process.env.KALSHI_API_KEY;
    this._privateKeyPem = loadPrivateKey(config);
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTTL = config.cacheTTL || 60000;
  }

  _headers(method, pathWithoutQuery) {
    const h = { 'Accept': 'application/json' };
    if (!this.apiKey) return h;
    h['KALSHI-ACCESS-KEY'] = this.apiKey;
    if (this._privateKeyPem && pathWithoutQuery) {
      const timestamp = String(Date.now());
      h['KALSHI-ACCESS-TIMESTAMP'] = timestamp;
      h['KALSHI-ACCESS-SIGNATURE'] = signRequest(this._privateKeyPem, timestamp, method, pathWithoutQuery);
    }
    return h;
  }

  _pathFor(pathname) {
    const base = this.baseUrl.replace(/^https?:\/\/[^/]+/, '') || '/trade-api/v2';
    const p = pathname.startsWith('/') ? pathname : `/${pathname.replace(/^\//, '')}`;
    return base.endsWith('/') ? `${base}${p.replace(/^\//, '')}` : `${base}${p}`;
  }

  async fetchMarkets() {
    const now = Date.now();
    if (this._cache && now - this._cacheTime < this._cacheTTL) return this._cache;

    const allMarkets = [];
    let cursor = null;

    try {
      while (true) {
        const params = { limit: PAGE_LIMIT, status: 'open' };
        if (cursor) params.cursor = cursor;

        const pathWithoutQuery = this._pathFor('/markets');
        const { data } = await axios.get(`${this.baseUrl}/markets`, {
          params,
          timeout: this.timeout,
          headers: this._headers('GET', pathWithoutQuery),
        });

        const markets = data.markets || [];
        if (markets.length === 0) break;

        for (const m of markets) {
          const yesPrice = (m.yes_bid ?? m.yes_price ?? 0) / 100;
          const noPrice = (m.no_bid ?? m.no_price ?? 0) / 100;

          allMarkets.push({
            platform: 'kalshi',
            id: m.ticker,
            title: m.title || '',
            subtitle: m.subtitle || '',
            category: m.category || '',
            eventTicker: m.event_ticker || '',
            yesPrice,
            noPrice,
            volume: m.volume || 0,
            openInterest: m.open_interest || 0,
            status: m.status,
            closeTime: m.close_time || m.expiration_time,
            _raw: m,
          });
        }

        cursor = data.cursor;
        if (!cursor || markets.length < PAGE_LIMIT) break;
      }
    } catch (err) {
      console.error('[Kalshi] fetch failed:', err.message);
    }

    this._cache = allMarkets;
    this._cacheTime = Date.now();
    return allMarkets;
  }

  async fetchOrderbook(ticker) {
    try {
      const pathWithoutQuery = this._pathFor(`/markets/${ticker}/orderbook`);
      const { data } = await axios.get(
        `${this.baseUrl}/markets/${ticker}/orderbook`,
        { timeout: this.timeout, headers: this._headers('GET', pathWithoutQuery) }
      );
      return data.orderbook || null;
    } catch (err) {
      console.error(`[Kalshi] orderbook ${ticker}:`, err.message);
      return null;
    }
  }

  clearCache() {
    this._cache = null;
    this._cacheTime = 0;
  }
}

module.exports = { KalshiScanner };
