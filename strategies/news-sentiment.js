/**
 * News-Driven Sentiment Strategy
 *
 * Scans for markets where real-world news events create tradeable
 * divergences from current Polymarket prices. Uses keyword matching
 * against a curated watchlist of news-driven themes.
 *
 * Signal sources:
 *   1. Geopolitical events (wars, sanctions, strikes) → crypto/oil markets
 *   2. Government shutdowns / policy deadlines → political markets
 *   3. Institutional catalysts (ETF filings, earnings) → crypto/equity markets
 *   4. Contrarian sentiment (extreme fear/greed divergence from fundamentals)
 *
 * The strategy maintains a "thesis registry" — manually curated
 * directional bets updated by the operator. Each thesis has:
 *   - keywords to match against market questions
 *   - a directional bias (bullish/bearish)
 *   - a confidence level
 *   - an expiry (auto-remove stale theses)
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');
const fs = require('fs');
const path = require('path');

const THESIS_PATH = path.join(__dirname, '..', 'data', 'news-theses.json');
const WHALE_SIGNALS_PATH = path.join(__dirname, '..', 'data', 'whale-signals.json');
const X_SIGNALS_PATH = path.join(__dirname, '..', 'data', 'x-sentiment-signals.json');

const DEFAULT_THESES = [
  {
    id: 'iran-escalation',
    keywords: ['iran', 'israel', 'strike', 'retaliation', 'middle east'],
    bias: 'bearish-crypto',
    direction: 'context',
    confidence: 0.7,
    notes: 'US/Israel struck Iran Feb 28. BTC dropped to $63K. Short-term fear but historically bounces within days.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
  },
  {
    id: 'btc-dip-overpriced',
    keywords: ['bitcoin dip', 'btc dip', 'bitcoin drop'],
    bias: 'contrarian-bullish',
    direction: 'BUY_NO',
    confidence: 0.65,
    notes: 'BTC dip markets overpriced. Bear market rallies common after geopolitical shocks. RSI oversold.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 3 * 24 * 3600 * 1000,
  },
  {
    id: 'eth-institutional',
    keywords: ['ethereum', 'eth price', 'ether'],
    bias: 'bullish',
    direction: 'BUY_YES',
    confidence: 0.7,
    notes: 'BlackRock staked ETH ETF filed. $157M ETF inflows Feb 25. Glamsterdam upgrade. Support at $1,850.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 14 * 24 * 3600 * 1000,
  },
  {
    id: 'shutdown-early-end',
    keywords: ['government shutdown', 'shutdown end', 'dhs funding'],
    bias: 'contrarian',
    direction: 'BUY_YES',
    confidence: 0.5,
    notes: 'Senate returns March 2. Markets price end ~March 26 but deal could come sooner. 55% past Easter.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 30 * 24 * 3600 * 1000,
  },
  {
    id: 'newsom-dem-primary',
    keywords: ['newsom', 'democratic primary', 'democratic presidential', '2028 democrat'],
    bias: 'bullish-newsom',
    direction: 'BUY_YES',
    confidence: 0.6,
    notes: 'Emerson poll Feb 2026: Newsom 20%, Buttigieg 16%, Harris 13%. Newsom leading but Polymarket may underprice.',
    createdAt: Date.now(),
    expiresAt: Date.now() + 60 * 24 * 3600 * 1000,
  },
];

function loadTheses() {
  try {
    const raw = JSON.parse(fs.readFileSync(THESIS_PATH, 'utf8'));
    const theses = Array.isArray(raw) ? raw : (raw.theses || []);
    return theses.filter(t => !t.expiresAt || new Date(t.expiresAt) > new Date());
  } catch {
    return DEFAULT_THESES;
  }
}

function loadOracleSignals() {
  const signals = { whales: [], xSentiment: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(WHALE_SIGNALS_PATH, 'utf8'));
    const cutoff = Date.now() - 3600000; // last hour
    signals.whales = (Array.isArray(raw) ? raw : []).filter(s => s.timestamp > cutoff);
  } catch {}
  try {
    const raw = JSON.parse(fs.readFileSync(X_SIGNALS_PATH, 'utf8'));
    const cutoff = Date.now() - 3600000;
    signals.xSentiment = (Array.isArray(raw) ? raw : []).filter(s => s.timestamp > cutoff);
  } catch {}
  return signals;
}

function boostConfidenceFromOracle(opp, oracleSignals) {
  let boost = 0;
  for (const ws of oracleSignals.whales) {
    if (ws.marketId === opp.conditionId && ws.confidence > 0.4) {
      const sameDirection = (ws.direction === 'BUY' && opp.direction === 'BUY_YES') ||
                            (ws.direction === 'SELL' && opp.direction === 'BUY_NO');
      if (sameDirection) boost += 0.01 * ws.confidence;
    }
  }
  const category = (opp.category || '').toLowerCase();
  for (const xs of oracleSignals.xSentiment) {
    if (xs.category && category.includes(xs.category)) {
      const sameDirection = (xs.sentiment === 'bullish' && opp.direction === 'BUY_YES') ||
                            (xs.sentiment === 'bearish' && opp.direction === 'BUY_NO');
      if (sameDirection && xs.confidence > 0.1) boost += 0.005 * xs.confidence;
    }
  }
  return Math.min(boost, 0.02);
}

function saveTheses(theses) {
  try {
    fs.writeFileSync(THESIS_PATH, JSON.stringify(theses, null, 2));
  } catch {}
}

function matchesThesis(question, thesis) {
  const q = (question || '').toLowerCase();
  return thesis.keywords.some(kw => q.includes(kw.toLowerCase()));
}

function parsePrice(market) {
  let prices;
  try {
    prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
  } catch { return null; }
  if (!prices || prices.length < 2) return null;
  return { yes: parseFloat(prices[0]) || 0, no: parseFloat(prices[1]) || 0 };
}

const newsSentimentStrategy = {
  name: 'news-sentiment',
  type: 'sentiment',
  riskLevel: 'high',

  async scan(bot) {
    const TIMEOUT = 15000;
    return Promise.race([
      this._doScan(bot),
      new Promise((_, rej) => setTimeout(() => rej(new Error('news-sentiment timed out')), TIMEOUT)),
    ]).catch(err => { console.error('[news-sentiment]', err.message); return []; });
  },

  async _doScan(bot) {
    try {
      const theses = loadTheses();
      if (theses.length === 0) return [];

      const markets = await fetchMarketsOnce();
      const oracleSignals = loadOracleSignals();
      const opportunities = [];

      for (const market of markets) {
        if (market.active === false || market.closed) continue;

        const prices = parsePrice(market);
        if (!prices) continue;
        if (prices.yes < 0.05 || prices.yes > 0.95) continue;

        for (const thesis of theses) {
          if (!matchesThesis(market.question, thesis)) continue;

          let direction = thesis.direction;
          let edge = 0;

          if (direction === 'context') continue;

          if (direction === 'BUY_YES') {
            edge = (1 - prices.yes) * thesis.confidence * 0.12;
          } else if (direction === 'BUY_NO') {
            edge = (1 - prices.no) * thesis.confidence * 0.12;
          } else {
            continue;
          }

          const netEdge = Math.max(0, edge - 0.006);
          if (netEdge < 0.02) continue;
          if ((market.liquidity || 0) < 5000) continue;

          const oracleBoost = boostConfidenceFromOracle(
            { conditionId: market.conditionId, direction, category: market.category || market.eventTitle },
            oracleSignals
          );

          opportunities.push({
            marketId: market.id,
            question: market.question,
            slug: market.slug,
            category: market.category || market.eventTitle,
            eventTitle: market.eventTitle,
            yesPrice: prices.yes,
            noPrice: prices.no,
            sum: prices.yes + prices.no,
            edge: edge + oracleBoost,
            edgePercent: netEdge + oracleBoost,
            executableEdge: netEdge + oracleBoost,
            oracleBoost,
            liquidity: market.liquidity || 0,
            volume: market.volume || 0,
            conditionId: market.conditionId,
            endDate: market.endDate,
            direction,
            maxPosition: Math.min((market.liquidity || 0) * 0.008, 150),
            expectedReturn: netEdge,
            confidence: thesis.confidence,
            strategy: 'news-sentiment',
            thesisId: thesis.id,
            thesisBias: thesis.bias,
            thesisNotes: thesis.notes,
          });
          break;
        }
      }

      opportunities.sort((a, b) => b.edgePercent - a.edgePercent);
      return opportunities.slice(0, 10);
    } catch (err) {
      console.error('[news-sentiment]', err.message);
      return [];
    }
  },

  async validate(opp) {
    return opp && opp.edgePercent >= 0.02 && opp.thesisId;
  },

  async execute(bot, opp) {
    return bot.execute(opp, { size: opp.maxPosition });
  },

  getTheses() { return loadTheses(); },

  addThesis(thesis) {
    const theses = loadTheses();
    thesis.id = thesis.id || `thesis-${Date.now()}`;
    thesis.createdAt = Date.now();
    thesis.expiresAt = thesis.expiresAt || Date.now() + 7 * 24 * 3600 * 1000;
    theses.push(thesis);
    saveTheses(theses);
    return thesis;
  },

  removeThesis(id) {
    const theses = loadTheses().filter(t => t.id !== id);
    saveTheses(theses);
  },
};

module.exports = [newsSentimentStrategy];
