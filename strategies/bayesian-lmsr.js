/**
 * Bayesian LMSR Inefficiency Strategy
 *
 * Combines two quantitative approaches for prediction market alpha:
 *
 * 1. LMSR Softmax Pricing — The Logarithmic Market Scoring Rule prices
 *    outcomes using a softmax function: p_i(q) = e^(q_i/b) / Σ e^(q_j/b).
 *    When CLOB orderbook mid-price diverges from the LMSR-implied price,
 *    the gap is a quantifiable inefficiency signal.
 *
 * 2. Sequential Bayesian Updating — Maintains a running log-space posterior
 *    for each market, updating on new data (price ticks, volume spikes,
 *    whale flow, news sentiment). The posterior IS the model probability p̂.
 *
 * Entry: EV = p̂ − p > threshold (model probability vs market price)
 * Sizing: Fractional Kelly with duration guard (never full Kelly on <5min)
 * Exit: EV collapses below exit threshold, or stop-loss/take-profit hit
 *
 * Risk: medium — Bayesian estimates can lag sudden regime shifts.
 *       Duration guard prevents blowups on short-horizon markets.
 */
const { fetchMarketsOnce } = require('./lib/with-scanner');
const gpu = require('../lib/gpu-singleton');

// ── LMSR Math ──────────────────────────────────────────────────────────

/**
 * LMSR cost function: C(q) = b * ln(Σ e^(q_i / b))
 * For binary markets (n=2): C(q1, q2) = b * ln(e^(q1/b) + e^(q2/b))
 */
function lmsrCost(quantities, b) {
  // Numerically stable log-sum-exp
  const maxQ = Math.max(...quantities.map(q => q / b));
  const sumExp = quantities.reduce((s, q) => s + Math.exp(q / b - maxQ), 0);
  return b * (maxQ + Math.log(sumExp));
}

/**
 * LMSR price function (softmax): p_i = e^(q_i/b) / Σ e^(q_j/b)
 * This IS the softmax function — identical to neural network classifiers.
 */
function lmsrPrice(quantities, b) {
  const maxQ = Math.max(...quantities.map(q => q / b));
  const exps = quantities.map(q => Math.exp(q / b - maxQ));
  const sumExp = exps.reduce((s, e) => s + e, 0);
  return exps.map(e => e / sumExp);
}

/**
 * Infer LMSR quantities from observed prices and liquidity parameter b.
 * Given p_i = softmax(q_i/b), we can recover q_i = b * ln(p_i) + constant.
 * We set q_1 = 0 as anchor (the constant cancels in softmax).
 */
function inferQuantities(prices, b) {
  const anchor = Math.log(Math.max(prices[0], 1e-8));
  return prices.map(p => b * (Math.log(Math.max(p, 1e-8)) - anchor));
}

/**
 * Estimate LMSR liquidity parameter b from market volume and spread.
 * Higher volume → higher b → tighter spreads.
 * b = volume / (ln(n) * scale_factor)
 * For binary: b ≈ volume / 0.693
 */
function estimateB(volume, numOutcomes = 2) {
  const minB = 1000;  // $1k floor — very thin market
  const maxB = 500000; // $500k cap
  const scaleFactor = 10; // empirical tuning
  const b = (volume || 10000) / (Math.log(numOutcomes) * scaleFactor);
  return Math.max(minB, Math.min(maxB, b));
}

// ── Bayesian Posterior Tracker ─────────────────────────────────────────

/**
 * Maintains a running Bayesian posterior in log-space for numerical stability.
 *
 * log P(H|D) = log P(H) + Σ log P(D_k|H) − log Z
 *
 * Each update multiplies the prior by the likelihood of new evidence,
 * keeping everything in log-space to avoid underflow on long sequences.
 */
class BayesianTracker {
  constructor() {
    // Map<marketId, { logPosterior, updates, lastUpdate, priorSource }>
    this.beliefs = new Map();
  }

  /**
   * Initialize or get posterior for a market.
   * Prior defaults to the market's current price (weak prior).
   */
  getPosterior(marketId, currentPrice = 0.5) {
    if (!this.beliefs.has(marketId)) {
      // Initialize with market price as weak prior
      const p = Math.max(0.01, Math.min(0.99, currentPrice));
      this.beliefs.set(marketId, {
        logPosterior: Math.log(p),
        logComplement: Math.log(1 - p),
        updates: 0,
        lastUpdate: Date.now(),
        priorSource: 'market-price',
      });
    }
    return this.beliefs.get(marketId);
  }

