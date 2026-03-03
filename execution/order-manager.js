/**
 * Order Manager
 * Manages limit order lifecycle for market making: create, track, cancel, fill.
 * In paper mode, simulates fills against the CLOB orderbook.
 * In live mode, signs and submits orders to the Polymarket CLOB API.
 *
 * Live mode activates when all required env vars are set:
 *   POLYMARKET_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE
 *
 * The mode can also be forced via config.mode ('paper' | 'live').
 */
const EventEmitter = require('events');
const axios = require('axios');
const ClobClient = require('../clob-client');
const { ClobSigner } = require('./clob-signer');

// ── Constants ──────────────────────────────────────────────────────────────────

const CLOB_REST = 'https://clob.polymarket.com';

// Order status values returned by CLOB API
const CLOB_STATUS = {
  LIVE: 'live',
  MATCHED: 'matched',
  DELAYED: 'delayed',
};

const ORDER_STATUS_LIVE = 'ORDER_STATUS_LIVE';
const ORDER_STATUS_MATCHED = 'ORDER_STATUS_MATCHED';
const ORDER_STATUS_CANCELED = 'ORDER_STATUS_CANCELED';
const ORDER_STATUS_INVALID = 'ORDER_STATUS_INVALID';

// Polling config
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // 60 seconds max poll time

// Rate limit config
const RATE_LIMIT_BACKOFF_MS = 1000;
const MAX_RATE_LIMIT_RETRIES = 3;

// ── Helpers ────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Detect whether all env vars for live trading are present.
 */
function hasLiveCredentials() {
  return !!(
    process.env.POLYMARKET_KEY &&
    process.env.POLYMARKET_API_KEY &&
    process.env.POLYMARKET_API_SECRET &&
    process.env.POLYMARKET_API_PASSPHRASE
  );
}

/**
 * Build a ClobSigner from env vars. Throws if any are missing.
 */
function buildSigner() {
  const privateKey = process.env.POLYMARKET_KEY;
  const key = process.env.POLYMARKET_API_KEY;
  const secret = process.env.POLYMARKET_API_SECRET;
  const passphrase = process.env.POLYMARKET_API_PASSPHRASE;

  if (!privateKey || !key || !secret || !passphrase) {
    throw new Error(
      'Live mode requires env vars: POLYMARKET_KEY, POLYMARKET_API_KEY, POLYMARKET_API_SECRET, POLYMARKET_API_PASSPHRASE',
    );
  }

  return new ClobSigner({
    privateKey,
    apiCreds: { key, secret, passphrase },
    funderAddress: process.env.POLYMARKET_FUNDER_ADDRESS || undefined,
  });
}

// ── OrderManager ───────────────────────────────────────────────────────────────

class OrderManager extends EventEmitter {
  constructor(config = {}) {
    super();

    // Determine mode: explicit config > env detection > paper fallback
    if (config.mode === 'live') {
      this.mode = 'live';
    } else if (config.mode === 'paper') {
      this.mode = 'paper';
    } else {
      this.mode = hasLiveCredentials() ? 'live' : 'paper';
    }

    this.clob = config.clobClient || new ClobClient();
    this.clobRestUrl = config.clobRestUrl || CLOB_REST;

    // Live mode: initialize signer
    this.signer = null;
    if (this.mode === 'live') {
      this.signer = config.signer || buildSigner();
    }

    this.openOrders = new Map();
    this.filledOrders = [];
    this.cancelledOrders = [];
    this._nextOrderId = 1;

    // Map local order IDs -> CLOB order IDs for live orders
    this._clobOrderIds = new Map();
  }

  /**
   * Place a limit order.
   * @param {string} tokenId - CLOB token ID
   * @param {'buy'|'sell'} side
   * @param {number} price - limit price
   * @param {number} size - order size in shares
   * @param {object} meta - additional metadata (marketId, strategy, negRisk, tickSize, etc.)
   */
  async placeOrder(tokenId, side, price, size, meta = {}) {
    const order = {
      id: `ord-${this._nextOrderId++}-${Date.now()}`,
      tokenId,
      side,
      price,
      size,
      filledSize: 0,
      status: 'open',
      createdAt: Date.now(),
      ...meta,
    };

    if (this.mode === 'paper') {
      this.openOrders.set(order.id, order);
      this.emit('order:placed', order);
      return order;
    }

    // ── Live mode: sign + submit to CLOB ──
    return this._submitLiveOrder(order);
  }

