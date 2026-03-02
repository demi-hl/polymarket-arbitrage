/**
 * Historical Data Store
 * Persists market snapshots, trades, and outcomes to a JSON-backed store.
 * Uses flat files (no native SQLite dependency) with indexed lookups.
 * Can be swapped for SQLite/Postgres in production.
 */
const fs = require('fs').promises;
const path = require('path');

const DEFAULT_DIR = path.join(__dirname, '..', 'data', 'learning');

class DataStore {
  constructor(config = {}) {
    this.dir = config.dir || DEFAULT_DIR;
    this.maxSnapshots = config.maxSnapshots || 50000;
    this.maxTrades = config.maxTrades || 10000;

    this._snapshots = [];
    this._trades = [];
    this._outcomes = [];
    this._loaded = false;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    await this._load();
    this._loaded = true;
    return this;
  }

  // ── Market Snapshots ──

  async recordSnapshot(market) {
    const record = {
      ts: Date.now(),
      marketId: market.marketId || market.id,
      conditionId: market.conditionId,
      question: market.question,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      spread: market.spread,
      liquidity: market.liquidity,
      volume: market.volume,
      pricingSource: market.pricingSource || 'gamma',
      clobYesDepth: market.clobYesDepth || null,
      clobNoDepth: market.clobNoDepth || null,
      endDate: market.endDate,
      category: market.category,
    };

    this._snapshots.push(record);
    if (this._snapshots.length > this.maxSnapshots) {
      this._snapshots = this._snapshots.slice(-this.maxSnapshots);
    }
    await this._saveFile('snapshots.json', this._snapshots);
    return record;
  }

  async recordBatchSnapshots(markets) {
    const records = markets.map(m => ({
      ts: Date.now(),
      marketId: m.marketId || m.id,
      conditionId: m.conditionId,
      question: m.question,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice,
      spread: m.spread,
      liquidity: m.liquidity,
      volume: m.volume,
      pricingSource: m.pricingSource || 'gamma',
      endDate: m.endDate,
      category: m.category,
    }));

    this._snapshots.push(...records);
    if (this._snapshots.length > this.maxSnapshots) {
      this._snapshots = this._snapshots.slice(-this.maxSnapshots);
    }
    await this._saveFile('snapshots.json', this._snapshots);
    return records.length;
  }

  // ── Trade Records ──

  async recordTrade(trade) {
    const record = {
      ts: Date.now(),
      tradeId: trade.id,
      marketId: trade.marketId,
      strategy: trade.strategy,
      direction: trade.direction,
      yesPrice: trade.yesPrice,
      noPrice: trade.noPrice,
      totalCost: trade.totalCost,
      grossEdge: trade.grossEdge,
      executableEdge: trade.executableEdge,
      netEdge: trade.netEdge,
      slippageCost: trade.slippageCost,
      pricingSource: trade.pricingSource || 'gamma',
      expectedProfit: trade.expectedProfit,
      realizedPnl: trade.realizedPnl || null,
      status: trade.status || 'open',
    };

    this._trades.push(record);
    if (this._trades.length > this.maxTrades) {
      this._trades = this._trades.slice(-this.maxTrades);
    }
    await this._saveFile('trades.json', this._trades);
    return record;
  }

  async updateTradeOutcome(tradeId, realizedPnl, status = 'closed') {
    const trade = this._trades.find(t => t.tradeId === tradeId);
    if (trade) {
      trade.realizedPnl = realizedPnl;
      trade.status = status;
      trade.closedAt = Date.now();
      await this._saveFile('trades.json', this._trades);
    }
    return trade;
  }

  // ── Market Outcomes ──

  async recordOutcome(outcome) {
    this._outcomes.push({
      ts: Date.now(),
      marketId: outcome.marketId,
      conditionId: outcome.conditionId,
      resolved: outcome.resolved,
      winningOutcome: outcome.winningOutcome,
    });
    await this._saveFile('outcomes.json', this._outcomes);
  }

  // ── Query Methods ──

  getSnapshotsForMarket(marketId, limit = 100) {
    return this._snapshots
      .filter(s => s.marketId === marketId)
      .slice(-limit);
  }

  getTradesForStrategy(strategy) {
    return this._trades.filter(t => t.strategy === strategy);
  }

  getClosedTrades(sinceTs = 0) {
    return this._trades.filter(t => t.status === 'closed' && t.ts >= sinceTs);
  }

  getAllTrades() {
    return [...this._trades];
  }

  getAllSnapshots() {
    return [...this._snapshots];
  }

  getMarketHistory(marketId) {
    const snapshots = this.getSnapshotsForMarket(marketId);
    if (snapshots.length < 2) return { velocity: 0, volatility: 0 };

    const prices = snapshots.map(s => s.yesPrice);
    const diffs = [];
    for (let i = 1; i < prices.length; i++) {
      diffs.push(prices[i] - prices[i - 1]);
    }

    const velocity = diffs.reduce((s, d) => s + d, 0) / diffs.length;
    const mean = prices.reduce((s, p) => s + p, 0) / prices.length;
    const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length;

    return { velocity, volatility: Math.sqrt(variance), snapshots: snapshots.length };
  }

  getStrategyStats() {
    const stats = {};
    for (const trade of this._trades) {
      const s = trade.strategy || 'unknown';
      if (!stats[s]) stats[s] = { total: 0, wins: 0, losses: 0, pnl: 0 };
      stats[s].total++;
      const pnl = trade.realizedPnl ?? trade.expectedProfit ?? 0;
      stats[s].pnl += pnl;
      if (pnl > 0) stats[s].wins++;
      else if (pnl < 0) stats[s].losses++;
    }
    for (const s of Object.values(stats)) {
      s.winRate = s.total > 0 ? s.wins / s.total : 0;
    }
    return stats;
  }

  // ── Persistence ──

  async _load() {
    this._snapshots = await this._loadFile('snapshots.json', []);
    this._trades = await this._loadFile('trades.json', []);
    this._outcomes = await this._loadFile('outcomes.json', []);
  }

  async _loadFile(name, fallback) {
    try {
      const raw = await fs.readFile(path.join(this.dir, name), 'utf8');
      return JSON.parse(raw);
    } catch {
      return fallback;
    }
  }

  async _saveFile(name, data) {
    try {
      await fs.writeFile(path.join(this.dir, name), JSON.stringify(data));
    } catch (err) {
      console.error(`DataStore save failed (${name}): ${err.message}`);
    }
  }

  async getStats() {
    return {
      snapshots: this._snapshots.length,
      trades: this._trades.length,
      outcomes: this._outcomes.length,
      oldestSnapshot: this._snapshots[0]?.ts || null,
      newestSnapshot: this._snapshots[this._snapshots.length - 1]?.ts || null,
    };
  }
}

module.exports = DataStore;
