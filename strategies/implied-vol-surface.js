/**
 * Implied Volatility Surface Strategy
 *
 * Constructs an implied volatility surface from prediction market prices
 * across related markets and time horizons, then identifies mispriced
 * contracts where vol is too cheap or too expensive relative to the surface.
 *
 * Approach:
 * - Groups correlated markets by underlying (e.g., "BTC price" at different strikes)
 * - Derives implied vol from binary option pricing (price → implied probability → vol)
 * - Fits a surface and finds outliers where observed vol deviates > 2 sigma
 * - Buys underpriced vol (cheap binary options on tail events)
 * - Sells overpriced vol (expensive options near consensus levels)
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');

// Binary option implied vol approximation
// For a binary paying $1: price p ≈ N(d2) where d2 depends on vol
// We invert to get implied vol from price
function impliedVolFromPrice(price, timeToExpiry) {
  if (price <= 0.01 || price >= 0.99 || timeToExpiry <= 0) return null;
  // Simplified: use the normal inverse to back out vol
  // For binary: vol ≈ |norminv(p)| * sqrt(T) (approximate)
  const z = Math.abs(normalInverse(price));
  if (z < 0.01) return null;
  return z / Math.sqrt(Math.max(timeToExpiry, 1 / 365));
}

// Rational approximation of inverse normal CDF
function normalInverse(p) {
  if (p <= 0 || p >= 1) return 0;
  if (p < 0.5) return -rationalApprox(Math.sqrt(-2 * Math.log(p)));
  return rationalApprox(Math.sqrt(-2 * Math.log(1 - p)));
}

function rationalApprox(t) {
  const c = [2.515517, 0.802853, 0.010328];
  const d = [1.432788, 0.189269, 0.001308];
  return t - (c[0] + c[1] * t + c[2] * t * t) / (1 + d[0] * t + d[1] * t * t + d[2] * t * t * t);
}

// Group markets by underlying topic
function groupByUnderlying(markets) {
  const groups = {};
  for (const m of markets) {
    const q = (m.question || '').toLowerCase();
    // Extract underlying topics
    let key = null;
    if (/\bbitcoin\b|\bbtc\b/.test(q)) key = 'btc';
    else if (/\bethereum\b|\beth\b/.test(q)) key = 'eth';
    else if (/\bsolana\b|\bsol\b/.test(q)) key = 'sol';
    else if (/\btrump\b/.test(q)) key = 'trump';
    else if (/\bfed\b|\binterest rate\b/.test(q)) key = 'fed';
    else if (/\binflation\b|\bcpi\b/.test(q)) key = 'inflation';
    else continue; // Skip ungroupable markets

    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  }
  return groups;
}

const impliedVolSurfaceStrategy = {
  name: 'implied-vol-surface',
  type: 'volatility',
  enabled: true,
  riskLevel: 'high',
  maxPosition: 75,
  description: 'Implied volatility surface mispricing across related binary markets',

  async scan() {
    const opportunities = [];

    try {
      const markets = await fetchMarketsOnce(0.01);
      if (!markets || markets.length === 0) return opportunities;

      const groups = groupByUnderlying(markets);

      for (const [underlying, groupMarkets] of Object.entries(groups)) {
        if (groupMarkets.length < 3) continue; // Need enough markets for a surface

        // Calculate implied vol for each market
        const volPoints = [];
        for (const m of groupMarkets) {
          const outcomes = m.outcomes || [];
          const yesPrice = outcomes[0]?.price || m.bestAsk || m.price;
          if (!yesPrice || yesPrice < 0.02 || yesPrice > 0.98) continue;

          const endDate = m.endDate ? new Date(m.endDate) : null;
          const timeToExpiry = endDate
            ? Math.max((endDate.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000), 1 / 365)
            : 30 / 365; // Default 30 day expiry

          const iv = impliedVolFromPrice(yesPrice, timeToExpiry);
          if (iv && iv > 0 && iv < 10) {
            volPoints.push({ market: m, price: yesPrice, timeToExpiry, iv });
          }
        }

        if (volPoints.length < 3) continue;

        // Fit simple surface: mean + stddev
        const meanVol = volPoints.reduce((s, p) => s + p.iv, 0) / volPoints.length;
        const variance = volPoints.reduce((s, p) => s + (p.iv - meanVol) ** 2, 0) / volPoints.length;
        const stdVol = Math.sqrt(variance);

        if (stdVol < 0.01) continue; // No meaningful dispersion

        // Find outliers
        for (const point of volPoints) {
          const zScore = (point.iv - meanVol) / stdVol;

          if (Math.abs(zScore) < 1.5) continue; // Not enough deviation

          const isUnderpriced = zScore < -1.5; // Vol too cheap → buy
          const edge = Math.abs(zScore) * stdVol * 0.02; // Rough edge estimate

          if (edge < 0.015) continue; // Below minimum edge

          const m = point.market;
          opportunities.push({
            strategy: 'implied-vol-surface',
            marketId: m.conditionId || m.id,
            question: m.question,
            side: isUnderpriced ? 'BUY_YES' : 'BUY_NO',
            price: point.price,
            edge: Math.min(edge, 0.08),
            size: Math.min(this.maxPosition, Math.round(edge * 1000)),
            confidence: Math.min(0.85, 0.5 + Math.abs(zScore) * 0.1),
            rationale: `${underlying.toUpperCase()} vol surface: IV=${point.iv.toFixed(2)} vs mean=${meanVol.toFixed(2)} (z=${zScore.toFixed(1)}σ). ${isUnderpriced ? 'Buying cheap vol' : 'Selling rich vol'}.`,
            underlying,
            impliedVol: point.iv,
            surfaceMean: meanVol,
            zScore,
          });
        }
      }

      // Sort by edge
      opportunities.sort((a, b) => b.edge - a.edge);
      return opportunities.slice(0, 5);
    } catch (err) {
      return opportunities;
    }
  },
};

module.exports = [impliedVolSurfaceStrategy];
