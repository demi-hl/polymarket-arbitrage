/**
 * Rust Trade Trainer
 *
 * Bridges the Rust latency engine's trade data with the GPU worker
 * for continuous model retraining. Periodically syncs completed trades
 * from the Rust engine, formats them for GPU training, and pushes
 * updated feature weights back.
 */
const axios = require('axios');

const RUST_ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://localhost:8900';
const SYNC_INTERVAL = 5 * 60 * 1000; // 5 minutes

class RustTradeTrainer {
  constructor({ gpuClient, edgeModel } = {}) {
    this.gpuClient = gpuClient;
    this.edgeModel = edgeModel;
    this.running = false;
    this.lastSync = null;
    this.syncCount = 0;
    this.tradesSynced = 0;
    this.errors = 0;
    this._interval = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._interval = setInterval(() => this._syncOnce().catch(() => {}), SYNC_INTERVAL);
    // Initial sync after 30s
    setTimeout(() => this._syncOnce().catch(() => {}), 30000);
  }

  stop() {
    this.running = false;
    if (this._interval) {
      clearInterval(this._interval);
      this._interval = null;
    }
  }

  getStats() {
    return {
      running: this.running,
      lastSync: this.lastSync,
      syncCount: this.syncCount,
      tradesSynced: this.tradesSynced,
      errors: this.errors,
    };
  }

  async _syncOnce() {
    try {
      // Fetch recent trades from Rust engine
      const rustTrades = await this._fetchRustTrades();
      if (!rustTrades || rustTrades.length === 0) {
        this.syncCount++;
        this.lastSync = Date.now();
        return;
      }

      // Format for GPU training
      const trainingData = rustTrades.map(t => ({
        features: this._extractFeatures(t),
        outcome: t.pnl > 0 ? 1 : 0,
        pnl: t.pnl || 0,
        strategy: t.strategy || 'crypto-latency-arb',
      }));

      // Push to edge model if available
      if (this.edgeModel) {
        for (const td of trainingData) {
          try {
            this.edgeModel.recordOutcome(td);
          } catch {}
        }
      }

      // Push to GPU for deep training if available
      if (this.gpuClient) {
        try {
          const available = await this.gpuClient.isAvailable();
          if (available) {
            await this.gpuClient.trainOnBatch(trainingData).catch(() => {});
          }
        } catch {}
      }

      this.tradesSynced += rustTrades.length;
      this.syncCount++;
      this.lastSync = Date.now();
    } catch (err) {
      this.errors++;
    }
  }

  async _fetchRustTrades() {
    try {
      const since = this.lastSync || Date.now() - 3600000; // Last hour if first sync
      const res = await axios.get(`${RUST_ENGINE_URL}/api/trades`, {
        params: { since },
        timeout: 5000,
      });
      return res.data?.trades || res.data || [];
    } catch {
      return [];
    }
  }

  _extractFeatures(trade) {
    return {
      price: trade.price || 0,
      size: trade.size || 0,
      latency_ms: trade.latency_ms || 0,
      spread: trade.spread || 0,
      depth_ratio: trade.depth_ratio || 1,
      volatility: trade.volatility || 0,
      time_of_day: new Date(trade.timestamp || Date.now()).getHours(),
    };
  }
}

module.exports = RustTradeTrainer;
