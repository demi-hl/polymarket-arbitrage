const axios = require('axios');

/**
 * Polymarket Scanner
 * Uses the Gamma API for market discovery and the CLOB API for pricing.
 * Scans for arbitrage opportunities where YES + NO != $1.
 */
class PolymarketScanner {
  constructor(config = {}) {
    this.gammaApi = config.gammaApi || 'https://gamma-api.polymarket.com';
    this.clobApi = config.clobApi || 'https://clob.polymarket.com';
    this.minLiquidity = config.minLiquidity || 1000;
    this.edgeThreshold = config.edgeThreshold || 0.05;
    this.timeout = config.timeout || 15000;
    this.pageSize = config.pageSize || 100;
  }

  async fetchMarkets() {
    const allMarkets = [];
    let offset = 0;

    try {
      while (true) {
        const response = await axios.get(`${this.gammaApi}/events`, {
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
              negRisk: market.negRisk || false
            });
          }
        }

        if (events.length < this.pageSize) break;
        offset += this.pageSize;
      }
    } catch (error) {
      throw new Error(`Failed to fetch markets: ${error.message}`);
    }

    return allMarkets;
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

    const yesPrice = parseFloat(prices[yesIndex]) || 0;
    const noPrice = parseFloat(prices[noIndex]) || 0;
    const sum = yesPrice + noPrice;

    if (sum === 0) return null;

    const edge = Math.abs(1 - sum);
    const edgePercent = edge;

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
      liquidity: market.liquidity,
      volume: market.volume,
      conditionId: market.conditionId,
      endDate: market.endDate,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      spread: market.spread,
      direction: sum < 1 ? 'BUY_BOTH' : 'SELL_BOTH',
      maxPosition: this.calculateMaxPosition(market.liquidity),
      expectedReturn: edgePercent
    };
  }

  calculateMaxPosition(liquidity) {
    const liq = parseFloat(liquidity) || 0;
    return Math.min(liq * 0.05, 1000);
  }

  async scan(options = {}) {
    const threshold = options.threshold || this.edgeThreshold;
    console.log(`🔍 Scanning Polymarket for arbitrage (threshold: ${(threshold * 100).toFixed(2)}%)...`);

    const markets = await this.fetchMarkets();
    const opportunities = [];

    for (const market of markets) {
      try {
        const arb = this.calculateArbitrage(market);
        if (arb && arb.edgePercent >= threshold) {
          opportunities.push(arb);
        }
      } catch (error) {
        console.warn(`⚠️ Error processing market ${market.id}: ${error.message}`);
      }
    }

    opportunities.sort((a, b) => b.edgePercent - a.edgePercent);

    return {
      timestamp: new Date().toISOString(),
      marketsScanned: markets.length,
      opportunitiesFound: opportunities.length,
      threshold,
      opportunities
    };
  }

  async quickScan(threshold = 0.05) {
    const result = await this.scan({ threshold });
    return result.opportunities.filter(o => o.edgePercent >= threshold);
  }
}

module.exports = PolymarketScanner;
