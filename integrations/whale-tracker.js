/**
 * Whale Tracker
 * Identifies and monitors profitable wallets via Polymarket's on-chain subgraphs.
 * Generates whale consensus signals for the strategy system.
 */
const SubgraphClient = require('./subgraph-client');
const EventEmitter = require('events');

const DEFAULT_CONFIG = {
  minWinRate: 0.58,
  minResolvedMarkets: 50,
  minRecentTrades: 5,
  recencyWindowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
  consensusThreshold: 3,                       // whales agreeing on a position
  maxTrackedWallets: 50,
  pollIntervalMs: 5 * 60 * 1000,              // check every 5 min
  positionMinUsd: 500,                         // ignore tiny positions
};

class WhaleTracker extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.subgraph = config.subgraphClient || new SubgraphClient();

    this.trackedWallets = new Map();
    this.walletPositions = new Map();
    this.consensusSignals = new Map();
    this._pollTimer = null;
    this._initialized = false;
  }

  async init() {
    if (this._initialized) return this;
    await this.discoverWhales();
    this._initialized = true;
    return this;
  }

  /**
   * Discover profitable wallets from the PnL subgraph.
   * Aggregates per-wallet stats and filters by win rate / volume.
   */
  async discoverWhales() {
    try {
      const pnlRecords = await this.subgraph.getTopProfitableWallets(200);

      const walletStats = new Map();
      for (const rec of pnlRecords) {
        const wallet = rec.user?.id;
        if (!wallet) continue;

        if (!walletStats.has(wallet)) {
          walletStats.set(wallet, { wallet, totalPnl: 0, wins: 0, totalMarkets: 0, trades: 0 });
        }
        const stats = walletStats.get(wallet);
        const pnl = parseFloat(rec.realizedPnl || 0);
        stats.totalPnl += pnl;
        stats.totalMarkets++;
        stats.trades += parseInt(rec.numTrades || 0, 10);
        if (pnl > 0) stats.wins++;
      }

      const candidates = [];
      for (const stats of walletStats.values()) {
        if (stats.totalMarkets < this.config.minResolvedMarkets) continue;
        stats.winRate = stats.wins / stats.totalMarkets;
        if (stats.winRate < this.config.minWinRate) continue;
        candidates.push(stats);
      }

      candidates.sort((a, b) => b.totalPnl - a.totalPnl);
      const top = candidates.slice(0, this.config.maxTrackedWallets);

      this.trackedWallets.clear();
      for (const w of top) {
        this.trackedWallets.set(w.wallet, w);
      }

      this.emit('whales:discovered', { count: top.length });
      return top;
    } catch (err) {
      console.error('Whale discovery failed:', err.message);
      return [];
    }
  }

  /**
   * Refresh positions for all tracked wallets.
   */
  async refreshPositions() {
    const results = [];

    for (const [wallet] of this.trackedWallets) {
      try {
        const positions = await this.subgraph.getWalletPositions(wallet, 50);
        const meaningful = positions.filter(p => {
          const bal = parseFloat(p.balance || 0);
          const price = parseFloat(p.averagePrice || 0);
          return bal * price >= this.config.positionMinUsd;
        });

        this.walletPositions.set(wallet, {
          positions: meaningful,
          updatedAt: Date.now(),
        });
        results.push({ wallet, positionCount: meaningful.length });
      } catch {
        // skip failed fetches
      }
    }

    this._buildConsensus();
    this.emit('positions:refreshed', { wallets: results.length });
    return results;
  }

  /**
   * Build consensus signals: markets where multiple tracked whales hold the same side.
   */
  _buildConsensus() {
    const marketVotes = new Map();

    for (const [wallet, data] of this.walletPositions) {
      const stats = this.trackedWallets.get(wallet);
      if (!stats) continue;

      for (const pos of data.positions) {
        const key = `${pos.condition}_${pos.outcomeIndex}`;
        if (!marketVotes.has(key)) {
          marketVotes.set(key, {
            conditionId: pos.condition,
            outcomeIndex: parseInt(pos.outcomeIndex, 10),
            wallets: [],
            totalSize: 0,
            avgWinRate: 0,
          });
        }
        const vote = marketVotes.get(key);
        vote.wallets.push({
          wallet,
          balance: parseFloat(pos.balance || 0),
          avgPrice: parseFloat(pos.averagePrice || 0),
          winRate: stats.winRate,
          totalPnl: stats.totalPnl,
        });
        vote.totalSize += parseFloat(pos.balance || 0);
      }
    }

    this.consensusSignals.clear();

    for (const [key, vote] of marketVotes) {
      if (vote.wallets.length < this.config.consensusThreshold) continue;
      vote.avgWinRate = vote.wallets.reduce((s, w) => s + w.winRate, 0) / vote.wallets.length;
      vote.confidence = Math.min(vote.wallets.length / 10, 1) * vote.avgWinRate;
      this.consensusSignals.set(key, vote);
    }

    this.emit('consensus:updated', { signals: this.consensusSignals.size });
  }

  /**
   * Get consensus signal for a specific market condition.
   * Returns the strongest signal (YES or NO side).
   */
  getConsensus(conditionId) {
    let best = null;
    for (const [, signal] of this.consensusSignals) {
      if (signal.conditionId !== conditionId) continue;
      if (!best || signal.confidence > best.confidence) best = signal;
    }
    return best;
  }

  /**
   * Get a confidence multiplier for a market based on whale consensus.
   * Returns 1.0 (no signal) to 2.0 (strong consensus).
   */
  getConfidenceMultiplier(conditionId) {
    const signal = this.getConsensus(conditionId);
    if (!signal) return 1.0;
    return 1.0 + signal.confidence;
  }

  /**
   * Get all current consensus signals sorted by confidence.
   */
  getAllSignals() {
    return Array.from(this.consensusSignals.values())
      .sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Start background polling for position updates.
   */
  startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(async () => {
      try {
        await this.refreshPositions();
      } catch (err) {
        this.emit('error', err);
      }
    }, this.config.pollIntervalMs);
    this.refreshPositions();
  }

  stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  getTrackedWallets() {
    return Array.from(this.trackedWallets.values());
  }

  getReport() {
    return {
      trackedWallets: this.trackedWallets.size,
      walletsWithPositions: this.walletPositions.size,
      consensusSignals: this.consensusSignals.size,
      topWallets: Array.from(this.trackedWallets.values())
        .slice(0, 10)
        .map(w => ({
          wallet: w.wallet.slice(0, 10) + '...',
          winRate: (w.winRate * 100).toFixed(1) + '%',
          totalPnl: w.totalPnl.toFixed(2),
          markets: w.totalMarkets,
        })),
      topSignals: this.getAllSignals().slice(0, 10).map(s => ({
        conditionId: s.conditionId,
        outcome: s.outcomeIndex === 0 ? 'YES' : 'NO',
        whales: s.wallets.length,
        confidence: (s.confidence * 100).toFixed(1) + '%',
        totalSize: s.totalSize.toFixed(2),
      })),
    };
  }
}

module.exports = WhaleTracker;
