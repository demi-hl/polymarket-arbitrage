/**
 * Implied Volatility Surface Strategy
 *
 * Treats Polymarket crypto price markets as binary options and backs out
 * implied volatility from each market's price using Black-Scholes.
 *
 * Markets like "BTC > $90k by March" and "BTC > $100k by March" define
 * different strikes at the same expiry. Grouping by (asset, expiry) builds
 * a vol surface: strikes x expiries -> implied vol.
 *
 * Arbitrageable violations:
 *   1. Vol smile inversion: lower strikes should NOT have materially lower
 *      implied vol than higher strikes (for OTM calls). A steep inversion
 *      means the probability curve is internally inconsistent.
 *   2. Calendar spread: annualized vol for longer expiries should be roughly
 *      similar or slightly lower than shorter expiries (term structure).
 *      Large deviations mean the market is mispricing time value.
 *   3. Monotonicity: for same-expiry above-strike markets, lower strikes
 *      must have higher (or equal) probability. If not, free money.
 *
 * Risk: medium — requires both legs to converge; illiquid legs can trap.
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');

// --- Constants ---
const MIN_LIQUIDITY_PER_LEG = 5000;
const MIN_MARKETS_PER_GROUP = 2;
const MIN_EDGE_PERCENT = 0.02; // 2% minimum edge to surface an opportunity
const RISK_FREE_RATE = 0.05; // 5% annualized (T-bill proxy)

// Reuse patterns from crypto-latency-arb for asset/strike/direction parsing
const ASSET_PATTERNS = {
  BTC: /\b(?:bitcoin|btc)\b/i,
  ETH: /\b(?:ethereum|eth)\b/i,
  SOL: /\b(?:solana|sol)\b/i,
};

const STRIKE_PATTERN = /\$\s*([\d,]+(?:\.\d+)?)/;
const DIRECTION_PATTERN = /\b(above|below|over|under|exceed|reach|hit|dip|higher|lower)\b/i;

// Approximate spot prices — updated each scan cycle via external data or market midpoints
let spotPrices = {
  BTC: 85000,
  ETH: 3500,
  SOL: 130,
};

// --- Black-Scholes math ---

/**
 * Standard normal CDF using Abramowitz & Stegun approximation.
 * Max error ~7.5e-8.
 */
function normCdf(x) {
  if (x > 8) return 1;
  if (x < -8) return 0;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);

  return 0.5 * (1.0 + sign * y);
}

/**
 * Standard normal PDF.
 */
function normPdf(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Black-Scholes d1 for a digital/binary call option.
 * P(S_T > K) = N(d2) where d2 = (ln(S/K) + (r - 0.5*sigma^2)*T) / (sigma*sqrt(T))
 * But Polymarket pays $1 if above strike, so the market price ~= N(d2).
 *
 * For the Newton-Raphson solver we use:
 *   d2 = (ln(S/K) + (r - 0.5*sigma^2)*T) / (sigma*sqrt(T))
 *   price = N(d2)
 */
function bsDigitalCallPrice(spot, strike, T, sigma, r = RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0) return spot >= strike ? 1 : 0;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(spot / strike) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  return normCdf(d2);
}

/**
 * Derivative of digital call price w.r.t. sigma (vega for digital).
 * d(N(d2))/d(sigma) = n(d2) * dd2/dsigma
 * dd2/dsigma = -(ln(S/K) + (r + 0.5*sigma^2)*T) / (sigma^2 * sqrt(T))
 */
