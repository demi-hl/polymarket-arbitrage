const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { fetchMarketsOnce } = require('./lib/with-scanner');

const X_SIGNALS_PATH = path.join(__dirname, '..', 'data', 'x-sentiment-signals.json');
const WHALE_SIGNALS_PATH = path.join(__dirname, '..', 'data', 'whale-signals.json');
const NEWS_THESES_PATH = path.join(__dirname, '..', 'data', 'news-theses.json');
const BINANCE_API = 'https://api.binance.com/api/v3/klines';

let _ctxCache = null;
let _ctxTs = 0;
let _ctxPromise = null;
const CTX_TTL_MS = 60_000;

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function stdDev(arr) {
  if (arr.length < 2) return 1;
  const m = mean(arr);
  const v = mean(arr.map(x => (x - m) ** 2));
  return Math.sqrt(v) || 1;
}

function zScore(v, arr) {
  const m = mean(arr);
  const s = stdDev(arr);
  return (v - m) / s;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parsePrices(market) {
  try {
    const p = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices)
      : market.outcomePrices;
    if (!Array.isArray(p) || p.length < 2) return null;
    return { yes: Number(p[0]) || 0, no: Number(p[1]) || 0 };
  } catch {
    return null;
  }
}

function parseStrike(question) {
  const m = String(question || '').match(/\$\s*([\d,]+(?:\.\d+)?)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function detectAsset(question = '') {
  const q = question.toLowerCase();
  if (q.includes('bitcoin') || q.includes('btc')) return 'BTC';
  if (q.includes('ethereum') || q.includes('eth')) return 'ETH';
  if (q.includes('solana') || q.includes('sol')) return 'SOL';
  return null;
}

function detectDirection(question = '') {
  const q = question.toLowerCase();
  if (q.includes('below') || q.includes('under') || q.includes('dip')) return 'below';
  return 'above';
}

function readJsonArray(filePath) {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(raw) ? raw : (Array.isArray(raw?.theses) ? raw.theses : []);
  } catch {
    return [];
  }
}

function returnsFromCloses(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (!prev) continue;
    out.push((closes[i] - prev) / prev);
  }
  return out;
}

function ema(series, period) {
  if (series.length < period) return series[series.length - 1] || 0;
  const k = 2 / (period + 1);
  let val = mean(series.slice(0, period));
  for (let i = period; i < series.length; i++) {
    val = series[i] * k + val * (1 - k);
  }
  return val;
}

