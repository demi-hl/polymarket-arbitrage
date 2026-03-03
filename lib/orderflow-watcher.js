/**
 * OrderflowWatcher — Real-time whale/orderflow detection engine
 *
 * Attaches to ClobClient WebSocket and monitors:
 *   - Large trade executions (whale $500+, mega-whale $5000+)
 *   - Orderbook depth bombs (>30% sudden depth change)
 *   - Volume acceleration (5-min rolling vs 1-hour baseline)
 *   - Whale consensus (3+ whale trades same direction within 5 min)
 *
 * Emits: 'whale-trade', 'mega-whale-trade', 'depth-bomb',
 *        'volume-acceleration', 'whale-consensus'
 */

const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const LOG_PATH = path.join(__dirname, '..', 'data', 'orderflow-log.json');

class OrderflowWatcher extends EventEmitter {
  constructor(clobClient, imbalanceAnalyzer, config = {}) {
    super();
    this.clob = clobClient;
    this.imbalance = imbalanceAnalyzer;

    // Thresholds
    this.whaleThreshold = config.whaleThreshold || 500;
    this.megaWhaleThreshold = config.megaWhaleThreshold || 5000;
    this.consensusCount = config.consensusCount || 3;
    this.consensusWindowMs = config.consensusWindowMs || 300_000; // 5 min
    this.consensusCooldownMs = config.consensusCooldownMs || 600_000; // 10 min
    this.volumeWindowMs = config.volumeWindowMs || 300_000; // 5 min rolling
    this.volumeBaselineMs = config.volumeBaselineMs || 3_600_000; // 1 hour
    this.volumeSpikeMultiplier = config.volumeSpikeMultiplier || 3;
    this.depthChangeThreshold = config.depthChangeThreshold || 0.30; // 30%
    this.persistIntervalMs = config.persistIntervalMs || 60_000;
    this.maxLogEntries = config.maxLogEntries || 5000;

    // State
    this._tradeWindows = new Map();    // assetId -> [{ side, dollarSize, price, ts }]
    this._volumeAccum = new Map();     // assetId -> { recent: number, baseline: number, recentStart: ts, baselineStart: ts }
    this._depthSnapshots = new Map();  // assetId -> { bidDepth, askDepth, ts }
    this._whaleConsensus = new Map();  // assetId -> [{ side, size, ts, weight }]
    this._consensusCooldowns = new Map(); // assetId -> cooldown expiry ts
    this._pendingSignals = [];
    this._activityLog = [];
    this._started = false;

    // Stats
    this._stats = {
      totalTrades: 0,
      whaleTrades: 0,
      megaWhaleTrades: 0,
      depthBombs: 0,
      consensusSignals: 0,
      startedAt: null,
    };
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._stats.startedAt = Date.now();

    // Load persisted log
    this._loadLog();

    // Attach to ClobClient events
    this.clob.on('trade', (trade) => this._onTrade(trade));
    this.clob.on('book', ({ assetId, book }) => this._onBookUpdate(assetId, book));
    this.clob.on('price', (priceChange) => this._onPriceChange(priceChange));

    // Periodic persistence
    this._persistTimer = setInterval(() => this._persist(), this.persistIntervalMs);

    // Periodic cleanup of stale window data
    this._cleanupTimer = setInterval(() => this._cleanup(), 60_000);

    console.log('[OrderflowWatcher] Started — whale=$' + this.whaleThreshold +
      ' mega=$' + this.megaWhaleThreshold +
      ' consensus=' + this.consensusCount + ' in ' + (this.consensusWindowMs / 1000) + 's');
  }

  stop() {
    if (!this._started) return;
    this._started = false;
    clearInterval(this._persistTimer);
    clearInterval(this._cleanupTimer);
    this._persist();
    console.log('[OrderflowWatcher] Stopped');
  }

  // ── Event Handlers ──

  _onTrade(trade) {
    const { assetId, price, size, side, timestamp } = trade;
    if (!assetId || !size || size <= 0 || !price || price <= 0) return;

    this._stats.totalTrades++;
    const dollarSize = size * price;
    const ts = timestamp || Date.now();

    // Record in rolling window
    this._recordTrade(assetId, { side, dollarSize, price, ts });

    // Update volume accumulator
    this._updateVolume(assetId, dollarSize, ts);

    // Classify
    if (dollarSize >= this.megaWhaleThreshold) {
      this._stats.megaWhaleTrades++;
      this._onMegaWhale(assetId, side, dollarSize, price, ts);
    } else if (dollarSize >= this.whaleThreshold) {
      this._stats.whaleTrades++;
      this._onWhale(assetId, side, dollarSize, price, ts);
    }
  }

  _onWhale(assetId, side, dollarSize, price, ts) {
    const entry = { type: 'whale', assetId, side, size: dollarSize, price, timestamp: ts };
    this._logActivity(entry);
    this.emit('whale-trade', entry);

    // Add to consensus tracker
    const consensus = this._whaleConsensus.get(assetId) || [];
    consensus.push({ side: this._normSide(side), size: dollarSize, ts, weight: 1 });
    this._whaleConsensus.set(assetId, consensus);
    this._checkConsensus(assetId);
  }

