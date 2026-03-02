/**
 * Whale Wallet Tracker
 *
 * Monitors Polymarket for:
 *   1. Large individual trades (> $1000) across all markets
 *   2. Top leaderboard traders and their recent activity
 *   3. Wallets with high win rates making new positions
 *   4. Unusual bet sizing (5x+ normal for that wallet)
 *
 * Outputs a whale signal feed that the news-sentiment strategy
 * can use to generate directional theses.
 */
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DATA_API = 'https://data-api.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const SIGNALS_PATH = path.join(__dirname, '..', 'data', 'whale-signals.json');
const TRACKED_WALLETS_PATH = path.join(__dirname, '..', 'data', 'tracked-wallets.json');

const LARGE_TRADE_THRESHOLD = 1000;
const WHALE_TRADE_THRESHOLD = 5000;
const MIN_WIN_RATE = 0.60;
const LEADERBOARD_LIMIT = 25;

async function fetchLeaderboard(category = 'OVERALL', period = 'WEEK') {
  try {
    const { data } = await axios.get(`${DATA_API}/v1/leaderboard`, {
      params: { category, timePeriod: period, orderBy: 'PNL', limit: LEADERBOARD_LIMIT },
      timeout: 10000,
    });
    return data || [];
  } catch (err) {
    console.error('[whale-tracker] leaderboard fetch failed:', err.message);
    return [];
  }
}

async function fetchRecentLargeTrades(minAmount = LARGE_TRADE_THRESHOLD) {
  try {
    const { data } = await axios.get(`${DATA_API}/trades`, {
      params: { limit: 200, filterType: 'CASH', filterAmount: minAmount },
      timeout: 10000,
    });
    return data || [];
  } catch (err) {
    console.error('[whale-tracker] large trades fetch failed:', err.message);
    return [];
  }
}

async function fetchTraderActivity(walletAddress, limit = 50) {
  try {
    const { data } = await axios.get(`${DATA_API}/activity`, {
      params: { user: walletAddress, limit },
      timeout: 8000,
    });
    return (data || []).filter(a => a.type === 'TRADE');
  } catch (err) {
    return [];
  }
}

async function fetchTraderProfile(walletAddress) {
  try {
    const { data } = await axios.get(`${DATA_API}/public-profile`, {
      params: { address: walletAddress },
      timeout: 5000,
    });
    return data;
  } catch { return null; }
}

async function loadTrackedWallets() {
  try {
    return JSON.parse(await fs.readFile(TRACKED_WALLETS_PATH, 'utf8'));
  } catch {
    return { wallets: [], lastUpdated: 0 };
  }
}

async function saveTrackedWallets(data) {
  await fs.writeFile(TRACKED_WALLETS_PATH, JSON.stringify(data, null, 2));
}

async function loadSignals() {
  try {
    return JSON.parse(await fs.readFile(SIGNALS_PATH, 'utf8'));
  } catch { return []; }
}

async function saveSignals(signals) {
  const trimmed = signals.slice(-200);
  await fs.writeFile(SIGNALS_PATH, JSON.stringify(trimmed, null, 2));
}

/**
 * Scan for whale activity and produce signals.
 * Returns an array of whale signal objects.
 */