function rsi(series, period = 14) {
  if (series.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = series.length - period; i < series.length; i++) {
    const d = series[i] - series[i - 1];
    if (d >= 0) gains += d;
    else losses += Math.abs(d);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - (100 / (1 + rs));
}

async function fetchBinanceStats(symbol) {
  try {
    const res = await axios.get(BINANCE_API, {
      params: { symbol: `${symbol}USDT`, interval: '5m', limit: 120 },
      timeout: 4000,
    });
    const rows = Array.isArray(res.data) ? res.data : [];
    const closes = rows.map(r => Number(r[4])).filter(Number.isFinite);
    if (closes.length < 40) return null;

    const rets = returnsFromCloses(closes);
    const current = closes[closes.length - 1];
    const mom30 = (current - closes[Math.max(0, closes.length - 7)]) / closes[Math.max(0, closes.length - 7)];
    const mom60 = (current - closes[Math.max(0, closes.length - 13)]) / closes[Math.max(0, closes.length - 13)];
    const mom90 = (current - closes[Math.max(0, closes.length - 19)]) / closes[Math.max(0, closes.length - 19)];
    const accel = mom30 - mom60;
    const sigma = stdDev(rets) * Math.sqrt(365 * 24 * 12); // 5m bars annualized
    const rsi14 = rsi(closes, 14);
    const macd = ema(closes, 12) - ema(closes, 26);
    return { spot: current, mom30, mom60, mom90, accel, sigma, rsi: rsi14, macd };
  } catch {
    return null;
  }
}

async function getContext() {
  const now = Date.now();
  if (_ctxCache && now - _ctxTs < CTX_TTL_MS) return _ctxCache;
  if (_ctxPromise) return _ctxPromise;

  _ctxPromise = (async () => {
    const [markets, btc, eth, sol] = await Promise.all([
      fetchMarketsOnce(),
      fetchBinanceStats('BTC'),
      fetchBinanceStats('ETH'),
      fetchBinanceStats('SOL'),
    ]);

    const cutoff = now - 60 * 60 * 1000;
    const xSignals = readJsonArray(X_SIGNALS_PATH).filter(s => !s.timestamp || s.timestamp > cutoff);
    const whaleSignals = readJsonArray(WHALE_SIGNALS_PATH).filter(s => !s.timestamp || s.timestamp > cutoff);
    const theses = readJsonArray(NEWS_THESES_PATH).filter(t => !t.expiresAt || t.expiresAt > now);

    const ctx = {
      markets: Array.isArray(markets) ? markets : [],
      binance: { BTC: btc, ETH: eth, SOL: sol },
      xSignals,
      whaleSignals,
      theses,
      now,
    };
    _ctxCache = ctx;
    _ctxTs = now;
    _ctxPromise = null;
    return ctx;
  })();

  return _ctxPromise;
}

function buildOpportunity(base, extras = {}) {
  return {
    marketId: base.market.id,
    question: base.market.question,
    slug: base.market.slug,
    category: base.market.category || base.market.eventTitle || 'crypto',
    eventTitle: base.market.eventTitle || base.market.category || 'Crypto',
    yesPrice: base.prices.yes,
    noPrice: base.prices.no,
    sum: base.prices.yes + base.prices.no,
    liquidity: Number(base.market.liquidity || 0),
    volume: Number(base.market.volume || 0),
    conditionId: base.market.conditionId,
    endDate: base.market.endDate,
    clobTokenIds: Array.isArray(base.market.clobTokenIds) ? base.market.clobTokenIds : [],
    direction: extras.direction || 'BUY_YES',
    maxPosition: extras.maxPosition || Math.min((base.market.liquidity || 0) * 0.01, 180),
    edge: extras.edge || 0,
    edgePercent: extras.edgePercent || 0,
    executableEdge: extras.edgePercent || 0,
    expectedReturn: extras.edgePercent || 0,
    confidence: clamp(extras.confidence || 0.5, 0, 1),
    ...extras,
  };
}

function marketBase(ctx) {
  const out = [];
  for (const market of ctx.markets) {
    if (market.active === false || market.closed) continue;
    const prices = parsePrices(market);
    if (!prices) continue;
    if (prices.yes <= 0.02 || prices.yes >= 0.98) continue;
    const asset = detectAsset(market.question || '');
    if (!asset) continue;
    const strike = parseStrike(market.question || '');
    if (!Number.isFinite(strike) || strike <= 0) continue;
    const directionType = detectDirection(market.question || '');
    const b = ctx.binance[asset];
    if (!b?.spot) continue;
    out.push({ market, prices, asset, strike, directionType, binance: b });
  }
  return out;
}

function sideFromModel(predictedSpot, strike, directionType) {
  const yesResolvesTrue = directionType === 'above'
    ? predictedSpot >= strike
    : predictedSpot < strike;
  return yesResolvesTrue ? 'BUY_YES' : 'BUY_NO';
}

function probabilityFromGbm(spot, strike, sigma, yearsToExpiry) {
  if (!spot || !strike || !sigma || !yearsToExpiry || yearsToExpiry <= 0) return 0.5;
  const t = Math.max(yearsToExpiry, 1 / (365 * 24 * 12)); // minimum ~5m
  const denom = sigma * Math.sqrt(t);
  if (denom <= 0) return 0.5;
  const d1 = (Math.log(spot / strike) + ((sigma * sigma) / 2) * t) / denom;
  // Normal CDF approximation
  const cdf = 0.5 * (1 + Math.tanh(Math.sqrt(2 / Math.PI) * (d1 + 0.044715 * (d1 ** 3))));
  return clamp(cdf, 0.01, 0.99);
}

async function factorCompositeScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  if (!base.length) return [];

  const moms = base.map(b => b.binance.mom90 || 0);
  const accels = base.map(b => b.binance.accel || 0);
  const rsis = base.map(b => b.binance.rsi || 50);
  const macds = base.map(b => b.binance.macd || 0);
  const liqs = base.map(b => Number(b.market.liquidity || 0));
  const spreads = base.map(b => Math.abs((Number(b.market.bestAsk || b.prices.yes) - Number(b.market.bestBid || b.prices.yes))));

  const scored = base.map(b => {
    const momentumZ = zScore(b.binance.mom90 || 0, moms);
    const accelZ = zScore(b.binance.accel || 0, accels);
    const rsiSignal = b.binance.rsi > 70 ? -1 : b.binance.rsi < 30 ? 1 : (50 - b.binance.rsi) / 50;
    const rsiZ = zScore(rsiSignal, rsis.map(v => (v > 70 ? -1 : v < 30 ? 1 : (50 - v) / 50)));
    const macdZ = zScore(b.binance.macd || 0, macds);
    const liqZ = zScore(Number(b.market.liquidity || 0), liqs);
    const spreadZ = -zScore(Math.abs((Number(b.market.bestAsk || b.prices.yes) - Number(b.market.bestBid || b.prices.yes))), spreads);
    const score = momentumZ * 0.22 + accelZ * 0.14 + rsiZ * 0.12 + macdZ * 0.18 + liqZ * 0.20 + spreadZ * 0.14;
    const predicted = b.binance.spot * (1 + (b.binance.mom30 || 0) * 0.45 + (b.binance.accel || 0) * 0.25);
    const direction = sideFromModel(predicted, b.strike, b.directionType);
    const edge = clamp(Math.abs(score) * 0.018 + 0.008, 0, 0.09);
    return { b, score, direction, edge };
  });

  return scored
    .filter(s => s.edge >= 0.02)
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
    .slice(0, 8)
    .map(s => buildOpportunity(s.b, {
      strategy: 'factor-composite-ranker',
      direction: s.direction,
      edge: s.edge,
      edgePercent: s.edge,
      confidence: clamp(Math.abs(s.score) / 2.5, 0.45, 0.9),
      compositeScore: Number(s.score.toFixed(3)),
      factors: 'momentum,acceleration,rsi,macd,liquidity,spread',
    }));
}

