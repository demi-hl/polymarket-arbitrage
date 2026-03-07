/**
 * Rust Trade Trainer
 *
 * Periodically fetches closed trades from the Rust latency engine
 * and sends them to the GPU worker's /train/edge endpoint for
 * EdgePredictor retraining. Also feeds outcomes to the local
 * EdgeModel for online gradient updates.
 *
 * This closes the feedback loop: Rust engine executes trades ->
 * outcomes are recorded -> GPU model retrains -> better predictions.
 *
 * Lifecycle:
 *   const trainer = new RustTradeTrainer({ gpuClient, edgeModel });
 *   trainer.start();   // begins 60s polling
 *   trainer.stop();    // cleans up
 */

const axios = require('axios');

const RUST_ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://127.0.0.1:8900';
const SYNC_INTERVAL_MS = Number(process.env.RUST_TRAIN_INTERVAL_MS) || 60_000;
const BATCH_SIZE = 50; // max trades per GPU training call

class RustTradeTrainer {
  /**
   * @param {object} opts
   * @param {import('../lib/gpu-client')} opts.gpuClient  - GPU worker HTTP client
   * @param {import('./edge-model')|null} opts.edgeModel  - local EdgeModel for online updates (optional)
   */
  constructor({ gpuClient, edgeModel = null } = {}) {
    this.gpu = gpuClient;
    this.edgeModel = edgeModel;

    // Track which Rust trade IDs have already been sent to the GPU
    this._sentTradeIds = new Set();
    // Track which trade IDs have been fed to the local EdgeModel
    this._localTrainedIds = new Set();

    this._timer = null;
    this._running = false;
    this._stats = {
      syncs: 0,
      tradesSentToGpu: 0,
      tradesLocalTrained: 0,
      gpuErrors: 0,
      fetchErrors: 0,
      lastSyncAt: null,
      lastGpuTrainAt: null,
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;

    console.log(`[rust-trade-trainer] Starting (interval=${SYNC_INTERVAL_MS / 1000}s, engine=${RUST_ENGINE_URL})`);

    // Initial sync after a short delay to let services warm up
    setTimeout(() => this._syncOnce().catch(this._logError), 5_000);

    this._timer = setInterval(() => {
      this._syncOnce().catch(this._logError);
    }, SYNC_INTERVAL_MS);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    console.log('[rust-trade-trainer] Stopped');
  }

  getStats() {
    return {
      ...this._stats,
      sentTradeIds: this._sentTradeIds.size,
      localTrainedIds: this._localTrainedIds.size,
      running: this._running,
    };
  }

  // ── Core Sync Loop ────────────────────────────────────────────

  async _syncOnce() {
    this._stats.syncs++;

    // 1. Fetch trades from Rust engine
    let rustTrades;
    try {
      const { data } = await axios.get(`${RUST_ENGINE_URL}/trades`, { timeout: 3000 });
      rustTrades = Array.isArray(data) ? data : [];
    } catch (err) {
      this._stats.fetchErrors++;
      // Don't spam logs if engine is just offline
      if (this._stats.fetchErrors <= 3 || this._stats.fetchErrors % 20 === 0) {
        console.error(`[rust-trade-trainer] Rust engine fetch failed (${this._stats.fetchErrors}x): ${err.message}`);
      }
      return;
    }

    // 2. Filter to closed trades with PnL that haven't been sent yet
    const newForGpu = rustTrades.filter(t =>
      t.status === 'filled' &&
      t.pnl != null &&
      !this._sentTradeIds.has(t.id)
    );

    const newForLocal = rustTrades.filter(t =>
      t.status === 'filled' &&
      t.pnl != null &&
      !this._localTrainedIds.has(t.id)
    );

    // 3. Feed to local EdgeModel (fast, always do this)
    if (this.edgeModel && newForLocal.length > 0) {
      for (const trade of newForLocal) {
        try {
          const localFormat = this._toEdgeModelFormat(trade);
          this.edgeModel.recordOutcome(localFormat);
          this._localTrainedIds.add(trade.id);
          this._stats.tradesLocalTrained++;
        } catch (err) {
          // Non-fatal: local model is a nice-to-have
          console.error(`[rust-trade-trainer] Local model update failed for ${trade.id}: ${err.message}`);
        }
      }
    }

    // 4. Batch-send to GPU worker
    if (newForGpu.length > 0) {
      const gpuSamples = newForGpu.map(t => this._toGpuTrainingSample(t));

      // Send in batches to avoid overwhelming the GPU
      for (let i = 0; i < gpuSamples.length; i += BATCH_SIZE) {
        const batch = gpuSamples.slice(i, i + BATCH_SIZE);
        try {
          const result = await this.gpu.trainEdge(batch);
          if (result) {
            // Mark all trades in this batch as sent
            const batchIds = newForGpu.slice(i, i + BATCH_SIZE).map(t => t.id);
            for (const id of batchIds) {
              this._sentTradeIds.add(id);
            }
            this._stats.tradesSentToGpu += batch.length;
            this._stats.lastGpuTrainAt = new Date().toISOString();

            if (batch.length >= 5 || this._stats.syncs <= 3) {
              const wins = batch.filter(s => s.outcome === 1).length;
              console.log(`[rust-trade-trainer] GPU trained on ${batch.length} Rust trades (${wins}W/${batch.length - wins}L)`);
            }
          } else {
            // GPU unavailable or returned null -- will retry next cycle
            this._stats.gpuErrors++;
            if (this._stats.gpuErrors <= 3) {
              console.warn('[rust-trade-trainer] GPU trainEdge returned null (GPU unavailable?)');
            }
          }
        } catch (err) {
          this._stats.gpuErrors++;
          console.error(`[rust-trade-trainer] GPU trainEdge failed: ${err.message}`);
        }
      }
    }

    this._stats.lastSyncAt = new Date().toISOString();
  }

  // ── Format Converters ────────────────────────────────────────

  /**
   * Convert a Rust Trade into the format expected by GPUClient.trainEdge().
   * The GPU /train/edge endpoint expects an array of trade objects with
   * features and an outcome label.
   */
  _toGpuTrainingSample(rustTrade) {
    const side = String(rustTrade.side || '').toLowerCase();
    const pnl = rustTrade.pnl != null ? rustTrade.pnl : 0;
    const cost = rustTrade.cost || 1;

    return {
      // Identifiers
      trade_id: rustTrade.id,
      market_id: rustTrade.contract_token_id || rustTrade.id,
      strategy: 'crypto-latency-arb',
      source: 'rust-engine',

      // Features the GPU model can learn from
      entry_price: rustTrade.price || 0.5,
      exit_price: rustTrade.exit_price || rustTrade.price || 0.5,
      size: rustTrade.size || 0,
      cost: cost,
      divergence_at_entry: Math.abs(rustTrade.divergence_at_entry || 0),
      direction: side === 'buy' ? 'BUY_YES' : 'BUY_NO',
      asset: String(rustTrade.asset || 'btc').toUpperCase(),

      // Execution quality features
      fill_ratio: rustTrade.fill_ratio != null ? rustTrade.fill_ratio : 1.0,
      fees_paid: rustTrade.fees_paid || 0,
      hold_ms: rustTrade.hold_ms || 0,
      entry_slippage_bps: rustTrade.entry_slippage_bps || 0,
      exit_slippage_bps: rustTrade.exit_slippage_bps || 0,

      // Shadow execution comparison (paper vs would-be-live)
      shadow_pnl: rustTrade.shadow_pnl,
      shadow_entry_price: rustTrade.shadow_entry_price,
      shadow_exit_price: rustTrade.shadow_exit_price,
      shadow_slippage_bps: rustTrade.shadow_slippage_bps,

      // Outcome label: 1 = profitable, 0 = loss
      outcome: pnl > 0 ? 1 : 0,
      realized_pnl: pnl,
      return_pct: cost > 0 ? (pnl / cost) * 100 : 0,

      // Timestamps
      submitted_at: rustTrade.submitted_at,
      filled_at: rustTrade.filled_at,
    };
  }

  /**
   * Convert a Rust Trade into the format expected by EdgeModel.recordOutcome().
   * Must match the shape that _gradientStep expects via featureEngine.
   */
  _toEdgeModelFormat(rustTrade) {
    const side = String(rustTrade.side || '').toLowerCase();
    const divergence = Math.abs(rustTrade.divergence_at_entry || 0);

    return {
      marketId: rustTrade.contract_token_id || rustTrade.id,
      conditionId: rustTrade.contract_token_id || '',
      strategy: 'crypto-latency-arb',
      category: 'crypto-latency',
      direction: side === 'buy' ? 'BUY_YES' : 'BUY_NO',
      pricingSource: 'rust-engine',

      // Edge values
      grossEdge: divergence,
      netEdge: divergence,
      executableEdge: divergence,
      edgePercent: divergence,

      // Price data
      yesPrice: rustTrade.price || 0.5,
      noPrice: 1 - (rustTrade.price || 0.5),

      // Slippage
      slippageCost: (rustTrade.entry_slippage_bps || 0) / 10000,

      // The key outcome field that EdgeModel.recordOutcome() uses
      realizedPnl: rustTrade.pnl != null ? rustTrade.pnl : 0,
    };
  }

  _logError(err) {
    console.error(`[rust-trade-trainer] Unhandled error: ${err.message}`);
  }
}

module.exports = RustTradeTrainer;
