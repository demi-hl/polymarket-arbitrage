/**
 * Weather Prediction Market Strategy
 *
 * Targets weather-related prediction markets (temperature records, hurricanes,
 * rainfall, snowfall, heat waves, etc.) and compares market pricing against
 * actual meteorological forecast data from NOAA/NWS and OpenWeatherMap.
 *
 * Edge sources:
 * - Weather models update faster than markets reprice
 * - Ensemble forecast confidence vs market-implied probability
 * - Historical base rates for seasonal weather events
 * - GFS/ECMWF model divergence signals uncertainty mispricing
 */

const axios = require('axios');
const { getOpportunities, toBotOpportunity, fetchMarketsOnce } = require('./lib/with-scanner');

// Weather keywords for market filtering
const WEATHER_KEYWORDS = [
  'temperature', 'weather', 'hurricane', 'storm', 'tornado',
  'rainfall', 'snow', 'snowfall', 'heat wave', 'heatwave',
  'cold snap', 'freeze', 'frost', 'drought', 'flood',
  'celsius', 'fahrenheit', 'degrees', 'hottest', 'coldest',
  'warmest', 'record high', 'record low', 'el nino', 'la nina',
  'monsoon', 'cyclone', 'typhoon', 'blizzard', 'ice storm',
  'wind speed', 'category', 'landfall', 'tropical storm',
  'polar vortex', 'wind chill', 'heat index', 'precipitation',
  'above average', 'below average', 'climate', 'noaa',
];

// NWS/NOAA public API (free, no key needed)
const NWS_API = 'https://api.weather.gov';
// OpenWeatherMap (free tier)
const OWM_API = 'https://api.openweathermap.org/data/2.5';
const OWM_KEY = process.env.OPENWEATHERMAP_API_KEY || '';

// Major cities for weather market correlation
const CITY_COORDS = {
  'new york':   { lat: 40.7128, lon: -74.0060 },
  'nyc':        { lat: 40.7128, lon: -74.0060 },
  'los angeles':{ lat: 34.0522, lon: -118.2437 },
  'la':         { lat: 34.0522, lon: -118.2437 },
  'chicago':    { lat: 41.8781, lon: -87.6298 },
  'miami':      { lat: 25.7617, lon: -80.1918 },
  'houston':    { lat: 29.7604, lon: -95.3698 },
  'phoenix':    { lat: 33.4484, lon: -112.0740 },
  'seattle':    { lat: 47.6062, lon: -122.3321 },
  'denver':     { lat: 39.7392, lon: -104.9903 },
  'dallas':     { lat: 32.7767, lon: -96.7970 },
  'atlanta':    { lat: 33.7490, lon: -84.3880 },
  'boston':      { lat: 42.3601, lon: -71.0589 },
  'dc':         { lat: 38.9072, lon: -77.0369 },
  'washington': { lat: 38.9072, lon: -77.0369 },
  'london':     { lat: 51.5074, lon: -0.1278 },
  'tokyo':      { lat: 35.6762, lon: 139.6503 },
};

// Historical temperature base rates (monthly averages for key cities, °F)
const HISTORICAL_TEMPS = {
  'new york':   [33, 35, 43, 54, 64, 73, 79, 77, 70, 58, 48, 38],
  'los angeles':[58, 59, 60, 63, 66, 70, 74, 75, 74, 68, 62, 57],
  'chicago':    [26, 30, 40, 52, 63, 73, 78, 76, 68, 56, 43, 31],
  'miami':      [68, 69, 72, 76, 80, 83, 84, 84, 83, 80, 75, 70],
  'phoenix':    [55, 59, 64, 72, 82, 92, 97, 95, 90, 78, 64, 54],
};

let _forecastCache = {};
const FORECAST_TTL = 300_000; // 5 min cache

/**
 * Fetch NWS forecast for a location (free, no API key)
 */
