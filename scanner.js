const axios = require('axios');
const ClobClient = require('./clob-client');
const { marketInSectors } = require('./sectors');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Polymarket Scanner
 * Uses the Gamma API for market discovery and the CLOB API for real orderbook pricing.
 * Calculates arbitrage from actual bid/ask rather than mid-prices.
 * Supports sector filter: politics, sports, crypto.
 */
class PolymarketScanner {
  constructor(config = {}) {
    this.gammaApi = config.gammaApi || 'https://gamma-api.polymarket.com';
    this.minLiquidity = config.minLiquidity || 5000;
    this.edgeThreshold = config.edgeThreshold || 0.05;
    this.timeout = config.timeout || 15000;
    this.pageSize = config.pageSize || 100;
    this.clob = config.clobClient || new ClobClient({ timeout: this.timeout });
    this.useClobPricing = config.useClobPricing !== false;
    this.sectors = config.sectors;
    this.interRequestDelayMs = Math.max(0, parseInt(process.env.SCAN_INTER_REQUEST_DELAY_MS || '600', 10));
    this._lastRequestAt = 0;

    this._wsConnected = false;
    this._wsSubscribedTokens = new Set();
  }

  connectWebSocket() {
    if (this._wsConnected) return;
    this.clob.connect();
    this._wsConnected = true;
    this.clob.on('connected', () => {
      console.log('[CLOB WS] Connected — real-time orderbook streaming');
      if (this._wsSubscribedTokens.size > 0) {
        this.clob.subscribe(Array.from(this._wsSubscribedTokens));
      }
    });
    this.clob.on('disconnected', () => {
      console.log('[CLOB WS] Disconnected — will reconnect');
    });
    this.clob.on('error', () => {});
  }

  subscribeMarkets(markets) {
    const tokenIds = [];
    for (const m of markets) {
      const tokens = m.clobTokenIds;
      if (Array.isArray(tokens)) {
        for (const t of tokens) {
          if (t && !this._wsSubscribedTokens.has(t)) {
            tokenIds.push(t);
            this._wsSubscribedTokens.add(t);
          }
        }
      }
    }
    if (tokenIds.length > 0 && this._wsConnected) {
      this.clob.subscribe(tokenIds);
    }
  }

  getCachedClobPrice(tokenId) {
    const book = this.clob.getCachedBook(tokenId);
    if (!book) return null;
    if (Date.now() - (book.updatedAt || 0) > 60000) return null;
    return book;
  }