  /**
   * Update posterior with new evidence.
   * @param {string} marketId
   * @param {number} likelihood - P(evidence | H=yes), range (0,1)
   * @param {number} likelihoodNo - P(evidence | H=no), range (0,1)
   * @param {string} source - what generated this update (price, volume, whale, news)
   * @param {number} weight - how much to trust this signal (0-1), dampens update
   */
  update(marketId, likelihood, likelihoodNo, source = 'unknown', weight = 1.0) {
    const belief = this.beliefs.get(marketId);
    if (!belief) return null;

    // Dampen likelihood toward 0.5 based on weight (lower weight = weaker update)
    const dampedL = 0.5 + (likelihood - 0.5) * weight;
    const dampedLNo = 0.5 + (likelihoodNo - 0.5) * weight;

    // Clamp to avoid log(0)
    const lYes = Math.max(1e-10, Math.min(1 - 1e-10, dampedL));
    const lNo = Math.max(1e-10, Math.min(1 - 1e-10, dampedLNo));

    // Bayesian update in log-space
    belief.logPosterior += Math.log(lYes);
    belief.logComplement += Math.log(lNo);

    // Normalize (log-space): log P(H|D) = logP - log(exp(logP) + exp(logC))
    const maxLog = Math.max(belief.logPosterior, belief.logComplement);
    const logZ = maxLog + Math.log(
      Math.exp(belief.logPosterior - maxLog) + Math.exp(belief.logComplement - maxLog)
    );
    belief.logPosterior -= logZ;
    belief.logComplement -= logZ;

    belief.updates++;
    belief.lastUpdate = Date.now();
    belief.priorSource = source;

    return this.getModelProbability(marketId);
  }

  /**
   * Get model probability p̂ from log posterior.
   */
  getModelProbability(marketId) {
    const belief = this.beliefs.get(marketId);
    if (!belief) return null;
    return Math.exp(belief.logPosterior);
  }

  /**
   * Decay old beliefs toward 0.5 (maximum entropy) over time.
   * Markets with stale posteriors shouldn't be trusted.
   */
  decay(halfLifeMs = 3600000) { // 1 hour half-life
    const now = Date.now();
    for (const [id, belief] of this.beliefs) {
      const age = now - belief.lastUpdate;
      if (age < 60000) continue; // skip fresh updates

      const decayFactor = Math.pow(0.5, age / halfLifeMs);
      // Pull toward log(0.5) = -0.693
      const logHalf = Math.log(0.5);
      belief.logPosterior = logHalf + (belief.logPosterior - logHalf) * decayFactor;
      belief.logComplement = logHalf + (belief.logComplement - logHalf) * decayFactor;
    }
  }

  /**
   * Prune markets we haven't seen in a while.
   */
  prune(maxAgeMs = 86400000) { // 24 hours
    const now = Date.now();
    for (const [id, belief] of this.beliefs) {
      if (now - belief.lastUpdate > maxAgeMs) this.beliefs.delete(id);
    }
  }
}

// ── Kelly Criterion with Duration Guard ────────────────────────────────

/**
 * Fractional Kelly with duration-based guard.
 *
 * Full Kelly: f* = (p̂ * odds - 1) / (odds - 1)  or  f* = (p̂ - p) / (1 - p)
 *
 * But NEVER full Kelly on short-duration markets:
 *   - < 5 min to expiry: quarter Kelly (0.25x)
 *   - < 1 hour: third Kelly (0.33x)
 *   - < 24 hours: half Kelly (0.5x)
 *   - > 24 hours: half Kelly (0.5x) — we never go full
 *
 * Additionally caps at maxPositionPct of portfolio.
 */
function fractionalKelly(modelProb, marketPrice, timeToExpiryMs, portfolioValue, maxPositionPct = 0.05) {
  const pHat = Math.max(0.01, Math.min(0.99, modelProb));
  const p = Math.max(0.01, Math.min(0.99, marketPrice));

  // Edge must be positive
  const ev = pHat - p;
  if (ev <= 0) return 0;

  // Full Kelly fraction: f* = edge / (1 - p)
  // This is the optimal growth rate fraction for a binary bet
  const fullKelly = ev / (1 - p);

  // Duration guard — the key insight from the research doc
  const FIVE_MIN = 5 * 60 * 1000;
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * 60 * 60 * 1000;

  let kellyFraction;
  if (timeToExpiryMs < FIVE_MIN) {
    kellyFraction = 0.25; // Quarter Kelly — fat tails on short markets
  } else if (timeToExpiryMs < ONE_HOUR) {
    kellyFraction = 0.33;
  } else if (timeToExpiryMs < ONE_DAY) {
    kellyFraction = 0.5;
  } else {
    kellyFraction = 0.5; // Never go above half Kelly
  }

  const positionFraction = fullKelly * kellyFraction;

  // Cap at maxPositionPct of portfolio
  const maxPosition = portfolioValue * maxPositionPct;
  const positionSize = Math.min(positionFraction * portfolioValue, maxPosition);

  return Math.max(0, positionSize);
}

