/**
 * Orderbook Imbalance Analyzer
 *
 * Uses CLOB orderbook depth data to detect directional imbalances.
 * When one side of the book has significantly more depth, it signals
 * smart money accumulation or distribution.
 *
 * Signals:
 *   - Bid-heavy imbalance (bid depth >> ask depth): accumulation → bullish
 *   - Ask-heavy imbalance (ask depth >> bid depth): distribution → bearish
 *   - Depth acceleration: sudden increase in one-sided depth
 *
 * This module enriches existing strategy opportunities with imbalance
 * data, boosting or reducing edge estimates based on order flow.
 */

const MIN_IMBALANCE_RATIO = 2.5;   // Minimum bid/ask ratio to generate signal
const STRONG_IMBALANCE_RATIO = 5.0; // Strong directional signal
const MIN_DEPTH_USD = 500;          // Minimum total depth to consider meaningful
const DEPTH_LEVELS = 5;             // Number of price levels to analyze

class OrderbookImbalanceAnalyzer {
  constructor(clobClient) {
    this.clob = clobClient;
    this._history = new Map(); // tokenId -> [{ timestamp, bidDepth, askDepth }]
    this._historyMaxLen = 30;  // Keep last 30 snapshots per token
  }

  /**
   * Analyze a single orderbook for imbalance signals.
   * Returns { ratio, direction, strength, topBidConcentration, topAskConcentration }
   */
  analyzeBook(book) {
    if (!book || !book.bids || !book.asks) {
      return { ratio: 1, direction: 'neutral', strength: 0 };
    }

    const bids = book.bids.slice(0, DEPTH_LEVELS);
    const asks = book.asks.slice(0, DEPTH_LEVELS);

    const bidVolume = bids.reduce((s, l) => s + l.size * l.price, 0);
    const askVolume = asks.reduce((s, l) => s + l.size * l.price, 0);
    const totalDepth = bidVolume + askVolume;

    if (totalDepth < MIN_DEPTH_USD) {
      return { ratio: 1, direction: 'neutral', strength: 0, totalDepth };
    }

    const ratio = bidVolume / (askVolume || 1);

    // Top-of-book concentration: what % of depth is at best price
    const topBidConcentration = bids.length > 0
      ? (bids[0].size * bids[0].price) / (bidVolume || 1) : 0;
    const topAskConcentration = asks.length > 0
      ? (asks[0].size * asks[0].price) / (askVolume || 1) : 0;

    let direction = 'neutral';
    let strength = 0;

    if (ratio >= STRONG_IMBALANCE_RATIO) {
      direction = 'strong-bid';
      strength = Math.min(1.0, (ratio - STRONG_IMBALANCE_RATIO) / 10 + 0.7);
    } else if (ratio >= MIN_IMBALANCE_RATIO) {
      direction = 'bid-heavy';
      strength = Math.min(0.7, (ratio - MIN_IMBALANCE_RATIO) / (STRONG_IMBALANCE_RATIO - MIN_IMBALANCE_RATIO) * 0.7);
    } else if (1 / ratio >= STRONG_IMBALANCE_RATIO) {
      direction = 'strong-ask';
      strength = Math.min(1.0, (1 / ratio - STRONG_IMBALANCE_RATIO) / 10 + 0.7);
    } else if (1 / ratio >= MIN_IMBALANCE_RATIO) {
      direction = 'ask-heavy';
      strength = Math.min(0.7, (1 / ratio - MIN_IMBALANCE_RATIO) / (STRONG_IMBALANCE_RATIO - MIN_IMBALANCE_RATIO) * 0.7);
    }

    return {
      ratio: parseFloat(ratio.toFixed(2)),
      direction,
      strength: parseFloat(strength.toFixed(3)),
      bidVolume: parseFloat(bidVolume.toFixed(2)),
      askVolume: parseFloat(askVolume.toFixed(2)),
      totalDepth: parseFloat(totalDepth.toFixed(2)),
      topBidConcentration: parseFloat(topBidConcentration.toFixed(3)),
      topAskConcentration: parseFloat(topAskConcentration.toFixed(3)),
      spread: book.spread,
      midpoint: book.midpoint,
    };
  }

  /**
   * Record a snapshot for trend detection.
   */
  recordSnapshot(tokenId, analysis) {
    if (!this._history.has(tokenId)) {
      this._history.set(tokenId, []);
    }
    const hist = this._history.get(tokenId);
    hist.push({
      timestamp: Date.now(),
      bidVolume: analysis.bidVolume,
      askVolume: analysis.askVolume,
      ratio: analysis.ratio,
      direction: analysis.direction,
    });
    if (hist.length > this._historyMaxLen) {
      hist.splice(0, hist.length - this._historyMaxLen);
    }
  }

