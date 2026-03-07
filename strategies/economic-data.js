/**
 * Economic Data Strategy
 *
 * Targets macro-economic prediction markets: CPI, unemployment, Fed rate
 * decisions, GDP, NFP, retail sales, etc. Compares market pricing against
 * economic forecasts from FRED, consensus estimates, and leading indicators.
 *
 * Edge sources:
 * - Consensus forecasts from Bloomberg/Reuters surveys
 * - FRED real-time data releases
 * - Leading indicator signals (ISM, PMI, initial claims trends)
 * - Historical seasonal patterns in economic data
 * - Market overreaction to headline numbers vs revisions
 */

const axios = require('axios');
const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

const ECON_KEYWORDS = [
  'cpi', 'inflation', 'pce', 'deflation', 'price index',
  'unemployment', 'jobless', 'nonfarm', 'non-farm', 'payrolls', 'jobs report',
  'gdp', 'gross domestic', 'economic growth', 'recession',
  'federal reserve', 'fed rate', 'interest rate', 'fomc', 'rate cut', 'rate hike',
  'basis points', 'bps', 'quantitative', 'tightening', 'easing',
  'retail sales', 'consumer spending', 'pmi', 'ism',
  'housing starts', 'building permits', 'home sales',
  'trade deficit', 'trade balance', 'current account',
  'treasury', 'yield curve', 'inverted', 'bond',
  'debt ceiling', 'government shutdown', 'fiscal',
  'tariff', 'trade war', 'sanctions',
];

// FRED API (St. Louis Fed — free with key)
const FRED_API = 'https://api.stlouisfed.org/fred';
const FRED_KEY = process.env.FRED_API_KEY || '';

// CME FedWatch-style rate probabilities
const FED_FUNDS_CURRENT = 4.50; // Update periodically

let _fredCache = {};
const FRED_TTL = 3600_000; // 1 hour for economic data

// Historical patterns
const SEASONAL_CPI = [0.3, 0.4, 0.3, 0.3, 0.2, 0.1, 0.1, 0.2, 0.3, 0.2, 0.1, 0.1]; // Avg monthly CPI change by month
const SEASONAL_UNEMPLOYMENT = [3.8, 3.9, 3.8, 3.7, 3.6, 3.7, 3.8, 3.7, 3.6, 3.6, 3.7, 3.8]; // Avg by month

/**
 * Fetch latest economic data from FRED
 */
async function fetchFREDSeries(seriesId) {
  const cacheKey = `fred_${seriesId}`;
  if (_fredCache[cacheKey] && Date.now() - _fredCache[cacheKey].ts < FRED_TTL) {
    return _fredCache[cacheKey].data;
  }

  if (!FRED_KEY) return null;

  try {
    const res = await axios.get(`${FRED_API}/series/observations`, {
      params: {
        series_id: seriesId,
        api_key: FRED_KEY,
        file_type: 'json',
        sort_order: 'desc',
        limit: 24,
      },
      timeout: 8000,
    });
    const observations = (res.data?.observations || []).map(o => ({
      date: o.date,
      value: parseFloat(o.value),
    })).filter(o => !isNaN(o.value));

    _fredCache[cacheKey] = { data: observations, ts: Date.now() };
    return observations;
  } catch {
    return null;
  }
}

/**
 * Estimate CPI probability given a threshold
 * Uses trend extrapolation + seasonal adjustment
 */
async function estimateCPIProbability(threshold, isAbove = true) {
  const data = await fetchFREDSeries('CPIAUCSL'); // CPI All Urban Consumers
  if (!data || data.length < 6) {
    // Fallback to seasonal pattern
    const month = new Date().getMonth();
    const seasonalAvg = SEASONAL_CPI[month];
    const annualized = seasonalAvg * 12;

    if (isAbove) return threshold < annualized ? 0.6 : 0.35;
    return threshold > annualized ? 0.6 : 0.35;
  }

  // Calculate YoY CPI change trend
  const latest = data[0].value;
  const yearAgo = data.find(d => {
    const diff = new Date(data[0].date) - new Date(d.date);
    return diff > 300 * 86400000; // ~10 months ago minimum
  });

  if (!yearAgo) return null;

  const yoyChange = ((latest - yearAgo.value) / yearAgo.value) * 100;

  // 3-month trend
  const threeMonthAgo = data[2]?.value;
  const trend = threeMonthAgo ? ((latest - threeMonthAgo) / threeMonthAgo) * 400 : yoyChange; // Annualized

  // Blend current YoY with trend
  const forecast = yoyChange * 0.6 + trend * 0.4;
  const uncertainty = 0.4; // CPI forecast uncertainty ±0.4%

  // Normal distribution probability
  const z = (threshold - forecast) / uncertainty;
  const prob = normalCDF(z);

  return isAbove ? (1 - prob) : prob;
}

/**
 * Estimate unemployment probability
 */
async function estimateUnemploymentProbability(threshold, isAbove = true) {
  const data = await fetchFREDSeries('UNRATE');
  if (!data || data.length < 3) {
    const month = new Date().getMonth();
    const seasonal = SEASONAL_UNEMPLOYMENT[month];
    if (isAbove) return threshold < seasonal ? 0.55 : 0.4;
    return threshold > seasonal ? 0.55 : 0.4;
  }

  const latest = data[0].value;
  const prev = data[1].value;
  const trend = latest + (latest - prev) * 0.5; // Simple momentum
  const uncertainty = 0.2;

  const z = (threshold - trend) / uncertainty;
  const prob = normalCDF(z);

  return isAbove ? (1 - prob) : prob;
}

