/**
 * Polymarket Subgraph Client
 * Queries Goldsky-hosted GraphQL subgraphs for on-chain position, PnL,
 * activity, and order data on Polygon.
 */
const axios = require('axios');

const SUBGRAPHS = {
  positions: 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn',
  pnl:       'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/pnl-subgraph/0.0.14/gn',
  activity:  'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/activity-subgraph/0.0.4/gn',
  orders:    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/orderbook-subgraph/0.0.1/gn',
  oi:        'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/oi-subgraph/0.0.6/gn',
};

class SubgraphClient {
  constructor(config = {}) {
    this.endpoints = { ...SUBGRAPHS, ...config.endpoints };
    this.timeout = config.timeout || 15000;
    this._cache = new Map();
    this._cacheTTL = config.cacheTTL || 60000;
  }

  async query(subgraph, gql, variables = {}) {
    const url = this.endpoints[subgraph];
    if (!url) throw new Error(`Unknown subgraph: ${subgraph}`);

    const cacheKey = `${subgraph}:${gql}:${JSON.stringify(variables)}`;
    const cached = this._cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this._cacheTTL) return cached.data;

    const { data } = await axios.post(url, { query: gql, variables }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: this.timeout,
    });

    if (data.errors) {
      throw new Error(`Subgraph ${subgraph} error: ${data.errors[0]?.message}`);
    }

    this._cache.set(cacheKey, { data: data.data, ts: Date.now() });
    return data.data;
  }

  // ── Positions Subgraph ──

  async getWalletPositions(wallet, first = 100) {
    const gql = `{
      positions(
        where: { user: "${wallet.toLowerCase()}" }
        first: ${first}
        orderBy: balance
        orderDirection: desc
      ) {
        id
        condition
        outcomeIndex
        balance
        averagePrice
        realizedPnl
        user { id }
      }
    }`;
    const result = await this.query('positions', gql);
    return result.positions || [];
  }

  async getTopHolders(conditionId, first = 20) {
    const gql = `{
      positions(
        where: { condition: "${conditionId}" }
        first: ${first}
        orderBy: balance
        orderDirection: desc
      ) {
        id
        user { id }
        outcomeIndex
        balance
        averagePrice
        realizedPnl
      }
    }`;
    const result = await this.query('positions', gql);
    return result.positions || [];
  }

  // ── PnL Subgraph ──

  async getWalletPnl(wallet, first = 50) {
    const gql = `{
      pnls(
        where: { user: "${wallet.toLowerCase()}" }
        first: ${first}
        orderBy: realizedPnl
        orderDirection: desc
      ) {
        id
        user { id }
        condition
        realizedPnl
        numTrades
        outcomeIndex
      }
    }`;
    const result = await this.query('pnl', gql);
    return result.pnls || [];
  }

  async getTopProfitableWallets(first = 50) {
    const gql = `{
      pnls(
        first: ${first}
        orderBy: realizedPnl
        orderDirection: desc
      ) {
        id
        user { id }
        realizedPnl
        numTrades
        condition
        outcomeIndex
      }
    }`;
    const result = await this.query('pnl', gql);
    return result.pnls || [];
  }

  // ── Activity Subgraph ──

  async getRecentActivity(wallet, first = 50) {
    const gql = `{
      activities(
        where: { user: "${wallet.toLowerCase()}" }
        first: ${first}
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        type
        user { id }
        condition
        outcomeIndex
        amount
        timestamp
        transactionHash
      }
    }`;
    const result = await this.query('activity', gql);
    return result.activities || [];
  }

  async getMarketActivity(conditionId, first = 100) {
    const gql = `{
      activities(
        where: { condition: "${conditionId}" }
        first: ${first}
        orderBy: timestamp
        orderDirection: desc
      ) {
        id
        type
        user { id }
        outcomeIndex
        amount
        timestamp
      }
    }`;
    const result = await this.query('activity', gql);
    return result.activities || [];
  }

  // ── Open Interest ──

  async getMarketOI(conditionId) {
    const gql = `{
      openInterests(
        where: { condition: "${conditionId}" }
      ) {
        id
        condition
        openInterest
      }
    }`;
    const result = await this.query('oi', gql);
    return result.openInterests || [];
  }

  clearCache() {
    this._cache.clear();
  }
}

module.exports = SubgraphClient;
