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
 *   1. Discovers crypto markets from Polymarket and registers them with the engine
 *   2. Pulls executed trades from the engine for portfolio tracking
 *   3. Reports signals/trades to the dashboard
 */
const axios = require('axios');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const ENGINE_URL = process.env.LATENCY_ENGINE_URL || 'http://localhost:8900';

const CRYPTO_PATTERN = /\b(?:bitcoin|btc|ethereum|eth|solana|sol)\b.*\b(?:price|above|below|between|reach|hit)\b|\b(?:price|above|below|between|reach|hit)\b.*\b(?:bitcoin|btc|ethereum|eth|solana|sol)\b/i;
const STRIKE_PATTERN = /\$?([\d,]+(?:\.\d+)?)/;
const DIRECTION_PATTERN = /\b(above|below|over|under|exceed|reach|hit|dip)\b/i;
const EXPIRY_15M_PATTERN = /\b15[- ]?min/i;

let engineAvailable = null;
let lastMarketSync = 0;
const MARKET_SYNC_INTERVAL = 60_000;

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

function parseCryptoContract(market) {
  const q = market.question || '';
  if (!CRYPTO_PATTERN.test(q)) return null;

  let asset = 'BTC';
  if (/\beth(?:ereum)?\b/i.test(q)) asset = 'ETH';
  if (/\bsol(?:ana)?\b/i.test(q)) asset = 'SOL';

  const strikeMatch = q.match(STRIKE_PATTERN);
  if (!strikeMatch) return null;
  const strike = parseFloat(strikeMatch[1].replace(/,/g, ''));
  if (strike < 1) return null;

  const dirMatch = q.match(DIRECTION_PATTERN);
  const direction = dirMatch && /below|under|dip/i.test(dirMatch[1]) ? 'below' : 'above';

  const is15min = EXPIRY_15M_PATTERN.test(q);
  const endDate = market.endDate ? new Date(market.endDate) : null;
  const expiryMinutes = endDate
    ? Math.max(1, Math.round((endDate.getTime() - Date.now()) / 60_000))
    : 60;

  const tokens = market.tokens || [];
  const yesToken = tokens.find(t => t.outcome === 'Yes') || tokens[0];
  if (!yesToken) return null;

  return {
    token_id: yesToken.token_id || market.conditionId,
    condition_id: market.conditionId || '',
    question: q,
    asset,
    direction,
    strike_price: strike,
    expiry: endDate ? endDate.toISOString() : new Date(Date.now() + expiryMinutes * 60_000).toISOString(),
    expiry_minutes: expiryMinutes,
    is_15min: is15min,
  };
}

async function syncMarkets() {
  if (Date.now() - lastMarketSync < MARKET_SYNC_INTERVAL) return;

  try {
    const markets = await fetchMarketsOnce();
    const cryptoContracts = [];

    for (const market of markets) {
      if (market.active === false || market.closed) continue;
      const contract = parseCryptoContract(market);
      if (!contract) continue;
      cryptoContracts.push(contract);
    }

    if (cryptoContracts.length > 0) {
      // Prioritize 15-min contracts
      cryptoContracts.sort((a, b) => {
        if (a.is_15min && !b.is_15min) return -1;
        if (!a.is_15min && b.is_15min) return 1;
        return a.expiry_minutes - b.expiry_minutes;
      });

      await axios.post(`${ENGINE_URL}/markets`, { contracts: cryptoContracts }, { timeout: 5000 });
      lastMarketSync = Date.now();
    }
  } catch (e) {
    console.error('[crypto-latency-arb] Market sync failed:', e.message);
  }
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

    await syncMarkets();

    try {
      const [signalsResp, tradesResp] = await Promise.all([
        axios.get(`${ENGINE_URL}/signals`, { timeout: 3000 }),
        axios.get(`${ENGINE_URL}/trades`, { timeout: 3000 }),
      ]);

      const signals = signalsResp.data || [];
      const trades = tradesResp.data || [];

      const opportunities = [];
      for (const sig of signals) {
        opportunities.push({
          marketId: sig.contract?.condition_id || sig.contract?.token_id || 'unknown',
          question: sig.contract?.question || '',
          slug: '',
          category: 'crypto-latency',
          edge: Math.abs(sig.divergence || 0),
          edgePercent: Math.abs(sig.divergence || 0) * 100,
          executableEdge: Math.abs(sig.divergence || 0),
          liquidity: 50000,
          direction: sig.side === 'buy' ? 'BUY_YES' : 'BUY_NO',
          maxPosition: sig.suggested_size || 50,
          expectedReturn: Math.abs(sig.divergence || 0),
          confidence: sig.confidence || 0.5,
          strategy: 'crypto-latency-arb',
          rustEngine: true,
          signalId: sig.id,
          trendState: sig.trend_state,
          sourcesAgreeing: sig.sources_agreeing,
          impliedProb: sig.implied_prob,
          actualProb: sig.actual_prob,
        });
      }

      return opportunities;
    } catch (e) {
      console.error('[crypto-latency-arb] Scan failed:', e.message);
      if (e.code === 'ECONNREFUSED') engineAvailable = false;
      return [];
    }
  },

  async validate(opportunity, _bot) {
    return opportunity.rustEngine === true && opportunity.confidence > 0.3;
  },

  async execute(opportunity, bot) {
    // Execution happens in the Rust engine directly.
    // This is called by the strategy registry but the order was already submitted.
    return {
      success: true,
      trade: {
        strategy: 'crypto-latency-arb',
        marketId: opportunity.marketId,
        direction: opportunity.direction,
        amount: opportunity.maxPosition,
        price: opportunity.impliedProb || 0.5,
        edge: opportunity.edge,
        executedBy: 'rust-engine',
        signalId: opportunity.signalId,
      },
    };
  },
};

module.exports = [cryptoLatencyArbStrategy];
