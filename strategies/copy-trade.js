/**
 * Copy-Trade / Leaderboard Strategy
 *
 * Monitors top PnL wallets on Polymarket and mirrors their high-conviction
 * trades. Uses the Polymarket subgraph and CLOB activity to detect when
 * profitable wallets take new positions.
 *
 * Edge sources:
 * - Top traders have information edge and proven track records
 * - Following with delay still captures most of the move
 * - High-conviction trades (large size relative to wallet) signal stronger edge
 * - Convergence of multiple top wallets = very high signal
 */

const axios = require('axios');
const { toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

// Polymarket CLOB API
const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

// Known profitable wallets to track (top Polymarket leaderboard)
// These should be updated periodically from the leaderboard
let TRACKED_WALLETS = [];

let _leaderboardCache = { data: null, ts: 0 };
const LEADERBOARD_TTL = 3600_000; // 1 hour — leaderboard changes slowly

let _activityCache = {};
const ACTIVITY_TTL = 120_000; // 2 min — check activity frequently

/**
 * Fetch top wallets from Polymarket leaderboard
 */
async function fetchLeaderboard() {
  if (_leaderboardCache.data && Date.now() - _leaderboardCache.ts < LEADERBOARD_TTL) {
    return _leaderboardCache.data;
  }

  try {
    // Polymarket leaderboard API
    const res = await axios.get(`${GAMMA_API}/leaderboard`, {
      params: { limit: 50, period: 'all' },
      timeout: 10000,
    });

    if (Array.isArray(res.data)) {
      TRACKED_WALLETS = res.data
        .filter(w => w.pnl > 1000 && w.trades > 50) // Min $1K PnL, 50+ trades
        .map(w => ({
          address: w.address || w.wallet,
          pnl: w.pnl,
          winRate: w.winRate || w.win_rate,
          trades: w.trades || w.total_trades,
          avgSize: w.avgTradeSize || (w.volume / w.trades),
          tier: w.pnl > 50000 ? 'whale' : w.pnl > 10000 ? 'shark' : 'dolphin',
        }));
    }

    _leaderboardCache = { data: TRACKED_WALLETS, ts: Date.now() };
    return TRACKED_WALLETS;
  } catch {
    // Fallback: return whatever we had cached
    return TRACKED_WALLETS;
  }
}

/**
 * Fetch recent trading activity for a wallet
 */
async function fetchWalletActivity(walletAddress) {
  const cacheKey = `activity_${walletAddress}`;
  const cached = _activityCache[cacheKey];
  if (cached && Date.now() - cached.ts < ACTIVITY_TTL) return cached.data;

  try {
    const res = await axios.get(`${GAMMA_API}/activity`, {
      params: { user: walletAddress, limit: 20 },
      timeout: 8000,
    });

    const activities = (res.data || []).map(a => ({
      market: a.title || a.question,
      conditionId: a.conditionId || a.condition_id,
      tokenId: a.tokenId || a.asset,
      side: a.side || (a.type === 'buy' ? 'BUY' : 'SELL'),
      price: parseFloat(a.price || 0),
      size: parseFloat(a.size || a.amount || 0),
      timestamp: new Date(a.timestamp || a.created_at).getTime(),
      outcome: a.outcome || a.outcomeName,
    }));

    _activityCache[cacheKey] = { data: activities, ts: Date.now() };
    return activities;
  } catch {
    return [];
  }
}

/**
 * Detect high-conviction trades from a wallet
 * A trade is high-conviction if:
 * - Size is > 2x the wallet's average trade size
 * - Price implies strong directional view (< 0.30 or > 0.70)
 * - Trade is recent (within last 30 minutes)
 */
function isHighConviction(trade, wallet) {
  const age = Date.now() - trade.timestamp;
  if (age > 30 * 60 * 1000) return false; // Only last 30 min

  const sizeMultiple = wallet.avgSize > 0 ? trade.size / wallet.avgSize : 1;
  if (sizeMultiple < 1.5) return false;

  // Strong directional view
  if (trade.price > 0.30 && trade.price < 0.70) return false; // Uncertain range

  return true;
}

/**
 * Detect convergence — multiple top wallets trading the same market
 */
function detectConvergence(allSignals) {
  const marketSignals = {};

  for (const signal of allSignals) {
    const key = signal.conditionId;
    if (!marketSignals[key]) marketSignals[key] = { signals: [], market: signal.market };
    marketSignals[key].signals.push(signal);
  }

  const converged = [];
  for (const [conditionId, data] of Object.entries(marketSignals)) {
    if (data.signals.length >= 2) {
      // Multiple wallets trading same market = strong signal
      const avgPrice = data.signals.reduce((s, t) => s + t.price, 0) / data.signals.length;
      const totalSize = data.signals.reduce((s, t) => s + t.size, 0);
      const consensus = data.signals.every(s => s.side === data.signals[0].side);

      if (consensus) {
        converged.push({
          ...data.signals[0],
          convergenceCount: data.signals.length,
          avgPrice,
          totalSize,
          walletTiers: data.signals.map(s => s.walletTier),
          confidenceBoost: 1 + (data.signals.length - 1) * 0.2,
        });
      }
    }
  }

  return converged;
}

const copyTradeStrategy = {
  name: 'copy-trade',
  type: 'social',
  riskLevel: 'medium',

  async scan(bot) {
    const [markets, wallets] = await Promise.all([
      fetchMarketsOnce(),
      fetchLeaderboard(),
    ]);

    if (!markets || markets.length === 0 || wallets.length === 0) return [];

    // Fetch activity from top 20 wallets in parallel
    const topWallets = wallets.slice(0, 20);
    const activityPromises = topWallets.map(w =>
      fetchWalletActivity(w.address).then(activity => ({ wallet: w, activity }))
    );
    const results = await Promise.allSettled(activityPromises);

    const allSignals = [];

    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      const { wallet, activity } = result.value;

      for (const trade of activity) {
        if (!isHighConviction(trade, wallet)) continue;

        allSignals.push({
          market: trade.market,
          conditionId: trade.conditionId,
          tokenId: trade.tokenId,
          side: trade.side === 'BUY' ? 'YES' : 'NO',
          price: trade.price,
          size: trade.size,
          walletAddress: wallet.address,
          walletPnl: wallet.pnl,
          walletWinRate: wallet.winRate,
          walletTier: wallet.tier,
          timestamp: trade.timestamp,
        });
      }
    }

    if (allSignals.length === 0) return [];

    // Check for convergence (multiple wallets trading same market)
    const converged = detectConvergence(allSignals);

    const opportunities = [];

    // Process converged signals first (highest conviction)
    for (const signal of converged) {
      const market = markets.find(m => (m.conditionId || m.id) === signal.conditionId);
      if (!market) continue;

      const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
      if (yesPrice <= 0.03 || yesPrice >= 0.97) continue;

      const confidence = Math.min(0.85, 0.5 * signal.confidenceBoost);

      opportunities.push({
        type: 'copy-trade-convergence',
        market: signal.market?.slice(0, 120) || 'Unknown',
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        side: signal.side,
        currentPrice: yesPrice,
        modelPrice: signal.avgPrice,
        edge: Math.abs(signal.avgPrice - yesPrice),
        edgePercent: (Math.abs(signal.avgPrice - yesPrice) * 100).toFixed(1) + '%',
        expectedReturn: Math.abs(signal.avgPrice - yesPrice),
        confidence,
        source: `convergence-${signal.convergenceCount}-wallets`,
        liquidity: parseFloat(market.volume || market.liquidityClob || 0),
        maxPosition: Math.min(signal.totalSize * 0.3, 150), // 30% of whale size, cap $150
        executionSpeed: 0.9,
        convergenceCount: signal.convergenceCount,
        walletTiers: signal.walletTiers,
      });
    }

    // Process individual high-conviction signals
    for (const signal of allSignals) {
      // Skip if already in convergence set
      if (converged.some(c => c.conditionId === signal.conditionId)) continue;

      // Only follow whale and shark tier wallets for solo signals
      if (signal.walletTier === 'dolphin') continue;

      const market = markets.find(m => (m.conditionId || m.id) === signal.conditionId);
      if (!market) continue;

      const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
      if (yesPrice <= 0.03 || yesPrice >= 0.97) continue;

      const edge = Math.abs(signal.price - yesPrice);
      if (edge < 0.03) continue;

      const tierMultiplier = signal.walletTier === 'whale' ? 1.3 : 1.0;
      const confidence = Math.min(0.75, edge * 5 * tierMultiplier);

      opportunities.push({
        type: 'copy-trade-follow',
        market: signal.market?.slice(0, 120) || 'Unknown',
        conditionId: signal.conditionId,
        tokenId: signal.tokenId,
        side: signal.side,
        currentPrice: yesPrice,
        modelPrice: signal.price,
        edge,
        edgePercent: (edge * 100).toFixed(1) + '%',
        expectedReturn: edge,
        confidence,
        source: `${signal.walletTier}-wallet`,
        liquidity: parseFloat(market.volume || market.liquidityClob || 0),
        maxPosition: Math.min(signal.size * 0.2, 100), // 20% of whale size, cap $100
        executionSpeed: 0.85,
        walletTier: signal.walletTier,
        walletPnl: signal.walletPnl,
      });
    }

    // Sort by confidence (convergence first, then whales, then sharks)
    opportunities.sort((a, b) => b.confidence - a.confidence);
    return opportunities.slice(0, 10); // Cap at 10 signals per scan
  },

  async validate(opp) {
    return opp && opp.edge > 0.02 && opp.confidence > 0.2;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [copyTradeStrategy];