  /**
   * Cancel an open order.
   */
  async cancelOrder(orderId) {
    const order = this.openOrders.get(orderId);
    if (!order) return null;

    // Live mode: cancel on CLOB first
    if (this.mode === 'live') {
      const clobOrderId = this._clobOrderIds.get(orderId);
      if (clobOrderId) {
        await this._cancelClobOrder(clobOrderId);
        this._clobOrderIds.delete(orderId);
      }
    }

    order.status = 'cancelled';
    order.cancelledAt = Date.now();
    this.openOrders.delete(orderId);
    this.cancelledOrders.push(order);
    this.emit('order:cancelled', order);
    return order;
  }

  /**
   * Cancel all open orders for a token.
   */
  async cancelAllForToken(tokenId) {
    const cancelled = [];
    for (const [id, order] of this.openOrders) {
      if (order.tokenId === tokenId) {
        // Live mode: cancel on CLOB
        if (this.mode === 'live') {
          const clobOrderId = this._clobOrderIds.get(id);
          if (clobOrderId) {
            try {
              await this._cancelClobOrder(clobOrderId);
            } catch (err) {
              this.emit('error', { type: 'cancel_failed', orderId: id, error: err.message });
            }
            this._clobOrderIds.delete(id);
          }
        }

        order.status = 'cancelled';
        order.cancelledAt = Date.now();
        this.openOrders.delete(id);
        this.cancelledOrders.push(order);
        cancelled.push(order);
      }
    }
    return cancelled;
  }

  /**
   * Simulate fill checks against current orderbook state (paper mode).
   * In live mode, polls CLOB API for order status updates.
   * Call this periodically to check if any open orders would have been filled.
   */
  async checkFills() {
    if (this.mode === 'live') {
      return this._pollLiveOrders();
    }

    // Paper mode: unchanged from original
    const fills = [];

    for (const [id, order] of this.openOrders) {
      try {
        const book = this.clob.getCachedBook(order.tokenId);
        if (!book) continue;

        let filled = false;

        if (order.side === 'buy') {
          if (book.bestAsk <= order.price && book.askDepth > 0) {
            const fillableSize = Math.min(order.size - order.filledSize, book.askDepth * 0.1);
            if (fillableSize > 0) {
              order.filledSize += fillableSize;
              if (order.filledSize >= order.size * 0.99) filled = true;
            }
          }
        } else {
          if (book.bestBid >= order.price && book.bidDepth > 0) {
            const fillableSize = Math.min(order.size - order.filledSize, book.bidDepth * 0.1);
            if (fillableSize > 0) {
              order.filledSize += fillableSize;
              if (order.filledSize >= order.size * 0.99) filled = true;
            }
          }
        }

        if (filled) {
          order.status = 'filled';
          order.filledAt = Date.now();
          this.openOrders.delete(id);
          this.filledOrders.push(order);
          fills.push(order);
          this.emit('order:filled', order);
        }
      } catch {
        /* skip check errors */
      }
    }

    return fills;
  }

  /**
   * Get all open orders.
   */
  getOpenOrders(tokenId) {
    if (tokenId) {
      return Array.from(this.openOrders.values()).filter((o) => o.tokenId === tokenId);
    }
    return Array.from(this.openOrders.values());
  }

  getStats() {
    return {
      mode: this.mode,
      signerAddress: this.signer ? this.signer.address : null,
      openOrders: this.openOrders.size,
      filledOrders: this.filledOrders.length,
      cancelledOrders: this.cancelledOrders.length,
      totalPnl: this.filledOrders.reduce((sum, o) => {
        const fillValue = o.filledSize * o.price;
        return sum + (o.side === 'sell' ? fillValue : -fillValue);
      }, 0),
    };
  }

  // ── Live mode internals ────────────────────────────────────────────────────