async function scan() {
  const signals = await loadSignals();
  const now = Date.now();
  const newSignals = [];

  // 1. Fetch top PnL traders this week and track their wallets
  const leaderboard = await fetchLeaderboard('OVERALL', 'WEEK');
  const topTraders = leaderboard
    .filter(t => t && t.proxyWallet && parseFloat(t.pnl || 0) > 0)
    .slice(0, 15);

  const tracked = await loadTrackedWallets();
  const walletSet = new Set(tracked.wallets.map(w => w.address));

  for (const trader of topTraders) {
    if (!walletSet.has(trader.proxyWallet)) {
      tracked.wallets.push({
        address: trader.proxyWallet,
        username: trader.userName || trader.username || 'anon',
        xUsername: trader.xUsername || '',
        pnl: parseFloat(trader.pnl || 0),
        volume: parseFloat(trader.vol || trader.volume || 0),
        rank: parseInt(trader.rank || 0),
        addedAt: now,
        source: 'leaderboard',
      });
      walletSet.add(trader.proxyWallet);
    }
  }
  tracked.lastUpdated = now;
  await saveTrackedWallets(tracked);

  // 2. Fetch recent large trades across all markets
  const largeTrades = await fetchRecentLargeTrades(LARGE_TRADE_THRESHOLD);
  const recentWhales = largeTrades.filter(t => {
    const size = parseFloat(t.size || t.amount || 0);
    return size >= WHALE_TRADE_THRESHOLD;
  });

  // Group whale trades by market to find consensus
  const marketFlow = {};
  for (const trade of recentWhales) {
    const marketId = trade.conditionId || trade.market || 'unknown';
    if (!marketFlow[marketId]) {
      marketFlow[marketId] = { buys: 0, sells: 0, totalSize: 0, trades: [], title: trade.title, slug: trade.slug };
    }
    const size = parseFloat(trade.size || trade.amount || 0);
    const side = (trade.side || '').toUpperCase();
    if (side === 'BUY') marketFlow[marketId].buys += size;
    else marketFlow[marketId].sells += size;
    marketFlow[marketId].totalSize += size;
    marketFlow[marketId].trades.push(trade);
  }

  for (const [marketId, flow] of Object.entries(marketFlow)) {
    const total = flow.buys + flow.sells;
    if (total < WHALE_TRADE_THRESHOLD) continue;

    const buyRatio = flow.buys / total;
    const direction = buyRatio > 0.6 ? 'BUY' : buyRatio < 0.4 ? 'SELL' : 'MIXED';
    if (direction === 'MIXED') continue;

    newSignals.push({
      type: 'whale-flow',
      marketId,
      title: flow.title,
      slug: flow.slug,
      direction,
      totalSize: Math.round(total),
      buyRatio: parseFloat(buyRatio.toFixed(2)),
      tradeCount: flow.trades.length,
      timestamp: now,
      confidence: Math.min(0.5 + (total / 50000) * 0.3, 0.9),
    });
  }

  // 3. Check tracked high-PnL wallets for new activity
  const topWallets = tracked.wallets
    .sort((a, b) => (b.pnl || 0) - (a.pnl || 0))
    .slice(0, 8);

  for (const wallet of topWallets) {
    try {
      const activity = await fetchTraderActivity(wallet.address, 10);
      if (!activity || activity.length === 0) continue;

      const recentTrades = activity.filter(a => {
        const ts = a.timestamp ? a.timestamp * 1000 : 0; // API returns seconds
        return ts > now - 3600000; // last hour
      });

      if (recentTrades.length === 0) continue;

      for (const trade of recentTrades.slice(0, 3)) {
        const size = parseFloat(trade.usdcSize || trade.size || 0);
        if (size < 200) continue;

        newSignals.push({
          type: 'smart-wallet',
          walletAddress: wallet.address,
          username: wallet.username,
          walletPnl: wallet.pnl,
          marketId: trade.conditionId || trade.market,
          title: trade.title,
          slug: trade.slug,
          outcome: trade.outcome,
          side: trade.side,
          price: parseFloat(trade.price || 0),
          size: Math.round(size),
          usdcSize: parseFloat(trade.usdcSize || size),
          timestamp: now,
          confidence: Math.min(0.4 + (wallet.pnl / 100000) * 0.3, 0.85),
        });
      }
    } catch { continue; }
  }

  if (newSignals.length > 0) {
    signals.push(...newSignals);
    await saveSignals(signals);
  }

  return newSignals;
}

/**
 * Get the latest whale signals for a specific market.
 */
async function getSignalsForMarket(marketId, maxAge = 3600000) {
  const signals = await loadSignals();
  const cutoff = Date.now() - maxAge;
  return signals.filter(s => s.marketId === marketId && s.timestamp > cutoff);
}

/**
 * Get all recent whale signals.
 */
async function getRecentSignals(maxAge = 3600000) {
  const signals = await loadSignals();
  const cutoff = Date.now() - maxAge;
  return signals.filter(s => s.timestamp > cutoff);
}

module.exports = { scan, getSignalsForMarket, getRecentSignals, fetchLeaderboard };