// ── Inefficiency Detection ─────────────────────────────────────────────

/**
 * Detect LMSR vs CLOB price divergence.
 *
 * The LMSR softmax price function gives theoretical prices based on
 * outstanding quantities. When the CLOB mid-price diverges from the
 * LMSR-implied price, the gap is tradeable.
 *
 * Signal strength = |p_clob - p_lmsr| / max(p_clob, p_lmsr)
 */
function detectInefficiency(marketPrice, volume, numOutcomes = 2) {
  const b = estimateB(volume, numOutcomes);

  // Infer LMSR quantities from current market price
  const prices = numOutcomes === 2
    ? [marketPrice, 1 - marketPrice]
    : Array(numOutcomes).fill(1 / numOutcomes); // fallback for multi-outcome

  const quantities = inferQuantities(prices, b);

  // Recompute LMSR theoretical price from quantities
  const lmsrPrices = lmsrPrice(quantities, b);
  const lmsrYesPrice = lmsrPrices[0];

  // The divergence between CLOB mid and LMSR theoretical
  const divergence = Math.abs(marketPrice - lmsrYesPrice);
  const relDivergence = divergence / Math.max(marketPrice, lmsrYesPrice, 0.01);

  return {
    lmsrPrice: lmsrYesPrice,
    clobPrice: marketPrice,
    divergence,
    relDivergence,
    b,
    maxMakerLoss: b * Math.log(numOutcomes), // L_max = b * ln(n)
  };
}

// ── Persistent state ───────────────────────────────────────────────────

const bayesianTracker = new BayesianTracker();

// ── Strategy Implementation ────────────────────────────────────────────

const MIN_EV = 0.03;          // 3% minimum expected value to surface
const MIN_LIQUIDITY = 8000;   // $8k minimum liquidity
const EXIT_EV = 0.005;        // 0.5% — close when edge erodes
const MAX_OPPORTUNITIES = 15; // cap per scan cycle