  /**
   * Sign an order via EIP-712, submit to CLOB POST /order, handle response.
   * @private
   */
  async _submitLiveOrder(order) {
    const sideUpper = order.side.toUpperCase(); // 'BUY' | 'SELL'

    let signedPayload;
    try {
      signedPayload = await this.signer.signOrder({
        tokenId: order.tokenId,
        side: sideUpper,
        price: order.price,
        size: order.size,
        negRisk: order.negRisk || false,
        feeRateBps: order.feeRateBps || 0,
        tickSize: order.tickSize || '0.01',
        expirationSec: order.expirationSec || 300,
      });
    } catch (err) {
      order.status = 'rejected';
      order.error = `Signing failed: ${err.message}`;
      this.emit('order:rejected', order);
      return order;
    }

    // Submit with retry on rate limit
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
      try {
        const bodyStr = JSON.stringify(signedPayload);
        const headers = this.signer.getAuthHeaders('POST', '/order', bodyStr);

        const resp = await axios.post(`${this.clobRestUrl}/order`, signedPayload, {
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          timeout: 15000,
        });

        const data = resp.data;

        if (data.success || data.orderID) {
          order.clobOrderId = data.orderID || null;
          order.clobStatus = data.status || CLOB_STATUS.LIVE;
          order.status = 'open';
          order.submittedAt = Date.now();

          // Track CLOB order ID for polling/cancellation
          if (order.clobOrderId) {
            this._clobOrderIds.set(order.id, order.clobOrderId);
          }

          this.openOrders.set(order.id, order);
          this.emit('order:placed', order);

          // If immediately matched, handle fill
          if (data.status === CLOB_STATUS.MATCHED) {
            order.status = 'filled';
            order.filledSize = order.size;
            order.filledAt = Date.now();
            order.transactionHashes = data.transactionsHashes || [];
            order.tradeIds = data.tradeIDs || [];
            this.openOrders.delete(order.id);
            this.filledOrders.push(order);
            this.emit('order:filled', order);
          }

          return order;
        }

        // CLOB returned success=false
        order.status = 'rejected';
        order.error = data.errorMsg || 'Unknown CLOB rejection';
        this.emit('order:rejected', order);
        return order;
      } catch (err) {
        lastErr = err;
        const status = err.response?.status;

        if (status === 429) {
          // Rate limited - back off and retry
          const retryAfter = parseFloat(err.response?.headers?.['retry-after'] || '0');
          const backoff = retryAfter > 0
            ? Math.round(retryAfter * 1000)
            : RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt - 1);

          this.emit('rate_limit', { orderId: order.id, attempt, backoffMs: backoff });
          await sleep(backoff);
          continue;
        }

        if (status === 503) {
          // Trading disabled
          order.status = 'rejected';
          order.error = 'Trading disabled (503)';
          this.emit('order:rejected', order);
          return order;
        }

        if (status === 401) {
          order.status = 'rejected';
          order.error = 'Invalid API key (401)';
          this.emit('order:rejected', order);
          return order;
        }

        // Other HTTP error
        break;
      }
    }

    // Exhausted retries
    order.status = 'rejected';
    order.error = lastErr
      ? `CLOB submission failed: ${lastErr.response?.data?.errorMsg || lastErr.message}`
      : 'CLOB submission failed: unknown error';
    this.emit('order:rejected', order);
    return order;
  }

  /**
   * Poll CLOB API for status updates on live open orders.
   * @private
   * @returns {Array} list of orders that transitioned to filled/cancelled
   */
  async _pollLiveOrders() {
    const updates = [];

    for (const [localId, order] of this.openOrders) {
      const clobOrderId = this._clobOrderIds.get(localId);
      if (!clobOrderId) continue;

      try {
        const status = await this._getClobOrderStatus(clobOrderId);

        if (status === ORDER_STATUS_MATCHED) {
          order.status = 'filled';
          order.filledSize = order.size;
          order.filledAt = Date.now();
          this.openOrders.delete(localId);
          this._clobOrderIds.delete(localId);
          this.filledOrders.push(order);
          updates.push(order);
          this.emit('order:filled', order);
        } else if (status === ORDER_STATUS_CANCELED || status === ORDER_STATUS_INVALID) {
          order.status = 'cancelled';
          order.cancelledAt = Date.now();
          order.cancelReason = status;
          this.openOrders.delete(localId);
          this._clobOrderIds.delete(localId);
          this.cancelledOrders.push(order);
          updates.push(order);
          this.emit('order:cancelled', order);
        }
        // ORDER_STATUS_LIVE -> no change, keep polling
      } catch (err) {
        this.emit('error', { type: 'poll_failed', orderId: localId, error: err.message });
      }
    }

    return updates;
  }

  /**
   * Fetch order status from CLOB API: GET /order/{orderID}
   * @private
   * @param {string} clobOrderId
   * @returns {string} CLOB order status
   */
  async _getClobOrderStatus(clobOrderId) {
    const path = `/order/${clobOrderId}`;
    const headers = this.signer.getAuthHeaders('GET', path);

    const resp = await axios.get(`${this.clobRestUrl}${path}`, {
      headers,
      timeout: 10000,
    });

    return resp.data?.status || null;
  }

  /**
   * Cancel an order on the CLOB: DELETE /order
   * @private
   * @param {string} clobOrderId
   */
  async _cancelClobOrder(clobOrderId) {
    const body = { orderID: clobOrderId };
    const bodyStr = JSON.stringify(body);
    const headers = this.signer.getAuthHeaders('DELETE', '/order', bodyStr);

    const resp = await axios.delete(`${this.clobRestUrl}/order`, {
      data: body,
      headers: {
        'Content-Type': 'application/json',
        ...headers,
      },
      timeout: 10000,
    });

    return resp.data;
  }

  /**
   * Poll a specific order until it settles (filled, cancelled, or timeout).
   * Useful for strategies that need synchronous fill confirmation.
   *
   * @param {string} orderId - local order ID
   * @param {object} [opts]
   * @param {number} [opts.intervalMs=2000]
   * @param {number} [opts.maxAttempts=30]
   * @returns {Promise<object>} settled order
   */
  async waitForFill(orderId, opts = {}) {
    const intervalMs = opts.intervalMs || POLL_INTERVAL_MS;
    const maxAttempts = opts.maxAttempts || POLL_MAX_ATTEMPTS;

    for (let i = 0; i < maxAttempts; i++) {
      const order = this.openOrders.get(orderId);
      if (!order) {
        // Already settled
        const filled = this.filledOrders.find((o) => o.id === orderId);
        const cancelled = this.cancelledOrders.find((o) => o.id === orderId);
        return filled || cancelled || null;
      }

      if (this.mode === 'live') {
        const clobOrderId = this._clobOrderIds.get(orderId);
        if (clobOrderId) {
          try {
            const status = await this._getClobOrderStatus(clobOrderId);
            if (status === ORDER_STATUS_MATCHED) {
              order.status = 'filled';
              order.filledSize = order.size;
              order.filledAt = Date.now();
              this.openOrders.delete(orderId);
              this._clobOrderIds.delete(orderId);
              this.filledOrders.push(order);
              this.emit('order:filled', order);
              return order;
            }
            if (status === ORDER_STATUS_CANCELED || status === ORDER_STATUS_INVALID) {
              order.status = 'cancelled';
              order.cancelledAt = Date.now();
              order.cancelReason = status;
              this.openOrders.delete(orderId);
              this._clobOrderIds.delete(orderId);
              this.cancelledOrders.push(order);
              this.emit('order:cancelled', order);
              return order;
            }
          } catch {
            /* poll error, retry */
          }
        }
      } else {
        // Paper mode: run a fill check
        await this.checkFills();
        if (!this.openOrders.has(orderId)) {
          const filled = this.filledOrders.find((o) => o.id === orderId);
          const cancelled = this.cancelledOrders.find((o) => o.id === orderId);
          return filled || cancelled || null;
        }
      }

      await sleep(intervalMs);
    }

    // Timed out - return current state
    return this.openOrders.get(orderId) || null;
  }
}

module.exports = OrderManager;