  /**
   * Detect acceleration: is the imbalance growing over recent snapshots?
   */
  detectAcceleration(tokenId) {
    const hist = this._history.get(tokenId);
    if (!hist || hist.length < 3) return { accelerating: false };

    const recent = hist.slice(-3);
    const ratios = recent.map(h => h.ratio);

    const increasing = ratios[0] < ratios[1] && ratios[1] < ratios[2];
    const decreasing = ratios[0] > ratios[1] && ratios[1] > ratios[2];

    const rateOfChange = (ratios[2] - ratios[0]) / ratios[0];

    return {
      accelerating: increasing || decreasing,
      direction: increasing ? 'bid-accelerating' : decreasing ? 'ask-accelerating' : 'stable',
      rateOfChange: parseFloat(rateOfChange.toFixed(3)),
      dataPoints: hist.length,
    };
  }

  /**
   * Analyze both sides of a market (YES and NO token orderbooks).
   * Returns a combined signal with directional recommendation.
   */
  analyzeMarket(yesTokenId, noTokenId) {
    const yesBook = this.clob.getCachedBook(yesTokenId);
    const noBook = this.clob.getCachedBook(noTokenId);

    const yesAnalysis = this.analyzeBook(yesBook);
    const noAnalysis = this.analyzeBook(noBook);

    if (yesTokenId) this.recordSnapshot(yesTokenId, yesAnalysis);
    if (noTokenId) this.recordSnapshot(noTokenId, noAnalysis);

    const yesAccel = this.detectAcceleration(yesTokenId);
    const noAccel = this.detectAcceleration(noTokenId);

    // Combine signals: bid-heavy on YES book = bullish; bid-heavy on NO book = bearish
    let signal = 'neutral';
    let signalStrength = 0;
    let edgeBoost = 0;

    const yesBullish = yesAnalysis.direction.includes('bid');
    const noBearish = noAnalysis.direction.includes('bid'); // Buying NO = bearish on YES

    if (yesBullish && !noBearish) {
      signal = 'bullish';
      signalStrength = yesAnalysis.strength;
      edgeBoost = signalStrength * 0.015; // Up to 1.5% edge boost
    } else if (noBearish && !yesBullish) {
      signal = 'bearish';
      signalStrength = noAnalysis.strength;
      edgeBoost = signalStrength * 0.015;
    } else if (yesBullish && noBearish) {
      signal = 'conflicting';
      signalStrength = 0;
      edgeBoost = 0;
    }

    // Acceleration amplifier
    if (yesAccel.accelerating && yesAccel.direction === 'bid-accelerating') {
      edgeBoost *= 1.3;
      signal = signal === 'bullish' ? 'strong-bullish' : signal;
    }
    if (noAccel.accelerating && noAccel.direction === 'bid-accelerating') {
      edgeBoost *= 1.3;
      signal = signal === 'bearish' ? 'strong-bearish' : signal;
    }

    return {
      signal,
      signalStrength: parseFloat(signalStrength.toFixed(3)),
      edgeBoost: parseFloat(Math.min(edgeBoost, 0.03).toFixed(4)),
      yes: yesAnalysis,
      no: noAnalysis,
      yesAcceleration: yesAccel,
      noAcceleration: noAccel,
      recommendation: signal.includes('bullish') ? 'BUY_YES'
        : signal.includes('bearish') ? 'BUY_NO'
        : 'HOLD',
    };
  }

  /**
   * Enrich an array of opportunities with orderbook imbalance data.
   * Adjusts edgePercent based on flow signals.
   */
  enrichOpportunities(opportunities) {
    return opportunities.map(opp => {
      const tokens = opp.clobTokenIds || [];
      if (tokens.length < 2) return opp;

      const analysis = this.analyzeMarket(tokens[0], tokens[1]);

      if (analysis.edgeBoost <= 0) return { ...opp, flowSignal: analysis.signal };

      const directionAligned =
        (opp.direction === 'BUY_YES' && analysis.recommendation === 'BUY_YES') ||
        (opp.direction === 'BUY_NO' && analysis.recommendation === 'BUY_NO') ||
        opp.direction === 'BUY_BOTH';

      const boost = directionAligned ? analysis.edgeBoost : -analysis.edgeBoost * 0.5;
      const adjustedEdge = Math.max(0, (opp.edgePercent || 0) + boost);

      return {
        ...opp,
        edgePercent: adjustedEdge,
        executableEdge: adjustedEdge,
        flowSignal: analysis.signal,
        flowStrength: analysis.signalStrength,
        flowBoost: boost,
        flowRecommendation: analysis.recommendation,
      };
    });
  }
}

module.exports = OrderbookImbalanceAnalyzer;