async function sentimentShockScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  if (!base.length) return [];

  const xByAsset = { BTC: 0, ETH: 0, SOL: 0 };
  for (const s of ctx.xSignals) {
    const txt = `${s.asset || ''} ${s.category || ''} ${s.keyword || ''}`.toUpperCase();
    const w = Number(s.confidence || 0.2) * (Number(s.engagement || 1) > 1 ? 1.2 : 1);
    if (txt.includes('BTC') || txt.includes('BITCOIN')) xByAsset.BTC += s.sentiment === 'bearish' ? -w : w;
    if (txt.includes('ETH') || txt.includes('ETHEREUM')) xByAsset.ETH += s.sentiment === 'bearish' ? -w : w;
    if (txt.includes('SOL') || txt.includes('SOLANA')) xByAsset.SOL += s.sentiment === 'bearish' ? -w : w;
  }

  const out = [];
  for (const b of base) {
    const thesisHits = ctx.theses.filter(t => {
      const q = (b.market.question || '').toLowerCase();
      return (t.keywords || []).some(k => q.includes(String(k).toLowerCase()));
    }).length;
    const shock = (xByAsset[b.asset] || 0) * 0.7 + thesisHits * 0.35;
    if (Math.abs(shock) < 0.6) continue;
    const projected = b.binance.spot * (1 + clamp(shock * 0.006, -0.06, 0.06));
    const direction = sideFromModel(projected, b.strike, b.directionType);
    const edge = clamp(0.016 + Math.abs(shock) * 0.012, 0, 0.08);
    if (edge < 0.02) continue;
    out.push(buildOpportunity(b, {
      strategy: 'sentiment-shock',
      direction,
      edge,
      edgePercent: edge,
      confidence: clamp(0.55 + Math.abs(shock) * 0.12, 0.5, 0.9),
      sentimentShock: Number(shock.toFixed(3)),
      thesisMatches: thesisHits,
    }));
  }
  return out.slice(0, 8);
}