/**
 * Estimate Fed rate decision probability
 */
function estimateFedRateProbability(text) {
  const lower = text.toLowerCase();

  // CME FedWatch-style estimation
  if (/rate\s*cut/i.test(text) || /lower.*rate/i.test(text) || /easing/i.test(text)) {
    // Rate cuts are priced based on current economic conditions
    // In a tightening cycle, cuts are less likely
    return { probability: 0.35, source: 'fed-base-rate' };
  }
  if (/rate\s*hike/i.test(text) || /raise.*rate/i.test(text) || /tightening/i.test(text)) {
    return { probability: 0.15, source: 'fed-base-rate' };
  }
  if (/hold|pause|unchanged|no\s*change/i.test(text)) {
    return { probability: 0.50, source: 'fed-base-rate' };
  }

  // Basis point specific
  const bpsMatch = text.match(/(\d+)\s*(?:basis\s*points|bps)/i);
  if (bpsMatch) {
    const bps = parseInt(bpsMatch[1]);
    if (bps === 25) return { probability: 0.40, source: 'fed-25bps' };
    if (bps === 50) return { probability: 0.15, source: 'fed-50bps' };
    if (bps === 75) return { probability: 0.05, source: 'fed-75bps' };
  }

  return null;
}

/**
 * Extract numeric threshold from market text
 */
function extractEconThreshold(text) {
  const patterns = [
    /(\d+\.?\d*)%/,             // "3.5%"
    /above\s+(\d+\.?\d*)/i,    // "above 3.5"
    /below\s+(\d+\.?\d*)/i,
    /exceed\s+(\d+\.?\d*)/i,
    /under\s+(\d+\.?\d*)/i,
    /over\s+(\d+\.?\d*)/i,
    /reach\s+(\d+\.?\d*)/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const val = parseFloat(m[1]);
      const isAbove = !/below|under|less|lower/i.test(text);
      return { threshold: val, isAbove };
    }
  }
  return null;
}

function normalCDF(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

const economicDataStrategy = {
  name: 'economic-data',
  type: 'macro',
  riskLevel: 'medium',

  async scan(bot) {
    const markets = await fetchMarketsOnce();
    if (!markets || markets.length === 0) return [];

    const econMarkets = markets.filter(m => {
      const text = (m.question || m.title || '').toLowerCase() + ' ' + (m.description || '').toLowerCase();
      return ECON_KEYWORDS.some(kw => text.includes(kw));
    });

    const opportunities = [];

    for (const market of econMarkets) {
      try {
        const text = market.question || market.title || '';
        const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
        if (yesPrice <= 0.02 || yesPrice >= 0.98) continue;

        let modelProbability = null;
        let source = 'unknown';
        const lower = text.toLowerCase();
        const extracted = extractEconThreshold(text);

        // CPI / Inflation markets
        if (/cpi|inflation|pce|price\s*index/i.test(lower) && extracted) {
          modelProbability = await estimateCPIProbability(extracted.threshold, extracted.isAbove);
          source = 'fred-cpi-trend';
        }
        // Unemployment markets
        else if (/unemployment|jobless|payroll/i.test(lower) && extracted) {
          modelProbability = await estimateUnemploymentProbability(extracted.threshold, extracted.isAbove);
          source = 'fred-unemployment-trend';
        }
        // Fed rate markets
        else if (/fed|fomc|rate\s*(cut|hike|hold|change)|basis\s*point/i.test(lower)) {
          const fedEstimate = estimateFedRateProbability(text);
          if (fedEstimate) {
            modelProbability = fedEstimate.probability;
            source = fedEstimate.source;
          }
        }
        // GDP markets
        else if (/gdp|recession|economic\s*growth/i.test(lower) && extracted) {
          // Simple GDP model: use consensus-like estimates
          const consensusGDP = 2.3; // Current consensus estimate (update periodically)
          const uncertainty = 0.8;
          const z = (extracted.threshold - consensusGDP) / uncertainty;
          modelProbability = extracted.isAbove ? (1 - normalCDF(z)) : normalCDF(z);
          source = 'gdp-consensus';
        }

        if (modelProbability === null) continue;
        modelProbability = Math.max(0.02, Math.min(0.98, modelProbability));

        const edge = modelProbability - yesPrice;
        const absEdge = Math.abs(edge);
        if (absEdge < 0.03) continue;

        const side = edge > 0 ? 'YES' : 'NO';
        const confidence = Math.min(absEdge * 7, 0.92);

        opportunities.push({
          type: 'economic-mispricing',
          market: text.slice(0, 120),
          conditionId: market.conditionId || market.id,
          tokenId: market.clobTokenIds?.[edge > 0 ? 0 : 1],
          side,
          currentPrice: edge > 0 ? yesPrice : (1 - yesPrice),
          modelPrice: edge > 0 ? modelProbability : (1 - modelProbability),
          edge: absEdge,
          edgePercent: (absEdge * 100).toFixed(1) + '%',
          expectedReturn: absEdge,
          confidence,
          source,
          liquidity: parseFloat(market.volume || market.liquidityClob || 0),
          maxPosition: Math.min(absEdge * 700, 200),
          executionSpeed: 0.5,
        });
      } catch {}
    }

    return opportunities;
  },

  async validate(opp) {
    return opp && opp.edge > 0.03 && opp.confidence > 0.2;
  },

  async execute(bot, opp) {
    return bot.execute(toBotOpportunity(opp), { size: opp.maxPosition });
  },
};

module.exports = [economicDataStrategy];
