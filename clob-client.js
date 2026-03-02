/**
 * Polymarket CLOB Client
 * Real-time orderbook data via REST + WebSocket.
 * Replaces mid-price estimates with actual bid/ask from the CLOB.
 */
const axios = require('axios');
const EventEmitter = require('events');
const WebSocket = require('ws');

const CLOB_REST = 'https://clob.polymarket.com';
const CLOB_WS = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class ClobClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.restUrl = config.restUrl || CLOB_REST;
    this.wsUrl = config.wsUrl || CLOB_WS;
    this.timeout = config.timeout || 10000;

    this._ws = null;
    this._subscriptions = new Map();
    this._orderbooks = new Map();
    this._reconnectDelay = 2000;
    this._maxReconnectDelay = 30000;
    this._shouldReconnect = false;
    this.retryAttempts = Math.max(1, parseInt(process.env.CLOB_RETRIES || '3', 10));
    this.retryBaseDelayMs = Math.max(100, parseInt(process.env.CLOB_RETRY_BASE_MS || '300', 10));
  }

  // ── REST methods ──

  async getOrderbook(tokenId) {
    let lastErr = null;
    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const { data } = await axios.get(`${this.restUrl}/book`, {
          params: { token_id: tokenId },
          timeout: this.timeout,
        });
        const book = this._parseBook(data);
        this._orderbooks.set(tokenId, { ...book, updatedAt: Date.now() });
        return book;
      } catch (err) {
        if (err.response?.status === 404) return null;
        lastErr = err;
        const status = err?.response?.status;
        const retryable = status === 429 || (status >= 500 && status <= 599) || !status;
        if (!retryable || attempt === this.retryAttempts) break;
        const expo = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * this.retryBaseDelayMs);
        const retryAfterHeader = parseFloat(err?.response?.headers?.['retry-after'] || '0');
        const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? Math.round(retryAfterHeader * 1000)
          : 0;
        const delayMs = Math.max(expo + jitter, retryAfterMs);
        await sleep(delayMs);
      }
    }

    try {
      throw lastErr;
    } catch (err) {
      throw new Error(`CLOB book fetch failed for ${tokenId}: ${err?.message || 'unknown error'}`);
    }
  }

  async getMidpoint(tokenId) {
    const book = await this.getOrderbook(tokenId);
    if (!book) return null;
    return book.midpoint;
  }

  async getSpread(tokenId) {
    const book = await this.getOrderbook(tokenId);
    if (!book) return null;
    return book.spread;
  }

  async getMarketInfo(conditionId) {
    try {
      const { data } = await axios.get(`${this.restUrl}/markets/${conditionId}`, {
        timeout: this.timeout,
      });
      return data;
    } catch (err) {
      return null;
    }
  }

  _parseBook(raw) {
    const bids = (raw.bids || [])
      .map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }))
      .sort((a, b) => b.price - a.price);

    const asks = (raw.asks || [])
      .map(o => ({ price: parseFloat(o.price), size: parseFloat(o.size) }))
      .sort((a, b) => a.price - b.price);

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 1;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    return {
      bids,
      asks,
      bestBid,
      bestAsk,
      spread,
      midpoint,
      bidDepth: bids.reduce((s, o) => s + o.size, 0),
      askDepth: asks.reduce((s, o) => s + o.size, 0),
      hash: raw.hash || null,
    };
  }

  depthAtPrice(tokenId, side, amount) {
    const book = this._orderbooks.get(tokenId);
    if (!book) return { fillPrice: null, slippage: null };

    const levels = side === 'buy' ? book.asks : book.bids;
    let remaining = amount;
    let cost = 0;

    for (const level of levels) {
      const fill = Math.min(remaining, level.size);
      cost += fill * level.price;
      remaining -= fill;
      if (remaining <= 0) break;
    }

    if (remaining > 0) {
      return { fillPrice: null, slippage: null, partial: true, filled: amount - remaining };
    }

    const avgPrice = cost / amount;
    const reference = side === 'buy' ? book.bestAsk : book.bestBid;
    const slippage = Math.abs(avgPrice - reference) / reference;

    return { fillPrice: avgPrice, slippage, partial: false, filled: amount };
  }

  // ── WebSocket methods ──

  connect() {
    if (this._ws) return;
    this._shouldReconnect = true;
    this._reconnectDelay = 2000;
    this._initWs();
  }

  disconnect() {
    this._shouldReconnect = false;
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
  }

  subscribe(assetIds) {
    const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
    ids.forEach(id => this._subscriptions.set(id, true));

    if (this._ws?.readyState === WebSocket.OPEN) {
      this._ws.send(JSON.stringify({ assets_ids: ids, type: 'market' }));
    }
  }

  unsubscribe(assetIds) {
    const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
    ids.forEach(id => this._subscriptions.delete(id));
  }

  _initWs() {
    try {
      this._ws = new WebSocket(this.wsUrl);
    } catch (err) {
      this.emit('error', err);
      this._scheduleReconnect();
      return;
    }

    this._ws.on('open', () => {
      this.emit('connected');
      this._reconnectDelay = 2000;
      if (this._subscriptions.size > 0) {
        this._ws.send(JSON.stringify({
          assets_ids: Array.from(this._subscriptions.keys()),
          type: 'market',
        }));
      }
    });

    this._ws.on('message', (raw) => {
      try {
        const msgs = JSON.parse(raw.toString());
        const arr = Array.isArray(msgs) ? msgs : [msgs];
        for (const msg of arr) {
          this._handleWsMessage(msg);
        }
      } catch { /* ignore malformed frames */ }
    });

    this._ws.on('close', () => {
      this._ws = null;
      this.emit('disconnected');
      this._scheduleReconnect();
    });

    this._ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  _handleWsMessage(msg) {
    const type = msg.event_type || msg.type;

    if (type === 'book') {
      const book = this._parseBook(msg);
      const assetId = msg.asset_id || msg.market;
      if (assetId) {
        this._orderbooks.set(assetId, { ...book, updatedAt: Date.now() });
        this.emit('book', { assetId, book });
      }
    } else if (type === 'price_change') {
      this.emit('price', msg);
    } else if (type === 'last_trade_price') {
      this.emit('trade', msg);
    }
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect) return;
    setTimeout(() => {
      if (this._shouldReconnect && !this._ws) this._initWs();
    }, this._reconnectDelay);
    this._reconnectDelay = Math.min(this._reconnectDelay * 1.5, this._maxReconnectDelay);
  }

  getCachedBook(tokenId) {
    return this._orderbooks.get(tokenId) || null;
  }

  get connectedAssets() {
    return Array.from(this._subscriptions.keys());
  }
}

module.exports = ClobClient;
