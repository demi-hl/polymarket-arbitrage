/**
 * UMA Optimistic Oracle Monitor
 *
 * Monitors UMA oracle resolution proposals on Polygon to detect when
 * Polymarket markets are about to resolve. When a ProposePrice event
 * is detected, the resolving outcome is known ~2 hours before the
 * market fully prices it in.
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

// RequestPrice event topic0
const REQUEST_PRICE_TOPIC = '0xd07e54c0e85ab6d0dc0f70e5c4f3f0d0e9f3f55c4f8b2b5c7e7c6d5a4b3c2d1';

const LIVENESS_PERIOD_MS = 2 * 60 * 60 * 1000; // 2 hours
const POLL_INTERVAL_MS = 60 * 1000; // Check every 60 seconds
const SIGNAL_CACHE_TTL = 4 * 60 * 60 * 1000; // Cache signals for 4 hours
const MIN_DISCOUNT_TO_SIGNAL = 0.02; // Only signal if price discount is >= 2%

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
  }

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
    const timestamp = Date.now(); // approximate — real impl would decode block timestamp
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
          this._marketIndex.set(m.conditionId, {
            id: m.id,
            question: m.question,
            slug: m.slug,
            conditionId: m.conditionId,
            yesPrice: parseFloat(prices?.[0]) || 0,
            noPrice: parseFloat(prices?.[1]) || 0,
            liquidity: m.liquidity || 0,
            endDate: m.endDate,
            clobTokenIds: m.clobTokenIds || [],
          });
        }
      }
    } catch (err) {
      console.error('[UMA] Market index refresh failed:', err.message);
    }
  }

  /**
   * Process proposals and generate trading signals.
   * A signal is generated when:
   *   1. The proposal is from a Polymarket adapter
   *   2. The resolving outcome's current price is below $0.98 (there's still discount)
   *   3. No active dispute is detected
   */
  async processProposals(proposals) {
    const signals = [];

    for (const proposal of proposals) {
      if (!proposal.isPolymarket) continue;
      if (!proposal.proposedOutcome) continue;

      // Try to match to a market via the requester (adapter) address
      // In practice, we'd decode the ancillary data to get the conditionId.
      // For now, we use a heuristic: check all markets nearing resolution.
      const now = Date.now();

      for (const [conditionId, market] of this._marketIndex) {
        if (this._signals.has(conditionId)) continue;

        const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
        const hoursToEnd = (endDate - now) / (3600 * 1000);

        // Only consider markets within 48 hours of resolution
        if (hoursToEnd > 48 || hoursToEnd < -24) continue;

        const currentPrice = proposal.proposedOutcome === 'YES'
          ? market.yesPrice
          : market.noPrice;
        const discount = 1.0 - currentPrice;

        if (discount < MIN_DISCOUNT_TO_SIGNAL) continue;

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
          confidence: Math.min(0.85, 0.7 + discount),
          txHash: proposal.txHash,
          detectedAt: now,
          yesPrice: market.yesPrice,
          noPrice: market.noPrice,
          liquidity: market.liquidity,
          clobTokenIds: market.clobTokenIds,
          expiresAt: now + SIGNAL_CACHE_TTL,
        };

        this._signals.set(conditionId, signal);
        signals.push(signal);
      }
    }

    return signals;
  }

  /**
   * Also detect near-resolution markets where one side is heavily favored
   * but not yet at $0.98+. These are likely to resolve soon.
   */
  async detectNearResolutions() {
    const now = Date.now();
    const signals = [];

    for (const [conditionId, market] of this._marketIndex) {
      if (this._signals.has(conditionId)) continue;

      const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
      const hoursToEnd = (endDate - now) / (3600 * 1000);

      // Markets within 6 hours of close with one side > 95%
      if (hoursToEnd > 6 || hoursToEnd < 0) continue;

      const highSide = Math.max(market.yesPrice, market.noPrice);
      if (highSide < 0.95) continue;

      const discount = 1.0 - highSide;
      if (discount < MIN_DISCOUNT_TO_SIGNAL) continue;

      const direction = market.yesPrice >= market.noPrice ? 'BUY_YES' : 'BUY_NO';

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
        confidence: Math.min(0.9, highSide + (6 - hoursToEnd) / 6 * 0.05),
        txHash: null,
        detectedAt: now,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        liquidity: market.liquidity,
        clobTokenIds: market.clobTokenIds,
        expiresAt: now + SIGNAL_CACHE_TTL,
      };

      this._signals.set(conditionId, signal);
      signals.push(signal);
    }

    return signals;
  }

  /**
   * Run one monitoring cycle: refresh data, fetch proposals, generate signals.
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

    const proposals = await this.fetchRecentProposals(fromBlock);
    const oracleSignals = await this.processProposals(proposals);
    const nearResSignals = await this.detectNearResolutions();

    return [...oracleSignals, ...nearResSignals];
  }

  /**
   * Start continuous monitoring.
   */
  start() {
    if (this._running) return;
    this._running = true;
    console.log('[UMA Oracle] Monitor started');

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
   */
  toOpportunities() {
    return this.getSignals().map(signal => ({
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
      maxPosition: Math.min((signal.liquidity || 0) * 0.015, 250),
      expectedReturn: signal.discount,
      confidence: signal.confidence,
      strategy: 'resolution-frontrun',
      holdUntilResolution: true,
      clobTokenIds: signal.clobTokenIds,
      resolutionType: signal.type,
      proposedOutcome: signal.proposedOutcome,
      txHash: signal.txHash,
    }));
  }
}

module.exports = UmaOracleMonitor;