  async _getWithRetry(url, config = {}) {
    const maxAttempts = Math.max(1, parseInt(process.env.SCAN_FETCH_RETRIES || '4', 10));
    const baseDelayMs = Math.max(100, parseInt(process.env.SCAN_FETCH_RETRY_BASE_MS || '400', 10));

    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        if (this.interRequestDelayMs > 0 && this._lastRequestAt > 0) {
          const elapsed = Date.now() - this._lastRequestAt;
          if (elapsed < this.interRequestDelayMs) await sleep(this.interRequestDelayMs - elapsed);
        }
        this._lastRequestAt = Date.now();
        return await axios.get(url, config);
      } catch (err) {
        lastErr = err;
        const status = err?.response?.status;
        const retryable = status === 429 || (status >= 500 && status <= 599) || !status;
        if (!retryable || attempt === maxAttempts) break;

        const expo = baseDelayMs * Math.pow(2, attempt - 1);
        const jitter = Math.floor(Math.random() * baseDelayMs);
        const retryAfterHeader = parseFloat(err?.response?.headers?.['retry-after'] || '0');
        const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
          ? Math.round(retryAfterHeader * 1000)
          : 0;
        const delayMs = Math.max(expo + jitter, retryAfterMs);
        await sleep(delayMs);
      }
    }
    throw lastErr;
  }

  /**
   * Fetch markets from Gamma /markets endpoint (flat list, good for sports/crypto).
   */
  async _fetchMarketsList(limit = 400) {
    const response = await this._getWithRetry(`${this.gammaApi}/markets`, {
      params: {
        closed: false,
        active: true,
        limit,
        order: 'volume',
        ascending: false
      },
      timeout: this.timeout
    });
    const list = Array.isArray(response.data) ? response.data : [];
    const normalized = [];
    for (const m of list) {
      const liquidity = parseFloat(m.liquidityNum ?? m.liquidity) ?? 0;
      if (liquidity < this.minLiquidity) continue;
      let outcomes, outcomePrices, clobTokenIds;
      try {
        outcomes = typeof m.outcomes === 'string' ? JSON.parse(m.outcomes) : (m.outcomes || ['Yes', 'No']);
        outcomePrices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
        clobTokenIds = typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : (m.clobTokenIds || []);
      } catch {
        continue;
      }
      if (!outcomePrices || outcomePrices.length < 2) continue;
      normalized.push({
        id: m.id,
        question: m.question,
        slug: m.slug,
        category: m.groupItemTitle || m.category || '',
        eventTitle: m.groupItemTitle || m.title || m.question || '',
        outcomes,
        outcomePrices,
        liquidity,
        volume: parseFloat(m.volumeNum ?? m.volume) ?? 0,
        conditionId: m.conditionId,
        endDate: m.endDate,
        bestBid: parseFloat(m.bestBid) || null,
        bestAsk: parseFloat(m.bestAsk) || null,
        spread: parseFloat(m.spread) || null,
        negRisk: m.negRisk || false,
        clobTokenIds: Array.isArray(clobTokenIds) ? clobTokenIds : [],
      });
    }
    return normalized;
  }

  async fetchMarkets(options = {}) {
    const allMarkets = [];
    let offset = 0;
    const maxEventPages = Math.max(1, parseInt(process.env.SCAN_MAX_EVENT_PAGES || '3', 10));
    let pageCount = 0;

    try {
      while (true) {
        const response = await this._getWithRetry(`${this.gammaApi}/events`, {
          params: {
            active: true,
            closed: false,
            order: 'volume',
            ascending: false,
            limit: this.pageSize,
            offset
          },
          timeout: this.timeout
        });

        const events = response.data;
        if (!Array.isArray(events) || events.length === 0) break;

        for (const event of events) {
          const markets = event.markets || [];
          for (const market of markets) {
            if (!market.active || market.closed) continue;

            const liquidity = parseFloat(market.liquidityNum || market.liquidity) || 0;
            if (liquidity < this.minLiquidity) continue;

            let outcomes, outcomePrices;
            try {
              outcomes = typeof market.outcomes === 'string'
                ? JSON.parse(market.outcomes) : market.outcomes;
              outcomePrices = typeof market.outcomePrices === 'string'
                ? JSON.parse(market.outcomePrices) : market.outcomePrices;
            } catch {
              continue;
            }

            let clobTokenIds = null;
            try {
              clobTokenIds = typeof market.clobTokenIds === 'string'
                ? JSON.parse(market.clobTokenIds) : market.clobTokenIds;
            } catch { /* optional field */ }

            allMarkets.push({
              id: market.id,
              question: market.question,
              slug: market.slug,
              category: event.slug,
              eventTitle: event.title,
              outcomes,
              outcomePrices,
              liquidity,
              volume: parseFloat(market.volumeNum || market.volume) || 0,
              conditionId: market.conditionId,
              endDate: market.endDate,
              bestBid: parseFloat(market.bestBid) || null,
              bestAsk: parseFloat(market.bestAsk) || null,
              spread: parseFloat(market.spread) || null,
              negRisk: market.negRisk || false,
              clobTokenIds: clobTokenIds || [],
            });
          }
        }

        pageCount++;
        if (events.length < this.pageSize || pageCount >= maxEventPages) break;
        offset += this.pageSize;
      }
    } catch (error) {
      throw new Error(`Failed to fetch markets: ${error.message}`);
    }

    const sectors = options.sectors ?? this.sectors;
    const needSportsOrCrypto = sectors && (sectors.includes('sports') || sectors.includes('crypto'));

    if (needSportsOrCrypto) {
      try {
        const extra = await this._fetchMarketsList(400);
        const byId = new Map(allMarkets.map(m => [m.id, m]));
        for (const m of extra) {
          if (!byId.has(m.id)) byId.set(m.id, m);
        }
        allMarkets.length = 0;
        allMarkets.push(...byId.values());
      } catch (err) {
        // Non-fatal: keep event-only markets
      }
    }

    if (sectors && sectors.length > 0) {
      const filtered = allMarkets.filter(m => marketInSectors(m, sectors));
      return filtered;
    }

    return allMarkets;
  }

  /**
   * Enrich a market with real CLOB orderbook data.
   * Falls back to Gamma mid-prices if CLOB fetch fails.
   */
  async enrichWithClob(market) {
    if (!this.useClobPricing) return market;
    const tokens = market.clobTokenIds;
    if (!tokens || tokens.length < 2) return market;

    let yesBook = this.getCachedClobPrice(tokens[0]);
    let noBook = this.getCachedClobPrice(tokens[1]);

    if (!yesBook || !noBook) {
      try {
        const fetches = [];
        if (!yesBook) fetches.push(this.clob.getOrderbook(tokens[0]).then(b => { yesBook = b; }));
        if (!noBook) fetches.push(this.clob.getOrderbook(tokens[1]).then(b => { noBook = b; }));
        await Promise.all(fetches);
      } catch { /* fall through */ }
    }

    if (yesBook && noBook) {
      return {
        ...market,
        clobYes: yesBook,
        clobNo: noBook,
        clobBestBid: yesBook.bestBid,
        clobBestAsk: yesBook.bestAsk,
        clobYesMid: yesBook.midpoint,
        clobNoMid: noBook.midpoint,
        clobSpread: yesBook.spread + noBook.spread,
        clobYesDepth: yesBook.bidDepth + yesBook.askDepth,
        clobNoDepth: noBook.bidDepth + noBook.askDepth,
        hasClobData: true,
      };
    }

    return { ...market, hasClobData: false };
  }

  calculateArbitrage(market) {
    const outcomes = market.outcomes || [];
    const prices = market.outcomePrices || [];

    const yesIndex = outcomes.findIndex(o =>
      o.toLowerCase().includes('yes') || o === '1'
    );
    const noIndex = outcomes.findIndex(o =>
      o.toLowerCase().includes('no') || o === '0'
    );

    if (yesIndex === -1 || noIndex === -1) return null;

    const gammYes = parseFloat(prices[yesIndex]) || 0;
    const gammaNo = parseFloat(prices[noIndex]) || 0;

    let yesPrice, noPrice, pricingSource;

    if (market.hasClobData && market.clobYes && market.clobNo) {
      yesPrice = market.clobYes.midpoint || gammYes;
      noPrice = market.clobNo.midpoint || gammaNo;
      pricingSource = 'clob';
    } else {
      yesPrice = gammYes;
      noPrice = gammaNo;
      pricingSource = 'gamma';
    }

    const sum = yesPrice + noPrice;
    if (sum === 0) return null;

    const edge = Math.abs(1 - sum);
    const edgePercent = edge;

    let executableEdge = edgePercent;
    let realSpread = null;
    if (market.hasClobData) {
      const yesAsk = market.clobYes.bestAsk;
      const noBid = market.clobNo.bestBid;
      const yesBid = market.clobYes.bestBid;
      const noAsk = market.clobNo.bestAsk;

      if (sum < 1) {
        const buyCost = yesAsk + noAsk;
        executableEdge = Math.max(0, 1 - buyCost);
      } else {
        const sellProceeds = yesBid + noBid;
        executableEdge = Math.max(0, sellProceeds - 1);
      }
      realSpread = market.clobSpread;
    }

    return {
      marketId: market.id,
      question: market.question,
      slug: market.slug,
      category: market.category,
      eventTitle: market.eventTitle,
      yesPrice,
      noPrice,
      sum,
      edge,
      edgePercent,
      executableEdge,
      pricingSource,
      liquidity: market.liquidity,
      volume: market.volume,
      conditionId: market.conditionId,
      endDate: market.endDate,
      bestBid: market.clobBestBid || market.bestBid,
      bestAsk: market.clobBestAsk || market.bestAsk,
      spread: realSpread ?? market.spread,
      clobYesDepth: market.clobYesDepth || null,
      clobNoDepth: market.clobNoDepth || null,
      direction: sum < 1 ? 'BUY_BOTH' : 'SELL_BOTH',
      maxPosition: this.calculateMaxPosition(market.liquidity, market),
      expectedReturn: executableEdge,
    };
  }

  calculateMaxPosition(liquidity, market) {
    const liq = parseFloat(liquidity) || 0;
    let cap = Math.min(liq * 0.02, 500);

    if (market?.hasClobData) {
      const depthBased = Math.min(
        (market.clobYesDepth || Infinity) * 0.1,
        (market.clobNoDepth || Infinity) * 0.1
      );
      cap = Math.min(cap, depthBased);
    }

    return cap;
  }

  async scan(options = {}) {
    const threshold = options.threshold || this.edgeThreshold;
    console.log(`Scanning Polymarket for arbitrage (threshold: ${(threshold * 100).toFixed(2)}%)...`);

    const markets = await this.fetchMarkets();

    if (this._wsConnected) {
      this.subscribeMarkets(markets);
    }

    const enrichBatch = options.enrichClob !== false && this.useClobPricing;
    let enriched = markets;

    if (enrichBatch) {
      const batchSize = 10;
      enriched = [];
      for (let i = 0; i < markets.length; i += batchSize) {
        const batch = markets.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(m => this.enrichWithClob(m))
        );
        for (const r of results) {
          enriched.push(r.status === 'fulfilled' ? r.value : batch[results.indexOf(r)]);
        }
      }
    }

    const opportunities = [];
    for (const market of enriched) {
      try {
        const arb = this.calculateArbitrage(market);
        if (arb && arb.edgePercent >= threshold) {
          opportunities.push(arb);
        }
      } catch (error) {
        console.warn(`Error processing market ${market.id}: ${error.message}`);
      }
    }

    opportunities.sort((a, b) => b.edgePercent - a.edgePercent);

    return {
      timestamp: new Date().toISOString(),
      marketsScanned: markets.length,
      opportunitiesFound: opportunities.length,
      clobEnriched: enriched.filter(m => m.hasClobData).length,
      threshold,
      opportunities
    };
  }

  async quickScan(threshold = 0.05) {
    const result = await this.scan({ threshold, enrichClob: false });
    return result.opportunities.filter(o => o.edgePercent >= threshold);
  }

  async fetchMarketPrice(marketId) {
    try {
      const response = await axios.get(`${this.gammaApi}/markets/${marketId}`, {
        timeout: 5000,
      });
      const market = response.data;
      if (!market) return null;

      let outcomePrices;
      try {
        outcomePrices = typeof market.outcomePrices === 'string'
          ? JSON.parse(market.outcomePrices) : market.outcomePrices;
      } catch { return null; }

      let outcomes;
      try {
        outcomes = typeof market.outcomes === 'string'
          ? JSON.parse(market.outcomes) : market.outcomes;
      } catch { return null; }

      const yesIndex = (outcomes || []).findIndex(o =>
        o.toLowerCase().includes('yes') || o === '1');
      const noIndex = (outcomes || []).findIndex(o =>
        o.toLowerCase().includes('no') || o === '0');

      if (yesIndex === -1 || noIndex === -1) return null;

      return {
        marketId,
        yesPrice: parseFloat(outcomePrices[yesIndex]) || 0,
        noPrice: parseFloat(outcomePrices[noIndex]) || 0,
        closed: market.closed || false,
        resolved: market.resolved || false,
      };
    } catch {
      return null;
    }
  }

  async fetchMarketPricesBatch(marketIds) {
    const results = {};
    const batchSize = 10;
    for (let i = 0; i < marketIds.length; i += batchSize) {
      const batch = marketIds.slice(i, i + batchSize);
      const settled = await Promise.allSettled(
        batch.map(id => this.fetchMarketPrice(id))
      );
      for (let j = 0; j < batch.length; j++) {
        if (settled[j].status === 'fulfilled' && settled[j].value) {
          results[batch[j]] = settled[j].value;
        }
      }
    }
    return results;
  }
}

module.exports = PolymarketScanner;
