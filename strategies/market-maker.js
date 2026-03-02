/**
 * Market Making Strategy
 * Posts limit orders on both sides of a market to earn the bid-ask spread.
 * Manages inventory to avoid accumulating directional risk.
 *
 * Revenue sources:
 *   1. Bid-ask spread capture
 *   2. Polymarket liquidity rewards (in fee-enabled markets)
 *
 * In paper mode, simulates quote posting and fills.
 * In live mode, requires CLOB API authentication.
 */
const ClobClient = require('../clob-client');
const OrderManager = require('../execution/order-manager');
const { fetchMarketsOnce, toBotOpportunity } = require('./lib/with-scanner');

const DEFAULT_CONFIG = {
  targetSpread: 0.03,        // 3 cent spread target
  minSpread: 0.01,           // never quote tighter than 1 cent
  maxSpread: 0.10,           // never wider than 10 cents
  quoteSize: 50,             // $50 per side
  maxInventory: 500,         // max $500 net exposure per market
  inventorySkewFactor: 0.5,  // how much to skew quotes when inventory builds
  maxMarketsActive: 5,       // simultaneous markets
  refreshIntervalMs: 30000,  // re-quote every 30s
  minLiquidity: 10000,       // only make markets with >= $10K liquidity
  minVolume: 5000,           // only make markets with >= $5K 24h volume
};

class MarketMaker {
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.clob = config.clobClient || new ClobClient();
    this.orderManager = config.orderManager || new OrderManager({
      mode: config.mode || 'paper',
      clobClient: this.clob,
    });

    this.activeMarkets = new Map();
    this.inventory = new Map();
    this.pnl = { spread: 0, inventory: 0, total: 0, tradesCount: 0 };
    this._refreshTimer = null;