const bayesianLmsr = {
  name: 'bayesian-lmsr',
  type: 'statistical',
  riskLevel: 'medium',
  description: 'Bayesian posterior + LMSR softmax pricing for inefficiency detection with fractional Kelly sizing',

  async scan(bot) {
    try {
      const markets = await fetchMarketsOnce();

      const opportunities = [];
      const portfolioValue = bot?.portfolio?.cash || 10000;

      // Decay old beliefs toward maximum entropy
      bayesianTracker.decay();
      bayesianTracker.prune();

      for (const market of markets) {
        // Parse market price
        let yesPrice = 0.5;
        try {
          const prices = typeof market.outcomePrices === 'string'
            ? JSON.parse(market.outcomePrices) : market.outcomePrices;
          if (prices && prices.length >= 1) yesPrice = parseFloat(prices[0]) || 0.5;
        } catch { continue; }

        const liquidity = market.liquidity || 0;
        if (liquidity < MIN_LIQUIDITY) continue;

        const volume = market.volume || 0;
        const marketId = market.conditionId || market.id;
        if (!marketId) continue;

        // ── Step 1: Initialize / update Bayesian posterior ──

        const posterior = bayesianTracker.getPosterior(marketId, yesPrice);

        // Update with price signal (market price itself is weak evidence)
        // If price moved significantly since last update, that's informative
        const currentModel = bayesianTracker.getModelProbability(marketId);
        const priceDelta = Math.abs(yesPrice - currentModel);

        if (priceDelta > 0.02) {
          // Price moved > 2% — treat as new evidence
          // Likelihood: if price went up, evidence favors YES
          const priceDirection = yesPrice > currentModel;
          const strength = Math.min(priceDelta * 5, 0.4); // cap influence
          const likelihoodYes = priceDirection ? (0.5 + strength) : (0.5 - strength);
          const likelihoodNo = priceDirection ? (0.5 - strength) : (0.5 + strength);
          bayesianTracker.update(marketId, likelihoodYes, likelihoodNo, 'price-tick', 0.6);
        }

        // Volume signal — high recent volume suggests informed trading
        if (volume > 50000) {
          // High volume slightly reinforces current price direction
          const volWeight = Math.min(volume / 500000, 0.3);
          bayesianTracker.update(
            marketId,
            yesPrice > 0.5 ? 0.5 + volWeight * 0.1 : 0.5 - volWeight * 0.1,
            yesPrice > 0.5 ? 0.5 - volWeight * 0.1 : 0.5 + volWeight * 0.1,
            'volume',
            volWeight
          );
        }

        // ── Step 2: LMSR inefficiency detection ──

        const inefficiency = detectInefficiency(yesPrice, volume);

        // If LMSR divergence is significant, update posterior with structural signal
        if (inefficiency.relDivergence > 0.01) {
          // LMSR price is the "structural" fair value — divergence from CLOB is informative
          const lmsrDirection = inefficiency.lmsrPrice > yesPrice;
          const lmsrStrength = Math.min(inefficiency.relDivergence * 2, 0.3);
          bayesianTracker.update(
            marketId,
            lmsrDirection ? (0.5 + lmsrStrength) : (0.5 - lmsrStrength),
            lmsrDirection ? (0.5 - lmsrStrength) : (0.5 + lmsrStrength),
            'lmsr-divergence',
            0.8
          );
        }

        // ── Step 3: Compute EV and check entry ──

        const modelProb = bayesianTracker.getModelProbability(marketId);
        const ev = modelProb - yesPrice; // EV = p̂ − p

        // Need sufficient edge to trade
        if (Math.abs(ev) < MIN_EV) continue;

        // Determine direction
        const side = ev > 0 ? 'YES' : 'NO';
        const absEv = Math.abs(ev);
        const effectivePrice = side === 'YES' ? yesPrice : (1 - yesPrice);

        // ── Step 4: Kelly position sizing with duration guard ──

        const endDate = market.endDate ? new Date(market.endDate) : null;
        const timeToExpiry = endDate ? Math.max(0, endDate.getTime() - Date.now()) : 86400000;

        const kellySize = fractionalKelly(
          side === 'YES' ? modelProb : (1 - modelProb),
          effectivePrice,
          timeToExpiry,
          portfolioValue,
          0.05 // max 5% of portfolio per position
        );

        if (kellySize < 5) continue; // Skip tiny positions

        // Confidence based on number of Bayesian updates and EV magnitude
        const updateCount = posterior.updates;
        const infoConfidence = Math.min(updateCount / 20, 1.0); // more updates = more confidence
        const evConfidence = Math.min(absEv / 0.10, 1.0); // larger EV = more confidence
        const confidence = (infoConfidence * 0.4 + evConfidence * 0.6);

        opportunities.push({
          market: market.question || market.title || marketId,
          marketId,
          conditionId: market.conditionId,
          slug: market.slug || '',
          side,
          direction: side === 'YES' ? 'BUY' : 'BUY',
          outcome: side === 'YES' ? 0 : 1,
          price: effectivePrice,
          modelProbability: modelProb,
          marketPrice: yesPrice,
          expectedReturn: absEv,
          edge: absEv,
          ev: ev,
          confidence,
          liquidity,
          volume,
          maxPosition: Math.round(kellySize),
          lmsr: {
            b: inefficiency.b,
            lmsrPrice: inefficiency.lmsrPrice,
            clobPrice: inefficiency.clobPrice,
            divergence: inefficiency.divergence,
            maxMakerLoss: inefficiency.maxMakerLoss,
          },
          bayesian: {
            posteriorYes: modelProb,
            posteriorNo: 1 - modelProb,
            updates: updateCount,
            lastSource: posterior.priorSource,
          },
          kelly: {
            rawSize: kellySize,
            timeToExpiry,
            durationGuard: timeToExpiry < 300000 ? '0.25x' :
                           timeToExpiry < 3600000 ? '0.33x' :
                           '0.5x',
          },
          clobTokenIds: market.clobTokenIds || [],
          endDate: market.endDate,
          executionSpeed: 0.7,
          type: 'bayesian-lmsr-inefficiency',
        });
      }

      if (opportunities.length > 0) {
        console.log(
          `  [bayesian-lmsr] ${markets.length} markets scanned, ` +
          `${bayesianTracker.beliefs.size} tracked, ` +
          `${opportunities.length} signals (top EV: ${(opportunities[0]?.ev * 100 || 0).toFixed(1)}%)`
        );
      }

      // ── GPU: Edge prediction + Monte Carlo for refined sizing ──
      if (opportunities.length > 0) {
        try {
          // 1. Edge prediction — GPU neural net scores each opportunity
          const predictions = await gpu.predictEdge(opportunities.map(o => ({
            edge: o.edge,
            liquidity: o.liquidity,
            volume: o.volume,
            price: o.price,
            confidence: o.confidence,
            modelProbability: o.modelProbability,
            marketPrice: o.marketPrice,
            divergence: o.lmsr?.divergence || 0,
            updates: o.bayesian?.updates || 0,
            strategy: 'bayesian-lmsr',
          })));
          if (predictions) {
            for (let i = 0; i < opportunities.length && i < predictions.length; i++) {
              const winProb = predictions[i]?.winProbability || predictions[i]?.win_probability || 0.5;
              opportunities[i].gpuWinProb = winProb;
              // GPU refines model probability — blend with Bayesian posterior
              const gpuWeight = 0.3; // 30% GPU, 70% Bayesian posterior
              const blendedProb = opportunities[i].modelProbability * (1 - gpuWeight) + winProb * gpuWeight;
              const revisedEv = Math.abs(blendedProb - opportunities[i].marketPrice);
              if (revisedEv < MIN_EV * 0.5) {
                opportunities[i].edge *= 0.3; // GPU says edge is likely spurious — heavy penalty
              } else {
                opportunities[i].edge = revisedEv;
              }
            }
          }

          // 2. Monte Carlo — refined position sizing for top opportunities
          const top5 = opportunities.slice(0, 5);
          if (top5.length > 0) {
            const mcResult = await gpu.monteCarloSimulation(
              top5.map(o => ({
                edge: o.edge,
                price: o.price,
                size: o.maxPosition,
                strategy: 'bayesian-lmsr',
              })),
              portfolioValue,
              10000, // 10k paths
              7 // 7 day horizon
            );
            if (mcResult?.position_sizes) {
              for (let i = 0; i < top5.length && i < mcResult.position_sizes.length; i++) {
                const mcSize = mcResult.position_sizes[i];
                if (typeof mcSize === 'number' && mcSize > 0) {
                  // Blend Kelly and Monte Carlo sizing — MC is more conservative
                  top5[i].maxPosition = Math.round(
                    top5[i].maxPosition * 0.4 + mcSize * 0.6
                  );
                  top5[i].kelly.mcSize = mcSize;
                }
              }
            }
            if (mcResult?.var_95) {
              opportunities.forEach(o => o.portfolioVaR95 = mcResult.var_95);
            }
          }
        } catch {}
      }

      return opportunities
        .sort((a, b) => Math.abs(b.ev) - Math.abs(a.ev))
        .slice(0, MAX_OPPORTUNITIES);
    } catch (err) {
      console.error('[bayesian-lmsr]', err.message);
      return [];
    }
  },

  async validate(opp) {
    if (!opp) return false;
    if (!opp.ev || Math.abs(opp.ev) < EXIT_EV) return false;
    if (!opp.liquidity || opp.liquidity < MIN_LIQUIDITY) return false;
    if (!opp.maxPosition || opp.maxPosition < 5) return false;

    // Re-check model probability hasn't decayed
    const currentModel = bayesianTracker.getModelProbability(opp.marketId);
    if (currentModel === null) return false;

    const currentEv = opp.side === 'YES'
      ? currentModel - opp.marketPrice
      : (1 - currentModel) - (1 - opp.marketPrice);

    // Edge must still exceed exit threshold
    return Math.abs(currentEv) >= EXIT_EV;
  },

  async execute(bot, opp) {
    const size = opp.maxPosition;
    const dg = opp.kelly?.durationGuard || '0.5x';

    console.log(
      `[bayesian-lmsr] Executing: ${opp.side} on "${(opp.market || '').slice(0, 50)}" ` +
      `EV=${(opp.ev * 100).toFixed(2)}% model=${(opp.modelProbability * 100).toFixed(1)}% ` +
      `market=${(opp.marketPrice * 100).toFixed(1)}% ` +
      `kelly=$${size} (${dg}) ` +
      `lmsr_div=${(opp.lmsr?.divergence * 100 || 0).toFixed(2)}% ` +
      `updates=${opp.bayesian?.updates || 0}`
    );

    return bot.execute(opp, { size });
  },
};

module.exports = [bayesianLmsr];

// Export internals for testing
module.exports._internals = {
  lmsrCost,
  lmsrPrice,
  inferQuantities,
  estimateB,
  detectInefficiency,
  fractionalKelly,
  BayesianTracker,
};