  _onMegaWhale(assetId, side, dollarSize, price, ts) {
    const entry = { type: 'mega-whale', assetId, side, size: dollarSize, price, timestamp: ts };
    this._logActivity(entry);
    this.emit('mega-whale-trade', entry);

    // Mega whales count double for consensus
    const consensus = this._whaleConsensus.get(assetId) || [];
    consensus.push({ side: this._normSide(side), size: dollarSize, ts, weight: 2 });
    this._whaleConsensus.set(assetId, consensus);
    this._checkConsensus(assetId);
  }

  _checkConsensus(assetId) {
    const now = Date.now();

    // Check cooldown
    const cooldownExpiry = this._consensusCooldowns.get(assetId) || 0;
    if (now < cooldownExpiry) return;

    // Filter to consensus window
    const all = this._whaleConsensus.get(assetId) || [];
    const recent = all.filter(w => now - w.ts < this.consensusWindowMs);
    this._whaleConsensus.set(assetId, recent);

    if (recent.length < 2) return;

    // Count weighted votes per side
    let buyWeight = 0, sellWeight = 0;
    let buyVolume = 0, sellVolume = 0;
    for (const w of recent) {
      if (w.side === 'buy') {
        buyWeight += w.weight;
        buyVolume += w.size;
      } else {
        sellWeight += w.weight;
        sellVolume += w.size;
      }
    }

    const dominantSide = buyWeight >= sellWeight ? 'buy' : 'sell';
    const dominantWeight = Math.max(buyWeight, sellWeight);
    const dominantVolume = dominantSide === 'buy' ? buyVolume : sellVolume;
    const totalVolume = buyVolume + sellVolume;

    if (dominantWeight >= this.consensusCount) {
      this._stats.consensusSignals++;

      const signal = {
        type: 'whale-consensus',
        assetId,
        direction: dominantSide === 'buy' ? 'BUY_YES' : 'BUY_NO',
        side: dominantSide,
        whaleCount: recent.length,
        weightedCount: dominantWeight,
        totalVolume,
        dominantVolume,
        buyRatio: totalVolume > 0 ? buyVolume / totalVolume : 0.5,
        timestamp: now,
        trades: recent.map(w => ({ side: w.side, size: w.size, ts: w.ts })),
      };

      this._pendingSignals.push(signal);
      this._logActivity({ ...signal, trades: undefined });
      this.emit('whale-consensus', signal);

      // Set cooldown
      this._consensusCooldowns.set(assetId, now + this.consensusCooldownMs);

      console.log(`[OrderflowWatcher] CONSENSUS: ${assetId.slice(0, 12)}... ${dominantSide.toUpperCase()} ` +
        `whales=${recent.length} weight=${dominantWeight} vol=$${Math.round(totalVolume)}`);
    }
  }

  _onBookUpdate(assetId, book) {
    if (!book) return;

    const bidDepth = book.bidDepth || (book.bids || []).reduce((s, l) => s + (l.size * l.price || 0), 0);
    const askDepth = book.askDepth || (book.asks || []).reduce((s, l) => s + (l.size * l.price || 0), 0);
    const now = Date.now();

    const prev = this._depthSnapshots.get(assetId);

    if (prev && (now - prev.ts) < 30_000) { // compare snapshots within 30s
      const prevTotal = prev.bidDepth + prev.askDepth;
      if (prevTotal > 100) { // only if previous depth was meaningful
        const bidChange = prevTotal > 0 ? Math.abs(bidDepth - prev.bidDepth) / prevTotal : 0;
        const askChange = prevTotal > 0 ? Math.abs(askDepth - prev.askDepth) / prevTotal : 0;

        if (bidChange > this.depthChangeThreshold || askChange > this.depthChangeThreshold) {
          this._stats.depthBombs++;
          const entry = {
            type: 'depth-bomb',
            assetId,
            bidDepthChange: parseFloat(bidChange.toFixed(3)),
            askDepthChange: parseFloat(askChange.toFixed(3)),
            newBidDepth: Math.round(bidDepth),
            newAskDepth: Math.round(askDepth),
            prevBidDepth: Math.round(prev.bidDepth),
            prevAskDepth: Math.round(prev.askDepth),
            direction: bidChange > askChange ? 'bid-side' : 'ask-side',
            timestamp: now,
          };
          this._logActivity(entry);
          this.emit('depth-bomb', entry);
        }
      }
    }

    this._depthSnapshots.set(assetId, { bidDepth, askDepth, ts: now });
  }

  _onPriceChange(priceChange) {
    // Price changes can indicate large order placement/cancellation
    // Currently used for awareness; depth-bomb detection handles the signal
  }

  // ── Volume Tracking ──