function bsDigitalCallVega(spot, strike, T, sigma, r = RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0) return 0;
  const sqrtT = Math.sqrt(T);
  const d2 = (Math.log(spot / strike) + (r - 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
  // dd2/dsigma = -( ln(S/K)/(sigma^2 * sqrtT) + sqrtT/2 + r*T/(sigma*sqrtT) ) ...
  // Simpler: directly differentiate d2 w.r.t sigma
  // d2 = ln(S/K)/(sigma*sqrtT) + r*T/(sigma*sqrtT) - 0.5*sigma*sqrtT
  // dd2/dsigma = -ln(S/K)/(sigma^2 * sqrtT) - r*T/(sigma^2*sqrtT) - 0.5*sqrtT
  const logMoneyness = Math.log(spot / strike);
  const dd2dSigma = -(logMoneyness + r * T) / (sigma * sigma * sqrtT) - 0.5 * sqrtT;
  return normPdf(d2) * dd2dSigma;
}

/**
 * Implied volatility via Newton-Raphson.
 *
 * @param {number} marketPrice - Market probability (0-1)
 * @param {number} spot - Current spot price of the asset
 * @param {number} strike - Strike price
 * @param {number} T - Time to expiry in years
 * @param {string} direction - 'above' or 'below'
 * @returns {number|null} Implied vol, or null if no convergence
 */
function impliedVol(marketPrice, spot, strike, T, direction = 'above') {
  // For "below" markets, P(below K) = 1 - P(above K), so invert
  const targetPrice = direction === 'below' ? 1 - marketPrice : marketPrice;

  // Bounds check: if price is too extreme, IV is not meaningful
  if (targetPrice <= 0.01 || targetPrice >= 0.99) return null;
  if (T <= 0) return null;

  // Initial guess from inverse normal
  let sigma = 0.8; // reasonable starting point for crypto

  const MAX_ITER = 50;
  const TOL = 1e-6;

  for (let i = 0; i < MAX_ITER; i++) {
    const price = bsDigitalCallPrice(spot, strike, T, sigma);
    const diff = price - targetPrice;

    if (Math.abs(diff) < TOL) return sigma;

    const vega = bsDigitalCallVega(spot, strike, T, sigma);
    if (Math.abs(vega) < 1e-12) {
      // Vega too small — try bisection step instead
      sigma *= diff > 0 ? 1.1 : 0.9;
      continue;
    }

    const step = diff / vega;
    sigma -= step;

    // Clamp to reasonable range
    if (sigma < 0.01) sigma = 0.01;
    if (sigma > 5.0) sigma = 5.0;
  }

  // Didn't converge — return best guess if close enough
  const finalPrice = bsDigitalCallPrice(spot, strike, T, sigma);
  if (Math.abs(finalPrice - targetPrice) < 0.02) return sigma;

  return null;
}

// --- Market parsing ---

/**
 * Identify the asset from a market question.
 */
function identifyAsset(question) {
  for (const [asset, pattern] of Object.entries(ASSET_PATTERNS)) {
    if (pattern.test(question)) return asset;
  }
  return null;
}

/**
 * Parse a crypto price market into structured contract data.
 * Returns null if the market is not a crypto price market.
 */
function parseCryptoMarket(market) {
  const q = market.question || '';
  const asset = identifyAsset(q);
  if (!asset) return null;

  const strikeMatch = q.match(STRIKE_PATTERN);
  if (!strikeMatch) return null;
  const strike = parseFloat(strikeMatch[1].replace(/,/g, ''));
  if (strike < 10) return null;

  const dirMatch = q.match(DIRECTION_PATTERN);
  const direction = dirMatch && /below|under|dip|lower/i.test(dirMatch[1]) ? 'below' : 'above';

  const endDate = market.endDate ? new Date(market.endDate) : null;
  if (!endDate || endDate.getTime() <= Date.now()) return null;

  const T = (endDate.getTime() - Date.now()) / (365.25 * 24 * 60 * 60 * 1000); // in years
  if (T <= 0) return null;

  // Parse yes price
  let yesPrice = 0.5;
  try {
    const prices = typeof market.outcomePrices === 'string'
      ? JSON.parse(market.outcomePrices) : market.outcomePrices;
    if (prices && prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
  } catch {}

  const liquidity = market.liquidity || 0;
  const clobTokenIds = market.clobTokenIds || [];

  return {
    marketId: market.id || market.conditionId,
    question: q,
    slug: market.slug || '',
    category: market.category || '',
    eventTitle: market.eventTitle || '',
    conditionId: market.conditionId,
    asset,
    strike,
    direction,
    endDate,
    T,
    yesPrice,
    noPrice: 1 - yesPrice,
    liquidity,
    clobTokenIds,
    volume: market.volume || 0,
  };
}

/**
 * Estimate spot prices from the market data itself.
 * Uses the market whose yes price is closest to 0.50 (ATM proxy) to infer spot.
 */
function estimateSpotPrices(contracts) {
  const byAsset = {};
  for (const c of contracts) {
    if (!byAsset[c.asset]) byAsset[c.asset] = [];
    byAsset[c.asset].push(c);
  }

  for (const [asset, mkts] of Object.entries(byAsset)) {
    // Find the "above" market closest to 50% probability — its strike ~= spot
    const aboveMarkets = mkts.filter(m => m.direction === 'above');
    if (aboveMarkets.length === 0) continue;

    let bestDist = Infinity;
    let bestStrike = spotPrices[asset];
    for (const m of aboveMarkets) {
      const dist = Math.abs(m.yesPrice - 0.50);
      if (dist < bestDist) {
        bestDist = dist;
        bestStrike = m.strike;
      }
    }

    if (bestDist < 0.20) {
      spotPrices[asset] = bestStrike;
    }
  }
}

// --- Vol surface construction and violation detection ---

/**
 * Group contracts by (asset, expiryDate) for surface construction.
 * Returns Map<string, contract[]> keyed by "ASSET-YYYY-MM-DD".
 */
function groupByAssetExpiry(contracts) {
  const groups = new Map();
  for (const c of contracts) {
    const dateKey = c.endDate.toISOString().split('T')[0];
    const key = `${c.asset}-${dateKey}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  return groups;
}

/**
 * Compute implied vol for each contract and check for violations.
 * Returns array of opportunity objects.
 */
function detectViolations(contracts) {
  const opportunities = [];

  // Group by asset+expiry
  const groups = groupByAssetExpiry(contracts);

  for (const [groupKey, groupContracts] of groups) {
    if (groupContracts.length < MIN_MARKETS_PER_GROUP) continue;

    const asset = groupContracts[0].asset;
    const spot = spotPrices[asset] || 85000;

    // Compute implied vol for each contract
    const withIV = [];
    for (const c of groupContracts) {
      const iv = impliedVol(c.yesPrice, spot, c.strike, c.T, c.direction);
      if (iv !== null && iv > 0) {
        withIV.push({ ...c, iv });
      }
    }

    if (withIV.length < MIN_MARKETS_PER_GROUP) continue;

    // Sort by strike for monotonicity/smile checks
    const aboveContracts = withIV.filter(c => c.direction === 'above').sort((a, b) => a.strike - b.strike);

    // --- Check 1: Monotonicity violation ---
    // For "above" markets at the same expiry, P(above K1) >= P(above K2) when K1 < K2.
    // If violated, direct arb: buy the lower-strike YES and sell the higher-strike YES.
    for (let i = 0; i < aboveContracts.length - 1; i++) {
      const lower = aboveContracts[i];
      const higher = aboveContracts[i + 1];

      if (lower.yesPrice < higher.yesPrice) {
        const edge = higher.yesPrice - lower.yesPrice;
        if (edge >= MIN_EDGE_PERCENT) {
          opportunities.push(buildOpportunity({
            type: 'monotonicity',
            description: `${asset} monotonicity violation: $${lower.strike} YES at ${(lower.yesPrice * 100).toFixed(1)}% < $${higher.strike} YES at ${(higher.yesPrice * 100).toFixed(1)}%`,
            asset,
            legA: lower,
            legB: higher,
            edge,
            confidence: 0.90, // This is a hard arbitrage
          }));
        }
      }
    }

    // --- Check 2: Vol smile inversion ---
    // Far OTM calls (high strikes) should have equal or higher IV than ATM.
    // A material inversion signals mispricing.
    if (aboveContracts.length >= 3) {
      for (let i = 0; i < aboveContracts.length - 1; i++) {
        const closer = aboveContracts[i];
        const farther = aboveContracts[i + 1];

        // Both OTM (strike > spot)? Then farther strike should have >= IV
        if (closer.strike > spot && farther.strike > closer.strike) {
          const ivDiff = closer.iv - farther.iv;
          if (ivDiff > 0.10) {
            // Material inversion: closer-to-ATM has higher vol than further OTM
            // This implies the farther OTM is relatively cheap
            const edge = estimateEdgeFromIVDiff(ivDiff, closer, farther, spot);
            if (edge >= MIN_EDGE_PERCENT) {
              opportunities.push(buildOpportunity({
                type: 'vol-smile-inversion',
                description: `${asset} vol smile inversion: $${closer.strike} IV=${(closer.iv * 100).toFixed(1)}% > $${farther.strike} IV=${(farther.iv * 100).toFixed(1)}%`,
                asset,
                legA: closer,
                legB: farther,
                edge,
                confidence: 0.65,
                ivDiff,
              }));
            }
          }
        }
      }
    }
  }

  // --- Check 3: Calendar spread (cross-expiry for same asset+strike) ---
  const byAssetStrike = new Map();
  for (const c of contracts) {
    const iv = impliedVol(c.yesPrice, spotPrices[c.asset] || 85000, c.strike, c.T, c.direction);
    if (iv === null) continue;

    const key = `${c.asset}-${c.strike}-${c.direction}`;
    if (!byAssetStrike.has(key)) byAssetStrike.set(key, []);
    byAssetStrike.get(key).push({ ...c, iv });
  }

  for (const [, strikeContracts] of byAssetStrike) {
    if (strikeContracts.length < 2) continue;

    // Sort by expiry
    strikeContracts.sort((a, b) => a.T - b.T);

    for (let i = 0; i < strikeContracts.length - 1; i++) {
      const shorter = strikeContracts[i];
      const longer = strikeContracts[i + 1];

      // Annualized vol for longer expiry is much higher => the longer-dated option is overpriced
      const ivRatio = longer.iv / shorter.iv;
      if (ivRatio > 1.5 || ivRatio < 0.5) {
        const edge = Math.abs(longer.iv - shorter.iv) * 0.1; // rough edge estimate
        if (edge >= MIN_EDGE_PERCENT) {
          const overpriced = ivRatio > 1.5 ? longer : shorter;
          const underpriced = ivRatio > 1.5 ? shorter : longer;

          opportunities.push(buildOpportunity({
            type: 'calendar-spread',
            description: `${shorter.asset} calendar spread: $${shorter.strike} short-expiry IV=${(shorter.iv * 100).toFixed(1)}% vs long-expiry IV=${(longer.iv * 100).toFixed(1)}%`,
            asset: shorter.asset,
            legA: underpriced,
            legB: overpriced,
            edge,
            confidence: 0.55,
          }));
        }
      }
    }
  }

  return opportunities;
}

/**
 * Estimate the $ edge from an implied vol difference.
 * Uses the idea that if we can buy the underpriced leg and sell the overpriced leg,
 * the convergence of IV to a "fair" average yields our profit.
 */
function estimateEdgeFromIVDiff(ivDiff, legA, legB, spot) {
  const avgT = (legA.T + legB.T) / 2;
  const fairIV = (legA.iv + legB.iv) / 2;

  const fairPriceA = bsDigitalCallPrice(spot, legA.strike, legA.T, fairIV);
  const fairPriceB = bsDigitalCallPrice(spot, legB.strike, legB.T, fairIV);

  const edgeA = Math.abs(fairPriceA - legA.yesPrice);
  const edgeB = Math.abs(fairPriceB - legB.yesPrice);

  return (edgeA + edgeB) / 2;
}

/**
 * Build a standardized opportunity object matching bot.js expectations.
 */
function buildOpportunity({ type, description, asset, legA, legB, edge, confidence, ivDiff }) {
  const minLiquidity = Math.min(legA.liquidity, legB.liquidity);
  const maxPosition = Math.min(minLiquidity * 0.02, 500);

  return {
    marketId: legA.marketId,
    question: description,
    slug: legA.slug,
    category: 'crypto',
    eventTitle: `IV Surface: ${asset} ${type}`,
    yesPrice: legA.yesPrice,
    noPrice: legA.noPrice,
    sum: legA.yesPrice + legA.noPrice,
    edge,
    edgePercent: edge,
    executableEdge: edge * 0.8, // discount for execution friction
    liquidity: minLiquidity,
    volume: legA.volume + legB.volume,
    conditionId: legA.conditionId,
    endDate: legA.endDate ? legA.endDate.toISOString() : null,
    direction: 'BUY_YES', // simplified — in practice each violation has a specific trade direction
    maxPosition,
    expectedReturn: edge,
    confidence,
    executionSpeed: 0.5,
    holdUntilResolution: false,
    clobTokenIds: legA.clobTokenIds || [],

    // Strategy-specific metadata
    volSurface: {
      type,
      asset,
      legA: {
        marketId: legA.marketId,
        question: legA.question,
        strike: legA.strike,
        direction: legA.direction,
        yesPrice: legA.yesPrice,
        iv: legA.iv,
        liquidity: legA.liquidity,
        T: legA.T,
      },
      legB: {
        marketId: legB.marketId,
        question: legB.question,
        strike: legB.strike,
        direction: legB.direction,
        yesPrice: legB.yesPrice,
        iv: legB.iv,
        liquidity: legB.liquidity,
        T: legB.T,
      },
      ivDiff: ivDiff || Math.abs((legA.iv || 0) - (legB.iv || 0)),
      spotUsed: spotPrices[asset],
    },
  };
}

// --- Strategy implementation ---

const impliedVolSurface = {
  name: 'implied-vol-surface',
  type: 'statistical',
  riskLevel: 'medium',
  description: 'Detects inconsistencies in implied volatility surface across crypto strike/expiry markets',

  async scan(bot) {
    try {
      const markets = await fetchMarketsOnce({ sectors: ['crypto'] });

      // Parse all crypto price markets into structured contracts
      const contracts = [];
      for (const market of markets) {
        const parsed = parseCryptoMarket(market);
        if (!parsed) continue;
        if (parsed.liquidity < MIN_LIQUIDITY_PER_LEG) continue;
        contracts.push(parsed);
      }

      if (contracts.length < MIN_MARKETS_PER_GROUP) {
        return [];
      }

      // Estimate spot prices from ATM markets
      estimateSpotPrices(contracts);

      // Detect vol surface violations
      const opportunities = detectViolations(contracts);

      if (opportunities.length > 0) {
        console.log(`  [implied-vol-surface] ${contracts.length} crypto contracts, ${opportunities.length} violations found (spot: BTC=$${spotPrices.BTC} ETH=$${spotPrices.ETH} SOL=$${spotPrices.SOL})`);
      }

      return opportunities
        .sort((a, b) => (b.edgePercent || 0) - (a.edgePercent || 0))
        .slice(0, 10);
    } catch (err) {
      console.error('[implied-vol-surface]', err.message);
      return [];
    }
  },

  async validate(opp) {
    if (!opp) return false;
    if (!opp.volSurface) return false;

    const { legA, legB } = opp.volSurface;

    // Both legs must have sufficient liquidity
    if (legA.liquidity < MIN_LIQUIDITY_PER_LEG) return false;
    if (legB.liquidity < MIN_LIQUIDITY_PER_LEG) return false;

    // Edge must still be above threshold
    if (opp.edgePercent < MIN_EDGE_PERCENT) return false;

    // Implied vols must be valid
    if (!legA.iv || legA.iv <= 0 || !legB.iv || legB.iv <= 0) return false;

    // Time to expiry must be positive (markets not expired)
    if (legA.T <= 0 || legB.T <= 0) return false;

    return true;
  },

  async execute(bot, opp) {
    const { type, asset, legA, legB, ivDiff } = opp.volSurface;
    const size = opp.maxPosition;

    console.log(
      `[implied-vol-surface] Executing: type=${type} asset=${asset} ` +
      `legA=$${legA.strike}(IV=${(legA.iv * 100).toFixed(1)}%) ` +
      `legB=$${legB.strike}(IV=${(legB.iv * 100).toFixed(1)}%) ` +
      `ivDiff=${(ivDiff * 100).toFixed(1)}% edge=${(opp.edgePercent * 100).toFixed(2)}% ` +
      `size=$${size.toFixed(0)}`
    );

    return bot.execute(opp, { size });
  },
};

module.exports = [impliedVolSurface];

// Export internals for testing
module.exports._internals = {
  normCdf,
  normPdf,
  bsDigitalCallPrice,
  bsDigitalCallVega,
  impliedVol,
  parseCryptoMarket,
  identifyAsset,
  estimateSpotPrices,
  detectViolations,
  groupByAssetExpiry,
};
