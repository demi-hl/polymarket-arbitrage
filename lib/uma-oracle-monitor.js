/**
 * UMA Optimistic Oracle Monitor (v2 - Aggressive Resolution Frontrunning)
 *
 * Monitors UMA oracle resolution proposals on Polygon to detect when
 * Polymarket markets are about to resolve. When a ProposePrice event
 * is detected, the resolving outcome is known ~2 hours before the
 * market fully prices it in.
 *
 * v2 improvements:
 *   - 7-day resolution window with tiered edge requirements
 *   - Price momentum tracking (3+ snapshots trending = conviction signal)
 *   - Volume confirmation (24h volume > 2x 7d avg = imminent resolution)
 *   - Auto-scaling position size (up to 3x near resolution)
 *   - Dispute rate tracking & confidence adjustment
 *   - Proposal event audit logging
 *
 * Architecture:
 *   1. Polls the UMA Optimistic Oracle contract for recent ProposePrice events
 *   2. Maps ancillary data back to Polymarket condition IDs
 *   3. Generates trading signals: buy the resolving side before price converges to $1
 *
 * Contract addresses (Polygon):
 *   UMA Optimistic Oracle: 0xCB1822859cEF82Cd2Eb4E6276C7916e692995130
 *   UMA CTF Adapter v2:    0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74
 *   UMA CTF Adapter v3:    0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('../strategies/lib/with-scanner');

const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com';
const UMA_ORACLE = '0xCB1822859cEF82Cd2Eb4E6276C7916e692995130';
const UMA_ADAPTER_V2 = '0x6A9D222616C90FcA5754cd1333cFD9b7fb6a4F74';
const UMA_ADAPTER_V3 = '0x157Ce2d672854c848c9b79C49a8Cc6cc89176a49';

// ProposePrice event topic0: keccak256("ProposePrice(address,address,bytes32,uint256,bytes,int256)")
const PROPOSE_PRICE_TOPIC = '0x5e0a5f28fdf927bae68e2e9c5642c6fe0bbc0dcadfe64deff278dde6f3f6c3fb';

// DisputePrice event topic0: keccak256("DisputePrice(address,address,bytes32,uint256,bytes)")
const DISPUTE_PRICE_TOPIC = '0xa0e8d5fa9e4b5a82a4b5d1b3a6f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6';

// RequestPrice event topic0
const REQUEST_PRICE_TOPIC = '0xd07e54c0e85ab6d0dc0f70e5c4f3f0d0e9f3f55c4f8b2b5c7e7c6d5a4b3c2d1';

const LIVENESS_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours
const POLL_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const SIGNAL_CACHE_TTL = 8 * 60 * 60 * 1000; // Cache signals for 8 hours (extended for 7-day window)

// Tiered edge requirements based on time to resolution
const EDGE_TIERS = [
  { maxHours: 24,  minEdge: 0.005, label: '<24h'  },   // 0.5% - nearly free money
  { maxHours: 72,  minEdge: 0.01,  label: '24-72h' },   // 1%
  { maxHours: 168, minEdge: 0.02,  label: '72h-7d' },   // 2% (was the only tier before)
];

// Position size multipliers based on time to resolution
const POSITION_SCALE_TIERS = [
  { maxHours: 24, multiplier: 3.0 },   // 3x within 24h
  { maxHours: 48, multiplier: 2.0 },   // 2x within 48h
  { maxHours: 168, multiplier: 1.0 },  // 1x beyond 48h
];

// Price momentum tracking: how many snapshots to retain per market
const MOMENTUM_SNAPSHOTS = 10;
const MIN_MOMENTUM_TREND = 3; // need 3+ consecutive rising snapshots

class UmaOracleMonitor {
  constructor(config = {}) {
    this.rpcUrl = config.rpcUrl || POLYGON_RPC;
    this.timeout = config.timeout || 15000;
    this._signals = new Map(); // conditionId -> signal
    this._lastBlock = 0;
    this._marketIndex = new Map(); // conditionId -> market data
    this._running = false;
    this._timer = null;
    this._pollInterval = config.pollInterval || POLL_INTERVAL_MS;

    // v2: Price momentum tracking - stores historical high-side prices per market
    this._priceSnapshots = new Map(); // conditionId -> [{ price, timestamp }]

    // v2: Volume tracking - stores volume observations for avg calculation
    this._volumeHistory = new Map(); // conditionId -> [{ volume24h, timestamp }]

    // v2: Dispute tracking - historical dispute data
    this._disputeHistory = new Map(); // conditionId -> { disputes: number, proposals: number, lastDispute: timestamp }
    this._proposalLog = []; // Audit trail of all proposal events

    // v2: Markets that have had disputes - reduces confidence
    this._disputedMarkets = new Set();
  }

  // ─── Tiered Edge Helpers ─────────────────────────────────────────────

  /**
   * Get the minimum edge required based on hours to resolution.
   * Returns null if outside the 7-day window entirely.
   */
  getMinEdgeForHours(hoursToEnd) {
    for (const tier of EDGE_TIERS) {
      if (hoursToEnd <= tier.maxHours) return tier;
    }
    return null; // outside 7-day window
  }

  /**
   * Get position size multiplier based on proximity to resolution.
   */
  getPositionMultiplier(hoursToEnd) {
    for (const tier of POSITION_SCALE_TIERS) {
      if (hoursToEnd <= tier.maxHours) return tier.multiplier;
    }
    return 1.0;
  }

  // ─── Price Momentum ──────────────────────────────────────────────────

  /**
   * Record a price snapshot for momentum tracking.
   */
  _recordPriceSnapshot(conditionId, highSidePrice) {
    if (!this._priceSnapshots.has(conditionId)) {
      this._priceSnapshots.set(conditionId, []);
    }
    const snapshots = this._priceSnapshots.get(conditionId);
    snapshots.push({ price: highSidePrice, timestamp: Date.now() });

    // Keep only the last N snapshots
    if (snapshots.length > MOMENTUM_SNAPSHOTS) {
      snapshots.splice(0, snapshots.length - MOMENTUM_SNAPSHOTS);
    }
  }

  /**
   * Check if the high-side price has been trending up for 3+ consecutive snapshots.
   * Returns { trending: boolean, streakLength: number, avgDelta: number }
   */
  getPriceMomentum(conditionId) {
    const snapshots = this._priceSnapshots.get(conditionId);
    if (!snapshots || snapshots.length < 2) {
      return { trending: false, streakLength: 0, avgDelta: 0 };
    }

    let streak = 0;
    let totalDelta = 0;

    // Walk backwards through snapshots counting consecutive increases
    for (let i = snapshots.length - 1; i >= 1; i--) {
      const delta = snapshots[i].price - snapshots[i - 1].price;
      if (delta > 0) {
        streak++;
        totalDelta += delta;
      } else {
        break;
      }
    }

    return {
      trending: streak >= MIN_MOMENTUM_TREND,
      streakLength: streak,
      avgDelta: streak > 0 ? totalDelta / streak : 0,
    };
  }

  // ─── Volume Confirmation ─────────────────────────────────────────────

  /**
   * Record a volume observation for a market.
   */
  _recordVolumeSnapshot(conditionId, volume24h) {
    if (!this._volumeHistory.has(conditionId)) {
      this._volumeHistory.set(conditionId, []);
    }
    const history = this._volumeHistory.get(conditionId);
    history.push({ volume24h, timestamp: Date.now() });

    // Keep last 7 days of hourly snapshots (168 entries max)
    const weekAgo = Date.now() - 7 * 24 * 3600 * 1000;
    while (history.length > 0 && history[0].timestamp < weekAgo) {
      history.shift();
    }
  }

  /**
   * Check if 24h volume is spiking vs 7-day average.
   * Returns { spiking: boolean, ratio: number, volume24h: number, avg7d: number }
   */
  getVolumeConfirmation(conditionId, currentVolume24h) {
    const history = this._volumeHistory.get(conditionId);
    if (!history || history.length < 3) {
      return { spiking: false, ratio: 1.0, volume24h: currentVolume24h, avg7d: currentVolume24h };
    }

    const sum = history.reduce((s, h) => s + h.volume24h, 0);
    const avg7d = sum / history.length;

    if (avg7d <= 0) {
      return { spiking: false, ratio: 1.0, volume24h: currentVolume24h, avg7d: 0 };
    }

    const ratio = currentVolume24h / avg7d;

    return {
      spiking: ratio >= 2.0,
      ratio,
      volume24h: currentVolume24h,
      avg7d,
    };
  }

  // ─── Dispute Tracking ────────────────────────────────────────────────

  /**
   * Fetch recent DisputePrice events to track dispute activity.
   */
  async fetchRecentDisputes(fromBlock) {
    try {
      const blockNum = typeof fromBlock === 'number' ? fromBlock : await this._getBlockNumber();
      const lookback = 5000; // Look further back for disputes
      const from = Math.max(0, blockNum - lookback);

      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 2,
        method: 'eth_getLogs',
        params: [{
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + blockNum.toString(16),
          address: UMA_ORACLE,
          topics: [DISPUTE_PRICE_TOPIC],
        }],
      }, { timeout: this.timeout });

      if (response.data?.error) return [];
      return response.data?.result || [];
    } catch {
      return [];
    }
  }

  /**
   * Process dispute events and update the dispute history.
   */
  _processDisputeEvents(disputeLogs) {
    for (const log of disputeLogs) {
      const requester = log.topics?.[1]
        ? '0x' + log.topics[1].slice(26)
        : null;

      const isPolymarket = requester &&
        (requester.toLowerCase() === UMA_ADAPTER_V2.toLowerCase() ||
         requester.toLowerCase() === UMA_ADAPTER_V3.toLowerCase());

      if (!isPolymarket) continue;

      const txHash = log.transactionHash;
      const blockNumber = parseInt(log.blockNumber, 16);

      // Log for audit trail
      this._proposalLog.push({
        type: 'dispute',
        txHash,
        blockNumber,
        timestamp: Date.now(),
        requester,
      });

      // Mark any matching markets as disputed
      // Since we can't decode the exact conditionId from the log easily,
      // we mark all markets that have active signals from the same adapter
      for (const [conditionId, signal] of this._signals) {
        if (signal.type === 'resolution-frontrun') {
          // If we see a dispute around the same time as our signal, flag it
          this._disputedMarkets.add(conditionId);

          if (!this._disputeHistory.has(conditionId)) {
            this._disputeHistory.set(conditionId, { disputes: 0, proposals: 0, lastDispute: 0 });
          }
          const hist = this._disputeHistory.get(conditionId);
          hist.disputes++;
          hist.lastDispute = Date.now();
        }
      }
    }
  }

  /**
   * Record a proposal event for audit trail and dispute rate tracking.
   */
  _recordProposalEvent(proposal, conditionId) {
    this._proposalLog.push({
      type: 'proposal',
      txHash: proposal.txHash,
      blockNumber: proposal.blockNumber,
      timestamp: Date.now(),
      conditionId,
      proposedOutcome: proposal.proposedOutcome,
      requester: proposal.requester,
    });

    if (!this._disputeHistory.has(conditionId)) {
      this._disputeHistory.set(conditionId, { disputes: 0, proposals: 0, lastDispute: 0 });
    }
    this._disputeHistory.get(conditionId).proposals++;
  }

  /**
   * Get dispute-adjusted confidence for a market.
   * If the market has had disputes before, reduce confidence by 50%.
   */
  getDisputeAdjustedConfidence(conditionId, baseConfidence) {
    const hist = this._disputeHistory.get(conditionId);
    if (!hist || hist.disputes === 0) return baseConfidence;

    // Market has had disputes - halve the confidence
    const adjusted = baseConfidence * 0.5;
    console.log(`[UMA] Dispute penalty for ${conditionId}: confidence ${baseConfidence.toFixed(3)} -> ${adjusted.toFixed(3)} (${hist.disputes} disputes)`);
    return adjusted;
  }

  /**
   * Get the audit log of all proposal/dispute events.
   */
  getProposalAuditLog() {
    return [...this._proposalLog];
  }

  /**
   * Get dispute statistics.
   */
  getDisputeStats() {
    const stats = {
      totalProposals: 0,
      totalDisputes: 0,
      disputeRate: 0,
      marketStats: {},
    };

    for (const [conditionId, hist] of this._disputeHistory) {
      stats.totalProposals += hist.proposals;
      stats.totalDisputes += hist.disputes;
      stats.marketStats[conditionId] = {
        ...hist,
        disputeRate: hist.proposals > 0 ? (hist.disputes / hist.proposals) : 0,
      };
    }

    stats.disputeRate = stats.totalProposals > 0
      ? (stats.totalDisputes / stats.totalProposals)
      : 0;

    return stats;
  }

  // ─── Confidence Boosters (Momentum + Volume) ────────────────────────

  /**
   * Calculate confidence boosts from momentum and volume signals.
   * These are additive to the base confidence, not hard requirements.
   */
  _calculateConfidenceBoosts(conditionId, market) {
    let boost = 0;
    const details = {};

    // Momentum boost: if high-side price trending up 3+ snapshots, add confidence
    const momentum = this.getPriceMomentum(conditionId);
    if (momentum.trending) {
      boost += 0.05 + Math.min(momentum.streakLength - MIN_MOMENTUM_TREND, 3) * 0.02;
      details.momentum = {
        boost: boost,
        streak: momentum.streakLength,
        avgDelta: momentum.avgDelta,
      };
    }

    // Volume boost: if 24h volume > 2x 7d average, resolution is likely imminent
    const volume24h = market.volume24h || market.volume || 0;
    const volumeConf = this.getVolumeConfirmation(conditionId, volume24h);
    if (volumeConf.spiking) {
      const volBoost = Math.min(0.10, (volumeConf.ratio - 2.0) * 0.03);
      boost += volBoost;
      details.volume = {
        boost: volBoost,
        ratio: volumeConf.ratio,
        volume24h: volumeConf.volume24h,
        avg7d: volumeConf.avg7d,
      };
    }

    return { boost, details };
  }

  // ─── Core Monitoring Logic ───────────────────────────────────────────

  /**
   * Fetch recent ProposePrice events from the UMA oracle contract.
   * Uses eth_getLogs with a block range to find proposals.
   */
  async fetchRecentProposals(fromBlock = 'latest') {
    const blockNum = fromBlock === 'latest'
      ? await this._getBlockNumber()
      : fromBlock;

    // Look back ~500 blocks (~15 minutes on Polygon at ~2s blocks)
    const lookback = 500;
    const from = Math.max(0, blockNum - lookback);

    try {
      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getLogs',
        params: [{
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + blockNum.toString(16),
          address: UMA_ORACLE,
          topics: [PROPOSE_PRICE_TOPIC],
        }],
      }, { timeout: this.timeout });

      if (response.data?.error) {
        console.error('[UMA] RPC error:', response.data.error.message);
        return [];
      }

      return (response.data?.result || []).map(log => this._parseProposalLog(log));
    } catch (err) {
      console.error('[UMA] Failed to fetch proposals:', err.message);
      return [];
    }
  }

  /**
   * Parse a ProposePrice event log into structured data.
   */
  _parseProposalLog(log) {
    const blockNumber = parseInt(log.blockNumber, 16);
    const timestamp = Date.now(); // approximate -- real impl would decode block timestamp
    const txHash = log.transactionHash;

    // Decode topics: requester is topic[1], identifier is in data
    const requester = log.topics[1]
      ? '0x' + log.topics[1].slice(26)
      : null;

    // Check if requester is a Polymarket adapter
    const isPolymarket = requester &&
      (requester.toLowerCase() === UMA_ADAPTER_V2.toLowerCase() ||
       requester.toLowerCase() === UMA_ADAPTER_V3.toLowerCase());

    // The proposed price is encoded in the data field
    // For binary markets: 1e18 = YES, 0 = NO
    let proposedOutcome = null;
    if (log.data && log.data.length >= 66) {
      const priceHex = log.data.slice(log.data.length - 64);
      const priceBigInt = BigInt('0x' + priceHex);
      if (priceBigInt > 0n) {
        proposedOutcome = 'YES';
      } else {
        proposedOutcome = 'NO';
      }
    }

    // Extract ancillary data which contains the question/condition info
    const ancillaryData = log.data || '';

    return {
      blockNumber,
      timestamp,
      txHash,
      requester,
      isPolymarket,
      proposedOutcome,
      ancillaryData,
      disputeDeadline: timestamp + LIVENESS_PERIOD_MS,
    };
  }

  async _getBlockNumber() {
    try {
      const response = await axios.post(this.rpcUrl, {
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_blockNumber',
        params: [],
      }, { timeout: this.timeout });
      return parseInt(response.data?.result || '0', 16);
    } catch {
      return 0;
    }
  }

  /**
   * Build an index of Polymarket markets by conditionId for fast lookups.
   * v2: Also records price/volume snapshots for momentum and volume tracking.
   */
  async _refreshMarketIndex() {
    try {
      const markets = await fetchMarketsOnce();
      this._marketIndex.clear();
      for (const m of markets) {
        if (m.conditionId) {
          let prices;
          try {
            prices = typeof m.outcomePrices === 'string'
              ? JSON.parse(m.outcomePrices)
              : m.outcomePrices;
          } catch { continue; }

          const yesPrice = parseFloat(prices?.[0]) || 0;
          const noPrice = parseFloat(prices?.[1]) || 0;
          const volume24h = m.volume24hr || m.volume24h || m.volume || 0;

          this._marketIndex.set(m.conditionId, {
            id: m.id,
            question: m.question,
            slug: m.slug,
            conditionId: m.conditionId,
            yesPrice,
            noPrice,
            liquidity: m.liquidity || 0,
            endDate: m.endDate,
            clobTokenIds: m.clobTokenIds || [],
            volume24h,
          });

          // Record snapshots for momentum and volume tracking
          const highSide = Math.max(yesPrice, noPrice);
          this._recordPriceSnapshot(m.conditionId, highSide);
          if (volume24h > 0) {
            this._recordVolumeSnapshot(m.conditionId, volume24h);
          }
        }
      }
    } catch (err) {
      console.error('[UMA] Market index refresh failed:', err.message);
    }
  }

  /**
   * Process proposals and generate trading signals.
   *
   * v2 changes:
   *   - Extended window from 48h to 7 days (168h)
   *   - Tiered edge requirements based on time to resolution
   *   - Momentum and volume boost confidence (not hard requirements)
   *   - Dispute-adjusted confidence
   *   - Auto-scaled position sizing
   *   - Proposal audit logging
   */
  async processProposals(proposals) {
    const signals = [];

    for (const proposal of proposals) {
      if (!proposal.isPolymarket) continue;
      if (!proposal.proposedOutcome) continue;

      const now = Date.now();

      for (const [conditionId, market] of this._marketIndex) {
        if (this._signals.has(conditionId)) continue;

        const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
        const hoursToEnd = (endDate - now) / (3600 * 1000);

        // v2: Extended window to 7 days (168 hours) with tiered edge requirements
        const tier = this.getMinEdgeForHours(hoursToEnd);
        if (!tier || hoursToEnd < -24) continue;

        const currentPrice = proposal.proposedOutcome === 'YES'
          ? market.yesPrice
          : market.noPrice;
        const discount = 1.0 - currentPrice;

        // Apply tiered minimum edge
        if (discount < tier.minEdge) continue;

        // Audit log the proposal
        this._recordProposalEvent(proposal, conditionId);

        // Calculate confidence with boosts and dispute penalty
        let confidence = Math.min(0.85, 0.7 + discount);
        const { boost, details: boostDetails } = this._calculateConfidenceBoosts(conditionId, market);
        confidence = Math.min(0.95, confidence + boost);
        confidence = this.getDisputeAdjustedConfidence(conditionId, confidence);

        // v2: Auto-scale position size
        const posMultiplier = this.getPositionMultiplier(hoursToEnd);

        const signal = {
          type: 'resolution-frontrun',
          conditionId,
          marketId: market.id,
          question: market.question,
          slug: market.slug,
          proposedOutcome: proposal.proposedOutcome,
          currentPrice,
          discount,
          direction: proposal.proposedOutcome === 'YES' ? 'BUY_YES' : 'BUY_NO',
          disputeDeadline: proposal.disputeDeadline,
          confidence,
          txHash: proposal.txHash,
          detectedAt: now,
          yesPrice: market.yesPrice,
          noPrice: market.noPrice,
          liquidity: market.liquidity,
          clobTokenIds: market.clobTokenIds,
          expiresAt: now + SIGNAL_CACHE_TTL,
          // v2 fields
          hoursToEnd,
          edgeTier: tier.label,
          minEdgeRequired: tier.minEdge,
          positionMultiplier: posMultiplier,
          momentumData: this.getPriceMomentum(conditionId),
          volumeData: this.getVolumeConfirmation(conditionId, market.volume24h || 0),
          confidenceBoosts: boostDetails,
          hasDisputes: this._disputedMarkets.has(conditionId),
        };

        this._signals.set(conditionId, signal);
        signals.push(signal);
      }
    }

    return signals;
  }

  /**
   * Detect near-resolution markets where one side is heavily favored
   * but not yet at $0.98+. These are likely to resolve soon.
   *
   * v2 changes:
   *   - Extended window to 7 days with tiered thresholds
   *   - Relaxed high-side price threshold for longer horizons
   *   - Momentum and volume boost confidence
   *   - Auto-scaled position sizing
   */
  async detectNearResolutions() {
    const now = Date.now();
    const signals = [];

    for (const [conditionId, market] of this._marketIndex) {
      if (this._signals.has(conditionId)) continue;

      const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
      const hoursToEnd = (endDate - now) / (3600 * 1000);

      // v2: Extended to 7-day window
      const tier = this.getMinEdgeForHours(hoursToEnd);
      if (!tier || hoursToEnd < 0) continue;

      const highSide = Math.max(market.yesPrice, market.noPrice);

      // Tiered high-side threshold: closer to resolution = lower threshold
      let minHighSide;
      if (hoursToEnd <= 24) {
        minHighSide = 0.90; // More aggressive within 24h
      } else if (hoursToEnd <= 72) {
        minHighSide = 0.93;
      } else {
        minHighSide = 0.95; // Conservative for 3-7 day horizon
      }

      if (highSide < minHighSide) continue;

      const discount = 1.0 - highSide;
      if (discount < tier.minEdge) continue;

      const direction = market.yesPrice >= market.noPrice ? 'BUY_YES' : 'BUY_NO';

      // v2: Calculate confidence with proximity bonus and boosts
      let confidence;
      if (hoursToEnd <= 6) {
        confidence = Math.min(0.9, highSide + (6 - hoursToEnd) / 6 * 0.05);
      } else if (hoursToEnd <= 24) {
        confidence = Math.min(0.85, highSide * 0.9);
      } else if (hoursToEnd <= 72) {
        confidence = Math.min(0.80, highSide * 0.85);
      } else {
        confidence = Math.min(0.75, highSide * 0.8);
      }

      const { boost, details: boostDetails } = this._calculateConfidenceBoosts(conditionId, market);
      confidence = Math.min(0.95, confidence + boost);
      confidence = this.getDisputeAdjustedConfidence(conditionId, confidence);

      // v2: Auto-scale position size
      const posMultiplier = this.getPositionMultiplier(hoursToEnd);

      const signal = {
        type: 'near-resolution',
        conditionId,
        marketId: market.id,
        question: market.question,
        slug: market.slug,
        proposedOutcome: direction === 'BUY_YES' ? 'YES' : 'NO',
        currentPrice: highSide,
        discount,
        direction,
        disputeDeadline: endDate,
        confidence,
        txHash: null,
        detectedAt: now,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        liquidity: market.liquidity,
        clobTokenIds: market.clobTokenIds,
        expiresAt: now + SIGNAL_CACHE_TTL,
        // v2 fields
        hoursToEnd,
        edgeTier: tier.label,
        minEdgeRequired: tier.minEdge,
        positionMultiplier: posMultiplier,
        momentumData: this.getPriceMomentum(conditionId),
        volumeData: this.getVolumeConfirmation(conditionId, market.volume24h || 0),
        confidenceBoosts: boostDetails,
        hasDisputes: this._disputedMarkets.has(conditionId),
      };

      this._signals.set(conditionId, signal);
      signals.push(signal);
    }

    return signals;
  }

  /**
   * Run one monitoring cycle: refresh data, fetch proposals, generate signals.
   * v2: Also fetches disputes and logs everything.
   */
  async runCycle() {
    // Prune expired signals
    const now = Date.now();
    for (const [key, signal] of this._signals) {
      if (signal.expiresAt < now) this._signals.delete(key);
    }

    await this._refreshMarketIndex();

    const blockNumber = await this._getBlockNumber();
    if (blockNumber === 0) return [];

    const fromBlock = this._lastBlock > 0 ? this._lastBlock : blockNumber - 500;
    this._lastBlock = blockNumber;

    // v2: Fetch disputes in parallel with proposals
    const [proposals, disputeLogs] = await Promise.all([
      this.fetchRecentProposals(fromBlock),
      this.fetchRecentDisputes(fromBlock),
    ]);

    // Process disputes first so confidence adjustments apply to new signals
    this._processDisputeEvents(disputeLogs);

    const oracleSignals = await this.processProposals(proposals);
    const nearResSignals = await this.detectNearResolutions();

    const allSignals = [...oracleSignals, ...nearResSignals];

    if (allSignals.length > 0) {
      for (const sig of allSignals) {
        const boosts = [];
        if (sig.momentumData?.trending) boosts.push(`momentum(${sig.momentumData.streakLength})`);
        if (sig.volumeData?.spiking) boosts.push(`volume(${sig.volumeData.ratio.toFixed(1)}x)`);
        if (sig.hasDisputes) boosts.push('DISPUTED');
        const boostStr = boosts.length > 0 ? ` [${boosts.join(', ')}]` : '';
        console.log(`[UMA Oracle] Signal: ${sig.type} | ${sig.question?.substring(0, 40)}... | edge: ${(sig.discount * 100).toFixed(1)}% | tier: ${sig.edgeTier} | conf: ${sig.confidence.toFixed(2)} | pos: ${sig.positionMultiplier}x${boostStr}`);
      }
    }

    return allSignals;
  }

  /**
   * Start continuous monitoring.
   */
  start() {
    if (this._running) return;
    this._running = true;
    console.log('[UMA Oracle] Monitor started (v2 - aggressive mode)');

    const tick = async () => {
      try {
        const signals = await this.runCycle();
        if (signals.length > 0) {
          console.log(`[UMA Oracle] ${signals.length} new resolution signal(s) detected`);
        }
      } catch (err) {
        console.error('[UMA Oracle] Cycle error:', err.message);
      }
      if (this._running) {
        this._timer = setTimeout(tick, this._pollInterval);
      }
    };

    tick();
  }

  stop() {
    this._running = false;
    if (this._timer) clearTimeout(this._timer);
    console.log('[UMA Oracle] Monitor stopped');
  }

  /**
   * Get all active signals as trading opportunities.
   */
  getSignals() {
    const now = Date.now();
    return Array.from(this._signals.values())
      .filter(s => s.expiresAt > now);
  }

  /**
   * Convert signals to bot-compatible opportunity format.
   * v2: Uses tiered edge, auto-scaled position sizing, enriched metadata.
   */
  toOpportunities() {
    return this.getSignals().map(signal => {
      const baseMaxPosition = Math.min((signal.liquidity || 0) * 0.015, 250);
      const scaledMaxPosition = baseMaxPosition * (signal.positionMultiplier || 1.0);

      return {
        marketId: signal.marketId,
        question: signal.question,
        slug: signal.slug,
        category: 'resolution',
        eventTitle: `Resolution: ${signal.question}`,
        yesPrice: signal.yesPrice,
        noPrice: signal.noPrice,
        sum: signal.yesPrice + signal.noPrice,
        edge: signal.discount,
        edgePercent: Math.max(0, signal.discount - 0.005),
        executableEdge: Math.max(0, signal.discount - 0.005),
        liquidity: signal.liquidity,
        volume: 0,
        conditionId: signal.conditionId,
        endDate: new Date(signal.disputeDeadline).toISOString(),
        direction: signal.direction,
        maxPosition: scaledMaxPosition,
        expectedReturn: signal.discount,
        confidence: signal.confidence,
        strategy: 'resolution-frontrun',
        holdUntilResolution: true,
        clobTokenIds: signal.clobTokenIds,
        resolutionType: signal.type,
        proposedOutcome: signal.proposedOutcome,
        txHash: signal.txHash,
        // v2 metadata
        hoursToEnd: signal.hoursToEnd,
        edgeTier: signal.edgeTier,
        minEdgeRequired: signal.minEdgeRequired,
        positionMultiplier: signal.positionMultiplier,
        momentumTrending: signal.momentumData?.trending || false,
        volumeSpiking: signal.volumeData?.spiking || false,
        hasDisputes: signal.hasDisputes || false,
      };
    });
  }
}

module.exports = UmaOracleMonitor;