    this.orderManager.on('order:filled', (order) => this._onFill(order));
  }

  /**
   * Select the best markets for market making.
   */
  async selectMarkets() {
    const markets = await fetchMarketsOnce();

    const eligible = markets.filter(m => {
      const liq = m.liquidity || 0;
      const vol = m.volume || 0;
      return liq >= this.config.minLiquidity && vol >= this.config.minVolume;
    });

    eligible.sort((a, b) => (b.volume || 0) - (a.volume || 0));
    return eligible.slice(0, this.config.maxMarketsActive);
  }

  /**
   * Compute quotes for a market based on orderbook state and inventory.
   */
  computeQuotes(market, yesBook, noBook) {
    if (!yesBook || !noBook) return null;

    const mid = yesBook.midpoint;
    const currentSpread = yesBook.spread;

    let targetSpread = Math.max(
      this.config.minSpread,
      Math.min(currentSpread * 0.8, this.config.maxSpread)
    );

    if (currentSpread > 0.06) targetSpread = currentSpread * 0.9;

    const halfSpread = targetSpread / 2;

    const inv = this.inventory.get(market.id) || { yesShares: 0, noShares: 0 };
    const netExposure = (inv.yesShares - inv.noShares) * mid;
    const skew = (netExposure / this.config.maxInventory) * this.config.inventorySkewFactor;

    const bidPrice = Math.max(0.01, mid - halfSpread - skew);
    const askPrice = Math.min(0.99, mid + halfSpread - skew);

    if (askPrice - bidPrice < this.config.minSpread) return null;

    const bidSize = this.config.quoteSize / bidPrice;
    const askSize = this.config.quoteSize / askPrice;

    return {
      marketId: market.id,
      mid,
      bidPrice: parseFloat(bidPrice.toFixed(3)),
      askPrice: parseFloat(askPrice.toFixed(3)),
      bidSize: parseFloat(bidSize.toFixed(2)),
      askSize: parseFloat(askSize.toFixed(2)),
      spread: parseFloat((askPrice - bidPrice).toFixed(4)),
      skew: parseFloat(skew.toFixed(4)),
      netExposure: parseFloat(netExposure.toFixed(2)),
    };
  }

  /**
   * Post quotes for a market (place/update bid and ask orders).
   */
  async quoteMarket(market) {
    let tokens = market.clobTokenIds;
    if (typeof tokens === 'string') {
      try { tokens = JSON.parse(tokens); } catch { return null; }
    }
    if (!tokens || tokens.length < 2) return null;

    const yesTokenId = tokens[0];

    try {
      const yesBook = await this.clob.getOrderbook(yesTokenId);
      const noBook = await this.clob.getOrderbook(tokens[1]);

      const quotes = this.computeQuotes(market, yesBook, noBook);
      if (!quotes) return null;

      await this.orderManager.cancelAllForToken(yesTokenId);

      const bidOrder = await this.orderManager.placeOrder(
        yesTokenId, 'buy', quotes.bidPrice, quotes.bidSize,
        { marketId: market.id, strategy: 'market-maker', quoteType: 'bid' }
      );

      const askOrder = await this.orderManager.placeOrder(
        yesTokenId, 'sell', quotes.askPrice, quotes.askSize,
        { marketId: market.id, strategy: 'market-maker', quoteType: 'ask' }
      );

      this.activeMarkets.set(market.id, {
        market,
        quotes,
        bidOrderId: bidOrder.id,
        askOrderId: askOrder.id,
        lastQuoteTime: Date.now(),
      });

      return quotes;
    } catch (err) {
      console.error(`Market maker quote failed for ${market.id}: ${err.message}`);
      return null;
    }
  }

  /**
   * Refresh all active market quotes.
   */
  async refreshAllQuotes() {
    const markets = await this.selectMarkets();
    const results = [];

    for (const market of markets) {
      const quotes = await this.quoteMarket(market);
      if (quotes) results.push(quotes);
    }

    await this.orderManager.checkFills();

    return results;
  }

  /**
   * Handle a fill event: update inventory and PnL.
   */
  _onFill(order) {
    const marketId = order.marketId;
    if (!this.inventory.has(marketId)) {
      this.inventory.set(marketId, { yesShares: 0, noShares: 0, cost: 0 });
    }

    const inv = this.inventory.get(marketId);

    if (order.side === 'buy') {
      inv.yesShares += order.filledSize;
      inv.cost += order.filledSize * order.price;
    } else {
      inv.yesShares -= order.filledSize;
      inv.cost -= order.filledSize * order.price;
    }

    this.pnl.tradesCount++;

    const activeEntry = this.activeMarkets.get(marketId);
    if (activeEntry?.quotes) {
      const spread = activeEntry.quotes.spread;
      this.pnl.spread += (spread / 2) * order.filledSize * order.price;
    }

    this.pnl.total = this.pnl.spread + this.pnl.inventory;
  }

  /**
   * Start the market maker loop.
   */
  start() {
    if (this._refreshTimer) return;
    this.refreshAllQuotes();
    this._refreshTimer = setInterval(
      () => this.refreshAllQuotes(),
      this.config.refreshIntervalMs,
    );
  }

  stop() {
    if (this._refreshTimer) {
      clearInterval(this._refreshTimer);
      this._refreshTimer = null;
    }
    for (const [, entry] of this.activeMarkets) {
      let tokens = entry.market.clobTokenIds;
      if (typeof tokens === 'string') try { tokens = JSON.parse(tokens); } catch { continue; }
      if (tokens?.[0]) this.orderManager.cancelAllForToken(tokens[0]);
    }
    this.activeMarkets.clear();
  }

  getReport() {
    return {
      activeMarkets: this.activeMarkets.size,
      openOrders: this.orderManager.getOpenOrders().length,
      pnl: { ...this.pnl },
      inventory: Object.fromEntries(this.inventory),
      markets: Array.from(this.activeMarkets.values()).map(e => ({
        marketId: e.market.id,
        question: e.market.question,
        quotes: e.quotes,
        lastQuoteTime: e.lastQuoteTime,
      })),
      orderStats: this.orderManager.getStats(),
    };
  }
}

// ── Strategy interface for the registry ──

const marketMakerStrategy = {
  name: 'market-maker',
  type: 'flow',
  riskLevel: 'medium',

  _instance: null,

  async scan(bot) {
    const TIMEOUT = 20000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('market-maker timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[market-maker]', err.message); return []; });
  },

  async _doScan(bot) {
    if (!this._instance) {
      this._instance = new MarketMaker({ mode: bot.mode || 'paper' });
    }

    const quotes = await this._instance.refreshAllQuotes();

    return quotes.map(q => ({
      marketId: q.marketId,
      question: `MM: spread capture @ ${q.spread.toFixed(3)}`,
      yesPrice: q.mid,
      noPrice: 1 - q.mid,
      sum: 1,
      edge: q.spread * 0.4,
      edgePercent: q.spread * 0.4,
      executableEdge: q.spread * 0.4,
      liquidity: 10000,
      volume: 10000,
      direction: 'MARKET_MAKE',
      maxPosition: q.bidSize * q.bidPrice + q.askSize * q.askPrice,
      expectedReturn: q.spread * 0.4,
      confidence: 0.7,
      spread: q.spread,
      strategy: 'market-maker',
    }));
  },

  async validate(opp) {
    return opp && opp.spread >= 0.01;
  },

  async execute(bot, opp) {
    return { ...opp, status: 'quoted', mode: 'paper' };
  },
};

module.exports = { MarketMaker, marketMakerStrategy };
