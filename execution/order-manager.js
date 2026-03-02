/**
 * Order Manager
 * Manages limit order lifecycle for market making: create, track, cancel, fill.
 * In paper mode, simulates fills against the CLOB orderbook.
 * In live mode, would submit orders via the CLOB API (requires API key + wallet).
 */
const EventEmitter = require('events');
const ClobClient = require('../clob-client');

class OrderManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.mode = config.mode || 'paper';
    this.clob = config.clobClient || new ClobClient();

    this.openOrders = new Map();
    this.filledOrders = [];
    this.cancelledOrders = [];
    this._nextOrderId = 1;
  }

  /**
   * Place a limit order.
   * @param {string} tokenId - CLOB token ID
   * @param {'buy'|'sell'} side
   * @param {number} price - limit price
   * @param {number} size - order size in shares
   * @param {object} meta - additional metadata (marketId, strategy, etc.)
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

    // Live mode placeholder
    throw new Error('Live order placement requires CLOB API key and wallet signing');
  }

  /**
   * Cancel an open order.
   */
  async cancelOrder(orderId) {
    const order = this.openOrders.get(orderId);
    if (!order) return null;

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
   * Call this periodically to check if any open orders would have been filled.
   */
  async checkFills() {
    if (this.mode !== 'paper') return [];

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
      } catch { /* skip check errors */ }
    }

    return fills;
  }

  /**
   * Get all open orders.
   */
  getOpenOrders(tokenId) {
    if (tokenId) {
      return Array.from(this.openOrders.values()).filter(o => o.tokenId === tokenId);
    }
    return Array.from(this.openOrders.values());
  }

  getStats() {
    return {
      openOrders: this.openOrders.size,
      filledOrders: this.filledOrders.length,
      cancelledOrders: this.cancelledOrders.length,
      totalPnl: this.filledOrders.reduce((sum, o) => {
        const fillValue = o.filledSize * o.price;
        return sum + (o.side === 'sell' ? fillValue : -fillValue);
      }, 0),
    };
  }
}

module.exports = OrderManager;