async function onchainFlowLeadLagScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  if (!base.length) return [];

  const flowByAsset = { BTC: 0, ETH: 0, SOL: 0 };
  for (const s of ctx.whaleSignals) {
    const txt = `${s.marketId || ''} ${s.asset || ''} ${s.symbol || ''} ${s.description || ''}`.toUpperCase();
    const mag = Number(s.confidence || 0.35);
    const signed = s.direction === 'SELL' ? -mag : mag;
    if (txt.includes('BTC') || txt.includes('BITCOIN')) flowByAsset.BTC += signed;
    if (txt.includes('ETH') || txt.includes('ETHEREUM')) flowByAsset.ETH += signed;
    if (txt.includes('SOL') || txt.includes('SOLANA')) flowByAsset.SOL += signed;
  }

  return base
    .map(b => {
      const flow = flowByAsset[b.asset] || 0;
      if (Math.abs(flow) < 0.45) return null;
      const projected = b.binance.spot * (1 + clamp(flow * 0.004, -0.04, 0.04));
      const direction = sideFromModel(projected, b.strike, b.directionType);
      const edge = clamp(0.012 + Math.abs(flow) * 0.015, 0, 0.06);
      if (edge < 0.02) return null;
      return buildOpportunity(b, {
        strategy: 'onchain-flow-leadlag',
        direction,
        edge,
        edgePercent: edge,
        confidence: clamp(0.52 + Math.abs(flow) * 0.18, 0.5, 0.88),
        flowSignal: Number(flow.toFixed(3)),
      });
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function microstructurePressureScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  if (!base.length) return [];

  return base
    .map(b => {
      const bid = Number(b.market.bestBid || b.prices.yes);
      const ask = Number(b.market.bestAsk || b.prices.yes);
      const spread = Math.abs(ask - bid);
      const ofi = spread > 0 ? clamp((0.04 - spread) / 0.04, -1, 1) : 0;
      const vpin = clamp(Math.abs(b.binance.accel || 0) * 8 + Math.abs(b.binance.mom30 || 0) * 4, 0, 1);
      if (Math.abs(ofi) < 0.2 || vpin < 0.35) return null;
      const projected = b.binance.spot * (1 + clamp((b.binance.mom30 || 0) * 0.5 + ofi * 0.01, -0.05, 0.05));
      const direction = sideFromModel(projected, b.strike, b.directionType);
      const edge = clamp(0.01 + Math.abs(ofi) * 0.02 + vpin * 0.01, 0, 0.07);
      if (edge < 0.02) return null;
      return buildOpportunity(b, {
        strategy: 'microstructure-pressure',
        direction,
        edge,
        edgePercent: edge,
        confidence: clamp(0.5 + vpin * 0.35, 0.5, 0.9),
        ofi: Number(ofi.toFixed(3)),
        vpin: Number(vpin.toFixed(3)),
        spread: Number(spread.toFixed(4)),
      });
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function gbmMispricingScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  const out = [];
  for (const b of base) {
    const expiry = b.market.endDate ? new Date(b.market.endDate).getTime() : (ctx.now + 15 * 60 * 1000);
    const tYears = Math.max(1, expiry - ctx.now) / (1000 * 60 * 60 * 24 * 365);
    let p = probabilityFromGbm(b.binance.spot, b.strike, b.binance.sigma || 0.6, tYears);
    p += clamp((b.binance.mom90 || 0) * 0.05, -0.05, 0.05);
    p += clamp((b.binance.accel || 0) * 0.07, -0.07, 0.07);
    p = clamp(p, 0.01, 0.99);
    const marketProb = b.prices.yes;
    const rawEdge = Math.abs(p - marketProb);
    const edge = rawEdge - 0.01;
    if (edge < 0.10) continue;
    const direction = p > marketProb ? 'BUY_YES' : 'BUY_NO';
    out.push(buildOpportunity(b, {
      strategy: 'gbm-mispricing',
      direction,
      edge: rawEdge,
      edgePercent: clamp(edge, 0, 0.2),
      confidence: clamp(0.6 + edge * 1.8, 0.6, 0.95),
      modelProb: Number(p.toFixed(4)),
      marketProb: Number(marketProb.toFixed(4)),
    }));
  }
  return out.slice(0, 6);
}

async function regimeSwitchScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  return base
    .map(b => {
      const sigma = b.binance.sigma || 0.7;
      const trending = Math.abs(b.binance.mom90 || 0) > 0.015 && Math.abs(b.binance.accel || 0) > 0.004;
      const regime = trending ? 'trending' : (sigma > 0.95 ? 'volatile' : 'sideways');
      const threshold = regime === 'trending' ? 0.018 : regime === 'volatile' ? 0.03 : 0.028;
      const signalStrength = Math.abs(b.binance.mom90 || 0) + Math.abs(b.binance.accel || 0);
      const edge = clamp(0.012 + signalStrength * (regime === 'trending' ? 1.8 : 1.1), 0, 0.09);
      if (edge < threshold) return null;
      const projected = b.binance.spot * (1 + (b.binance.mom90 || 0) * (regime === 'trending' ? 0.7 : 0.35));
      const direction = sideFromModel(projected, b.strike, b.directionType);
      return buildOpportunity(b, {
        strategy: 'regime-switch',
        direction,
        edge,
        edgePercent: edge,
        confidence: clamp(0.5 + signalStrength * 8, 0.5, 0.9),
        regime,
        adaptiveThreshold: threshold,
      });
    })
    .filter(Boolean)
    .slice(0, 8);
}

async function varSharpeGuardScan() {
  const ctx = await getContext();
  const base = marketBase(ctx);
  const out = [];
  for (const b of base) {
    const sigma = b.binance.sigma || 0.8;
    const expiry = b.market.endDate ? new Date(b.market.endDate).getTime() : (ctx.now + 6 * 60 * 60 * 1000);
    const tYears = Math.max(1, expiry - ctx.now) / (1000 * 60 * 60 * 24 * 365);
    const volHorizon = sigma * Math.sqrt(tYears);
    const signal = Math.abs(b.binance.mom90 || 0) + Math.abs(b.binance.accel || 0);
    const expected = clamp(0.01 + signal * 1.3, 0.01, 0.12);
    const var95 = expected - 1.645 * volHorizon;
    const sharpe = volHorizon > 0 ? expected / volHorizon : 0;
    if (sharpe < 1.0 || var95 < -0.25) continue;
    const projected = b.binance.spot * (1 + (b.binance.mom90 || 0) * 0.4);
    const direction = sideFromModel(projected, b.strike, b.directionType);
    out.push(buildOpportunity(b, {
      strategy: 'var-sharpe-guard',
      direction,
      edge: expected,
      edgePercent: expected,
      confidence: clamp(0.55 + sharpe * 0.12, 0.55, 0.92),
      var95: Number(var95.toFixed(4)),
      sharpe: Number(sharpe.toFixed(3)),
    }));
  }
  return out.slice(0, 6);
}

async function rankedPortfolioScoutScan() {
  const [a, b, c] = await Promise.all([
    factorCompositeScan(),
    gbmMispricingScan(),
    regimeSwitchScan(),
  ]);
  const merged = [...a, ...b, ...c];
  const byKey = new Map();
  for (const o of merged) {
    const key = `${o.marketId}:${o.direction}`;
    const prev = byKey.get(key);
    if (!prev || (o.edgePercent || 0) > (prev.edgePercent || 0)) byKey.set(key, o);
  }
  return [...byKey.values()]
    .map(o => ({
      ...o,
      strategy: 'ranked-portfolio-scout',
      rankScore: (o.edgePercent || 0) * (o.confidence || 0.5) * Math.log10((o.liquidity || 1000) + 10),
    }))
    .sort((x, y) => y.rankScore - x.rankScore)
    .slice(0, 6)
    .map(o => ({
      ...o,
      edgePercent: clamp((o.edgePercent || 0) * 0.9, 0, 0.12),
      executableEdge: clamp((o.edgePercent || 0) * 0.9, 0, 0.12),
      maxPosition: Math.min(o.maxPosition || 100, 240),
    }));
}

function wrapStrategy(name, type, riskLevel, scanner) {
  return {
    name,
    type,
    riskLevel,
    async scan() {
      try {
        const opps = await scanner();
        return Array.isArray(opps) ? opps.filter(o => o.edgePercent >= 0.02) : [];
      } catch (err) {
        console.error(`[${name}]`, err.message);
        return [];
      }
    },
    async validate(opp) {
      return !!opp && (opp.edgePercent || 0) >= 0.02 && (opp.liquidity || 0) >= 5000;
    },
    async execute(bot, opp) {
      return bot.execute(opp, { size: opp.maxPosition });
    },
  };
}

module.exports = [
  wrapStrategy('factor-composite-ranker', 'quant', 'medium', factorCompositeScan),
  wrapStrategy('sentiment-shock', 'sentiment', 'high', sentimentShockScan),
  wrapStrategy('onchain-flow-leadlag', 'flow', 'high', onchainFlowLeadLagScan),
  wrapStrategy('microstructure-pressure', 'microstructure', 'high', microstructurePressureScan),
  wrapStrategy('gbm-mispricing', 'probability-model', 'medium', gbmMispricingScan),
  wrapStrategy('regime-switch', 'adaptive', 'medium', regimeSwitchScan),
  wrapStrategy('var-sharpe-guard', 'risk-adjusted', 'low', varSharpeGuardScan),
  wrapStrategy('ranked-portfolio-scout', 'portfolio-construction', 'medium', rankedPortfolioScoutScan),
];