async function fetchNWSForecast(lat, lon) {
  const cacheKey = `nws_${lat}_${lon}`;
  const cached = _forecastCache[cacheKey];
  if (cached && Date.now() - cached.ts < FORECAST_TTL) return cached.data;

  try {
    // Step 1: Get the forecast grid endpoint
    const pointRes = await axios.get(`${NWS_API}/points/${lat},${lon}`, {
      headers: { 'User-Agent': 'DEMI-Trading-Bot/1.0' },
      timeout: 8000,
    });
    const forecastUrl = pointRes.data?.properties?.forecast;
    if (!forecastUrl) return null;

    // Step 2: Get the actual forecast
    const fcRes = await axios.get(forecastUrl, {
      headers: { 'User-Agent': 'DEMI-Trading-Bot/1.0' },
      timeout: 8000,
    });
    const periods = fcRes.data?.properties?.periods || [];
    const data = {
      periods: periods.map(p => ({
        name: p.name,
        temp: p.temperature,
        unit: p.temperatureUnit,
        wind: p.windSpeed,
        short: p.shortForecast,
        detailed: p.detailedForecast,
        isDaytime: p.isDaytime,
        startTime: p.startTime,
      })),
      fetchedAt: Date.now(),
    };
    _forecastCache[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch (err) {
    return null;
  }
}

/**
 * Fetch OpenWeatherMap forecast (if API key available)
 */
async function fetchOWMForecast(lat, lon) {
  if (!OWM_KEY) return null;
  const cacheKey = `owm_${lat}_${lon}`;
  const cached = _forecastCache[cacheKey];
  if (cached && Date.now() - cached.ts < FORECAST_TTL) return cached.data;

  try {
    const res = await axios.get(`${OWM_API}/forecast`, {
      params: { lat, lon, appid: OWM_KEY, units: 'imperial', cnt: 40 },
      timeout: 8000,
    });
    const data = {
      forecasts: (res.data?.list || []).map(f => ({
        dt: f.dt,
        temp: f.main?.temp,
        tempMin: f.main?.temp_min,
        tempMax: f.main?.temp_max,
        humidity: f.main?.humidity,
        weather: f.weather?.[0]?.main,
        description: f.weather?.[0]?.description,
        wind: f.wind?.speed,
        rain: f.rain?.['3h'] || 0,
        snow: f.snow?.['3h'] || 0,
      })),
      fetchedAt: Date.now(),
    };
    _forecastCache[cacheKey] = { data, ts: Date.now() };
    return data;
  } catch (err) {
    return null;
  }
}

/**
 * Detect city from market question text
 */
function detectCity(text) {
  const lower = text.toLowerCase();
  for (const [city, coords] of Object.entries(CITY_COORDS)) {
    if (lower.includes(city)) return { city, ...coords };
  }
  return null;
}

/**
 * Extract temperature threshold from market question
 * e.g., "Will NYC temperature exceed 100°F?" → 100
 */
function extractTempThreshold(text) {
  const patterns = [
    /(\d+)\s*°?\s*[fF]/,                // "100°F" or "100 F"
    /(\d+)\s*degrees?\s*[fF]/i,         // "100 degrees F"
    /above\s+(\d+)/i,                    // "above 100"
    /exceed\s+(\d+)/i,                   // "exceed 100"
    /over\s+(\d+)/i,                     // "over 100"
    /reach\s+(\d+)/i,                    // "reach 100"
    /hit\s+(\d+)/i,                      // "hit 100"
    /below\s+(\d+)/i,                    // "below 32" (inverted)
    /under\s+(\d+)/i,                    // "under 0"
    /(\d+)\s*°?\s*[cC]/,                // Celsius
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      let temp = parseFloat(match[1]);
      // Convert Celsius to Fahrenheit if needed
      if (/[cC]/.test(match[0]) && !(/°?\s*[fF]/.test(match[0]))) {
        temp = temp * 9/5 + 32;
      }
      const isBelow = /below|under|colder|less than/i.test(text);
      return { threshold: temp, isBelow };
    }
  }
  return null;
}

/**
 * Estimate probability of temperature exceeding threshold
 * based on forecast data and historical base rates
 */
function estimateTempProbability(forecast, threshold, isBelow, city) {
  if (!forecast?.periods?.length) return null;

  // Get forecast temps
  const forecastTemps = forecast.periods
    .filter(p => p.isDaytime)
    .map(p => p.temp)
    .slice(0, 7); // Next 7 days

  if (forecastTemps.length === 0) return null;

  const maxForecast = Math.max(...forecastTemps);
  const minForecast = Math.min(...forecastTemps);
  const avgForecast = forecastTemps.reduce((a, b) => a + b, 0) / forecastTemps.length;

  // Forecast uncertainty band (NWS typically ±3-5°F for day 1-3, ±5-8°F for day 4-7)
  const uncertainty = 5; // Conservative uncertainty

  let probability;
  if (isBelow) {
    // P(temp < threshold)
    const zScore = (threshold - minForecast) / uncertainty;
    probability = normalCDF(zScore);
  } else {
    // P(temp > threshold)
    const zScore = (threshold - maxForecast) / uncertainty;
    probability = 1 - normalCDF(zScore);
  }

  // Adjust with historical base rate if available
  const cityKey = city?.toLowerCase();
  if (HISTORICAL_TEMPS[cityKey]) {
    const month = new Date().getMonth();
    const historicalAvg = HISTORICAL_TEMPS[cityKey][month];
    const historicalStdDev = 12; // Typical monthly temp std dev

    let historicalProb;
    if (isBelow) {
      historicalProb = normalCDF((threshold - historicalAvg) / historicalStdDev);
    } else {
      historicalProb = 1 - normalCDF((threshold - historicalAvg) / historicalStdDev);
    }

    // Blend: 70% forecast, 30% historical
    probability = probability * 0.7 + historicalProb * 0.3;
  }

  return Math.max(0.01, Math.min(0.99, probability));
}

/**
 * Standard normal CDF approximation
 */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

/**
 * Check for hurricane/storm-related markets
 */
function isHurricaneMarket(text) {
  const keywords = ['hurricane', 'tropical storm', 'cyclone', 'typhoon', 'category', 'landfall'];
  return keywords.some(kw => text.toLowerCase().includes(kw));
}

/**
 * Estimate hurricane probability from NOAA seasonal outlook
 */
function estimateHurricaneProbability(text) {
  // Base rates from NOAA historical data
  const month = new Date().getMonth();
  const inSeason = month >= 5 && month <= 10; // June-November

  if (/category\s*[45]/i.test(text)) return inSeason ? 0.15 : 0.02;
  if (/category\s*[3]/i.test(text)) return inSeason ? 0.30 : 0.05;
  if (/major\s+hurricane/i.test(text)) return inSeason ? 0.35 : 0.05;
  if (/landfall/i.test(text)) return inSeason ? 0.40 : 0.08;
  if (/tropical\s+storm/i.test(text)) return inSeason ? 0.65 : 0.15;

  return null;
}

// ─── Strategy Definition ───

const weatherStrategy = {
  name: 'weather-forecast',
  type: 'weather',
  riskLevel: 'medium',

  async scan(bot) {
    const markets = await fetchMarketsOnce();
    if (!markets || markets.length === 0) return [];

    // Filter for weather-related markets
    const weatherMarkets = markets.filter(m => {
      const text = (m.question || m.title || '').toLowerCase() + ' ' + (m.description || '').toLowerCase();
      return WEATHER_KEYWORDS.some(kw => text.includes(kw));
    });

    if (weatherMarkets.length === 0) return [];

    const opportunities = [];

    for (const market of weatherMarkets) {
      try {
        const text = market.question || market.title || '';
        const yesPrice = parseFloat(market.outcomePrices?.[0] || market.bestBid || 0.5);
        const noPrice = parseFloat(market.outcomePrices?.[1] || (1 - yesPrice));

        if (yesPrice <= 0.01 || yesPrice >= 0.99) continue; // Skip settled markets

        let modelProbability = null;
        let source = 'unknown';

        // Temperature markets
        const city = detectCity(text);
        const tempThreshold = extractTempThreshold(text);

        if (city && tempThreshold) {
          const forecast = await fetchNWSForecast(city.lat, city.lon);
          if (forecast) {
            modelProbability = estimateTempProbability(
              forecast, tempThreshold.threshold, tempThreshold.isBelow, city.city
            );
            source = 'nws-forecast';
          }
        }

        // Hurricane markets
        if (!modelProbability && isHurricaneMarket(text)) {
          modelProbability = estimateHurricaneProbability(text);
          source = 'noaa-base-rate';
        }

        if (modelProbability === null) continue;

        // Calculate edge
        const edge = modelProbability - yesPrice;
        const absEdge = Math.abs(edge);

        // Only surface opportunities with meaningful edge (>3%)
        if (absEdge < 0.03) continue;

        const side = edge > 0 ? 'YES' : 'NO';
        const confidence = Math.min(absEdge * 8, 0.95); // Higher edge → higher confidence

        opportunities.push({
          type: 'weather-mispricing',
          market: text.slice(0, 120),
          conditionId: market.conditionId || market.id,
          tokenId: market.clobTokenIds?.[edge > 0 ? 0 : 1],
          side,
          currentPrice: edge > 0 ? yesPrice : noPrice,
          modelPrice: edge > 0 ? modelProbability : (1 - modelProbability),
          edge: absEdge,
          edgePercent: (absEdge * 100).toFixed(1) + '%',
          expectedReturn: absEdge,
          confidence,
          source,
          liquidity: parseFloat(market.volume || market.liquidityClob || 0),
          maxPosition: Math.min(absEdge * 500, 100), // Scale with edge, cap $100
          executionSpeed: 0.6,
        });
      } catch (err) {
        continue;
      }
    }

    return opportunities;
  },

  async validate(opportunity) {
    return opportunity &&
      typeof opportunity.edge === 'number' &&
      opportunity.edge > 0.03 &&
      opportunity.confidence > 0.2;
  },

  async execute(bot, opportunity) {
    const opp = toBotOpportunity(opportunity);
    return bot.execute(opp, { size: opp.maxPosition || opportunity.maxPosition });
  },
};

module.exports = [weatherStrategy];