  _updateVolume(assetId, dollarSize, ts) {
    const now = ts || Date.now();
    let vol = this._volumeAccum.get(assetId);
    if (!vol) {
      vol = { recent: 0, baseline: 0, recentStart: now, baselineStart: now, trades: [] };
      this._volumeAccum.set(assetId, vol);
    }

    vol.trades.push({ size: dollarSize, ts: now });

    // Trim old trades
    const baselineCutoff = now - this.volumeBaselineMs;
    vol.trades = vol.trades.filter(t => t.ts > baselineCutoff);

    // Recalculate
    const recentCutoff = now - this.volumeWindowMs;
    vol.recent = vol.trades.filter(t => t.ts > recentCutoff).reduce((s, t) => s + t.size, 0);
    const olderTrades = vol.trades.filter(t => t.ts <= recentCutoff);
    const olderVolume = olderTrades.reduce((s, t) => s + t.size, 0);
    const olderWindowMs = Math.max(now - baselineCutoff - this.volumeWindowMs, 1);
    const baselineRate = olderVolume / (olderWindowMs / this.volumeWindowMs);
    vol.baseline = baselineRate;

    // Check for spike
    if (vol.baseline > 100 && vol.recent > vol.baseline * this.volumeSpikeMultiplier) {
      this.emit('volume-acceleration', {
        type: 'volume-acceleration',
        assetId,
        recentVolume: Math.round(vol.recent),
        baselineVolume: Math.round(vol.baseline),
        multiplier: parseFloat((vol.recent / vol.baseline).toFixed(1)),
        timestamp: now,
      });
    }
  }

  // ── Trade Window ──

  _recordTrade(assetId, trade) {
    let window = this._tradeWindows.get(assetId);
    if (!window) {
      window = [];
      this._tradeWindows.set(assetId, window);
    }
    window.push(trade);
    // Keep last 200 trades per token
    if (window.length > 200) {
      this._tradeWindows.set(assetId, window.slice(-200));
    }
  }

  // ── Public API ──

  drainSignals() {
    const signals = [...this._pendingSignals];
    this._pendingSignals = [];
    return signals;
  }

  getActivityFeed(limit = 50) {
    return this._activityLog.slice(-limit).reverse();
  }

  getStats() {
    return {
      ...this._stats,
      trackedTokens: this._tradeWindows.size,
      pendingSignals: this._pendingSignals.length,
      activityLogSize: this._activityLog.length,
      uptimeMs: this._stats.startedAt ? Date.now() - this._stats.startedAt : 0,
    };
  }

  getVolumeSnapshot() {
    const snapshot = [];
    for (const [assetId, vol] of this._volumeAccum) {
      if (vol.recent > 0) {
        snapshot.push({
          assetId: assetId.slice(0, 16) + '...',
          recentVolume: Math.round(vol.recent),
          baselineVolume: Math.round(vol.baseline),
          multiplier: vol.baseline > 0 ? parseFloat((vol.recent / vol.baseline).toFixed(1)) : 0,
        });
      }
    }
    return snapshot.sort((a, b) => b.recentVolume - a.recentVolume).slice(0, 20);
  }

  // ── Internal ──

  _normSide(side) {
    if (!side) return 'unknown';
    const s = side.toLowerCase();
    if (s === 'buy' || s === 'bid' || s === 'b') return 'buy';
    if (s === 'sell' || s === 'ask' || s === 's') return 'sell';
    return s;
  }

  _logActivity(entry) {
    this._activityLog.push(entry);
    if (this._activityLog.length > this.maxLogEntries) {
      this._activityLog = this._activityLog.slice(-this.maxLogEntries);
    }
  }

  _cleanup() {
    const now = Date.now();
    const windowCutoff = now - this.volumeBaselineMs;

    // Clean old trade windows
    for (const [assetId, window] of this._tradeWindows) {
      const filtered = window.filter(t => t.ts > windowCutoff);
      if (filtered.length === 0) {
        this._tradeWindows.delete(assetId);
      } else {
        this._tradeWindows.set(assetId, filtered);
      }
    }

    // Clean old consensus entries
    for (const [assetId, entries] of this._whaleConsensus) {
      const filtered = entries.filter(w => now - w.ts < this.consensusWindowMs);
      if (filtered.length === 0) {
        this._whaleConsensus.delete(assetId);
      } else {
        this._whaleConsensus.set(assetId, filtered);
      }
    }

    // Clean expired cooldowns
    for (const [assetId, expiry] of this._consensusCooldowns) {
      if (now > expiry) this._consensusCooldowns.delete(assetId);
    }

    // Clean old depth snapshots
    for (const [assetId, snap] of this._depthSnapshots) {
      if (now - snap.ts > 120_000) this._depthSnapshots.delete(assetId);
    }
  }

  _persist() {
    try {
      const dir = path.dirname(LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(LOG_PATH, JSON.stringify(this._activityLog));
    } catch (e) {
      console.error('[OrderflowWatcher] Persist error:', e.message);
    }
  }

  _loadLog() {
    try {
      const raw = fs.readFileSync(LOG_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        // Only load recent entries (last 24h)
        const cutoff = Date.now() - 86_400_000;
        this._activityLog = parsed.filter(e => (e.timestamp || 0) > cutoff);
        console.log(`[OrderflowWatcher] Loaded ${this._activityLog.length} activity entries from disk`);
      }
    } catch {
      this._activityLog = [];
    }
  }
}

module.exports = OrderflowWatcher;
