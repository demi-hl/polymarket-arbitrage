/**
 * Crypto Latency Arbitrage Strategy
 *
 * Bridge between the Rust latency engine (port 8900) and the Node.js
 * strategy registry. The Rust engine handles:
 *   - Binance WebSocket price feeds (BTC/ETH/SOL)
 *   - Polymarket CLOB orderbook streaming
 *   - Divergence detection (implied vs actual probability)
 *   - EIP-712 signing and order submission
 *
 * This wrapper:
 *   1. Discovers crypto price markets from Polymarket and registers them with the engine
 *   2. Pulls executed trades/signals from the engine for portfolio tracking + dashboard
 *   3. Reports Rust engine P&L alongside the Node.js portfolio
 *
 * Execution happens entirely in the Rust engine — the Node.js side just records it.
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://localhost:8900';

const CRYPTO_PRICE_PATTERN = /\b(?:bitcoin|btc)\b.*\b(?:price|above|below|between|reach|hit)\b|\b(?:price|above|below|between|reach|hit)\b.*\b(?:bitcoin|btc)\b/i;
const ETH_PRICE_PATTERN = /\b(?:ethereum|eth)\b.*\b(?:price|above|below|between|reach|hit)\b|\b(?:price|above|below|between|reach|hit)\b.*\b(?:ethereum|eth)\b/i;
const SOL_PRICE_PATTERN = /\b(?:solana|sol)\b.*\b(?:price|above|below|between|reach|hit)\b|\b(?:price|above|below|between|reach|hit)\b.*\b(?:solana|sol)\b/i;
const STRIKE_PATTERN = /\$\s*([\d,]+(?:\.\d+)?)/;
const DIRECTION_PATTERN = /\b(above|below|over|under|exceed|reach|hit|dip)\b/i;
const SHORT_EXPIRY_PATTERN = /\b(?:15[- ]?min|30[- ]?min|1[- ]?hour|hourly)\b/i;

let engineAvailable = null;
let lastMarketSync = 0;
let lastTradeSync = 0;
let syncedTradeIds = new Set();
const MARKET_SYNC_INTERVAL = 60_000;
const TRADE_SYNC_INTERVAL = 10_000;

async function checkEngine() {
  try {
    const { data } = await axios.get(`${ENGINE_URL}/health`, { timeout: 2000 });
    engineAvailable = data.status === 'ok';
    return engineAvailable;
  } catch {
    engineAvailable = false;
    return false;
  }
}

function identifyAsset(question) {
  if (CRYPTO_PRICE_PATTERN.test(question)) return 'BTC';
  if (ETH_PRICE_PATTERN.test(question)) return 'ETH';
  if (SOL_PRICE_PATTERN.test(question)) return 'SOL';
  return null;
}

function parseCryptoContract(market) {
  const q = market.question || '';
  const asset = identifyAsset(q);
  if (!asset) return null;

  const strikeMatch = q.match(STRIKE_PATTERN);
  if (!strikeMatch) return null;
  const strike = parseFloat(strikeMatch[1].replace(/,/g, ''));
  if (strike < 10) return null;

  const dirMatch = q.match(DIRECTION_PATTERN);
  const direction = dirMatch && /below|under|dip/i.test(dirMatch[1]) ? 'below' : 'above';

  const isShortExpiry = SHORT_EXPIRY_PATTERN.test(q);
  const endDate = market.endDate ? new Date(market.endDate) : null;
  const expiryMinutes = endDate
    ? Math.max(1, Math.round((endDate.getTime() - Date.now()) / 60_000))
    : 60;

  if (expiryMinutes < 1) return null;

  const clobTokenIds = market.clobTokenIds || [];
  const yesTokenId = clobTokenIds[0];
  if (!yesTokenId) return null;

  let yesPrice = 0.5;
  try {
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (prices && prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
  } catch {}

  return {
    token_id: yesTokenId,
    condition_id: market.conditionId || '',
    question: q,
    asset,
    direction,
    strike_price: strike,
    expiry: endDate ? endDate.toISOString() : new Date(Date.now() + expiryMinutes * 60_000).toISOString(),
    expiry_minutes: expiryMinutes,
    is_short_expiry: isShortExpiry,
    yes_price: yesPrice,
    market_id: market.id || market.conditionId,
    liquidity: market.liquidity || 0,
    no_token_id: clobTokenIds[1] || '',
  };
}

async function syncMarkets() {
  if (Date.now() - lastMarketSync < MARKET_SYNC_INTERVAL) return 0;

  try {
    const markets = await fetchMarketsOnce();
    const cryptoContracts = [];

    for (const market of markets) {
      if (market.active === false || market.closed) continue;
      const contract = parseCryptoContract(market);
      if (!contract) continue;
      if (contract.liquidity < 5000) continue;
      cryptoContracts.push(contract);
    }

    if (cryptoContracts.length > 0) {
      cryptoContracts.sort((a, b) => {
        if (a.is_short_expiry && !b.is_short_expiry) return -1;
        if (!a.is_short_expiry && b.is_short_expiry) return 1;
        return a.expiry_minutes - b.expiry_minutes;
      });

      await axios.post(`${ENGINE_URL}/markets`, { contracts: cryptoContracts }, { timeout: 5000 });
      lastMarketSync = Date.now();
      return cryptoContracts.length;
    }
    return 0;
  } catch (e) {
    console.error('[crypto-latency-arb] Market sync failed:', e.message);
    return 0;
  }
}

async function fetchEngineState() {
  const [signalsResp, tradesResp, pnlResp, statusResp] = await Promise.all([
    axios.get(`${ENGINE_URL}/signals`, { timeout: 3000 }).catch(() => ({ data: [] })),
    axios.get(`${ENGINE_URL}/trades`, { timeout: 3000 }).catch(() => ({ data: [] })),
    axios.get(`${ENGINE_URL}/pnl`, { timeout: 3000 }).catch(() => ({ data: {} })),
    axios.get(`${ENGINE_URL}/status`, { timeout: 3000 }).catch(() => ({ data: {} })),
  ]);
  return {
    signals: signalsResp.data || [],
    trades: tradesResp.data || [],
    pnl: pnlResp.data || {},
    status: statusResp.data || {},
  };
}

const cryptoLatencyArbStrategy = {
  name: 'crypto-latency-arb',
  type: 'latency-arbitrage',
  riskLevel: 'high',

  async scan(_bot) {
    if (engineAvailable === null) {
      await checkEngine();
    }
    if (!engineAvailable) {
      if (Math.random() < 0.1) await checkEngine();
      return [];
    }

    const synced = await syncMarkets();

    let state;
    try {
      state = await fetchEngineState();
    } catch (e) {
      console.error('[crypto-latency-arb] Engine fetch failed:', e.message);
      if (e.code === 'ECONNREFUSED') engineAvailable = false;
      return [];
    }

    const opportunities = [];

    for (const sig of state.signals) {
      if (!sig.contract) continue;
      const alreadyTraded = state.trades.some(t => t.signal_id === sig.id && t.status === 'filled');

      opportunities.push({
        marketId: sig.contract.condition_id || sig.contract.token_id || 'unknown',
        question: sig.contract.question || `${sig.contract.asset} ${sig.contract.direction} $${sig.contract.strike_price}`,
        slug: '',
        category: 'crypto-latency',
        eventTitle: `Crypto Latency Arb (${sig.contract.asset})`,
        yesPrice: sig.implied_prob || 0.5,
        noPrice: 1 - (sig.implied_prob || 0.5),
        sum: 1.0,
        edge: Math.abs(sig.divergence || 0),
        edgePercent: Math.abs(sig.divergence || 0),
        executableEdge: Math.abs(sig.divergence || 0),
        liquidity: 50000,
        direction: sig.side === 'buy' ? 'BUY_YES' : 'BUY_NO',
        maxPosition: sig.suggested_size || 50,
        expectedReturn: Math.abs(sig.divergence || 0),
        confidence: sig.confidence || 0.5,
        executionSpeed: 1.0,
        strategy: 'crypto-latency-arb',
        conditionId: sig.contract.condition_id,
        clobTokenIds: [sig.contract.token_id],

        rustEngine: true,
        bypassThreshold: true,
        alreadyExecuted: alreadyTraded,
        signalId: sig.id,
        trendState: sig.trend_state,
        sourcesAgreeing: sig.sources_agreeing,
        impliedProb: sig.implied_prob,
        actualProb: sig.actual_prob,
      });
    }

    // Also surface new trades from the engine that the Node.js portfolio doesn't know about yet
    if (Date.now() - lastTradeSync > TRADE_SYNC_INTERVAL) {
      for (const trade of state.trades) {
        if (syncedTradeIds.has(trade.id)) continue;
        if (trade.status !== 'filled') continue;
        syncedTradeIds.add(trade.id);

        opportunities.push({
          marketId: trade.contract_token_id || trade.id,
          question: `Rust Engine: ${trade.asset || 'BTC'} latency arb`,
          slug: '',
          category: 'crypto-latency',
          yesPrice: trade.price || 0.5,
          noPrice: 1 - (trade.price || 0.5),
          sum: 1.0,
          edge: Math.abs(trade.divergence_at_entry || 0.005),
          edgePercent: Math.abs(trade.divergence_at_entry || 0.005),
          executableEdge: Math.abs(trade.divergence_at_entry || 0.005),
          liquidity: 50000,
          direction: trade.side === 'buy' ? 'BUY_YES' : 'BUY_NO',
          maxPosition: trade.size || trade.cost || 25,
          expectedReturn: Math.abs(trade.divergence_at_entry || 0.005),
          confidence: 0.7,
          executionSpeed: 1.0,
          strategy: 'crypto-latency-arb',

          rustEngine: true,
          bypassThreshold: true,
          alreadyExecuted: true,
          rustTradeId: trade.id,
          rustPnl: trade.pnl,
        });
      }
      lastTradeSync = Date.now();
    }

    if (synced > 0 || opportunities.length > 0) {
      const pnl = state.pnl;
      const btcPrice = state.status?.feeds?.binance_last_price;
      console.log(`  [crypto-latency-arb] synced=${synced} signals=${state.signals.length} trades=${state.trades.length} pnl=$${(pnl.realized || 0).toFixed(2)}${btcPrice ? ` BTC=$${btcPrice.toFixed(0)}` : ''}`);
    }

    return opportunities;
  },

  async validate(opportunity, _bot) {
    if (opportunity.rustEngine) return true;
    return false;
  },

  async execute(opportunity, bot) {
    // Rust engine already executed the trade. Record it in the Node.js portfolio.
    if (opportunity.alreadyExecuted && opportunity.rustPnl != null) {
      return {
        success: true,
        trade: {
          id: `rust-${opportunity.rustTradeId || Date.now()}`,
          strategy: 'crypto-latency-arb',
          marketId: opportunity.marketId,
          question: opportunity.question,
          direction: opportunity.direction,
          totalCost: opportunity.maxPosition || 25,
          yesPrice: opportunity.yesPrice,
          noPrice: opportunity.noPrice,
          yesShares: opportunity.direction === 'BUY_YES' ? (opportunity.maxPosition / opportunity.yesPrice) : 0,
          noShares: opportunity.direction === 'BUY_NO' ? (opportunity.maxPosition / opportunity.noPrice) : 0,
          fillMethod: 'rust-engine',
          edgePercent: opportunity.edgePercent,
          executedBy: 'rust-engine',
          realizedPnl: opportunity.rustPnl,
          closedAt: new Date().toISOString(),
          closeMethod: 'rust-instant',
        },
      };
    }

    return {
      success: true,
      trade: {
        id: `rust-${opportunity.signalId || Date.now()}`,
        strategy: 'crypto-latency-arb',
        marketId: opportunity.marketId,
        question: opportunity.question,
        direction: opportunity.direction,
        amount: opportunity.maxPosition,
        totalCost: opportunity.maxPosition || 25,
        yesPrice: opportunity.yesPrice,
        noPrice: opportunity.noPrice,
        fillMethod: 'rust-engine',
        edgePercent: opportunity.edgePercent,
        executedBy: 'rust-engine',
        signalId: opportunity.signalId,
      },
    };
  },
};

module.exports = [cryptoLatencyArbStrategy];
