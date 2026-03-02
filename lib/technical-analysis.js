/**
 * Technical Analysis Engine for Polymarket
 *
 * Computes indicators from CLOB price history:
 *   EMA (fast/slow crossovers), RSI, Bollinger Bands, VWAP,
 *   ADX (trend strength), OBV (volume confirmation), ATR (volatility).
 *
 * Input: array of { t, p } candles from /prices-history endpoint.
 * All functions are pure — no side-effects or network calls.
 */

function ema(prices, period) {
  if (prices.length === 0) return [];
  const k = 2 / (period + 1);
  const result = [prices[0]];
  for (let i = 1; i < prices.length; i++) {
    result.push(prices[i] * k + result[i - 1] * (1 - k));
  }
  return result;
}

function sma(prices, period) {
  const result = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += prices[j];
    result.push(sum / period);
  }
  return result;
}

function rsi(prices, period = 14) {
  if (prices.length < period + 1) return prices.map(() => null);
  const result = new Array(prices.length).fill(null);
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss -= change;
  }
  avgGain /= period;
  avgLoss /= period;

  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function bollingerBands(prices, period = 20, mult = 2) {
  const mid = sma(prices, period);
  const upper = [], lower = [];
  for (let i = 0; i < prices.length; i++) {
    if (mid[i] === null) { upper.push(null); lower.push(null); continue; }
    let sumSq = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sumSq += (prices[j] - mid[i]) ** 2;
    }
    const std = Math.sqrt(sumSq / period);
    upper.push(mid[i] + mult * std);
    lower.push(mid[i] - mult * std);
  }
  return { upper, mid, lower };
}

function atr(highs, lows, closes, period = 14) {
  if (closes.length < 2) return closes.map(() => null);
  const tr = [highs[0] - lows[0]];
  for (let i = 1; i < closes.length; i++) {
    tr.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  const result = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < Math.min(period, tr.length); i++) sum += tr[i];
  if (tr.length >= period) {
    result[period - 1] = sum / period;
    for (let i = period; i < tr.length; i++) {
      result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
    }
  }
  return result;
}

function obv(prices, volumes) {
  if (prices.length === 0) return [];
  const result = [0];
  for (let i = 1; i < prices.length; i++) {
    const vol = volumes[i] || 0;
    if (prices[i] > prices[i - 1]) result.push(result[i - 1] + vol);
    else if (prices[i] < prices[i - 1]) result.push(result[i - 1] - vol);
    else result.push(result[i - 1]);
  }
  return result;
}

function vwap(prices, volumes) {
  const result = [];
  let cumPV = 0, cumV = 0;
  for (let i = 0; i < prices.length; i++) {
    const vol = volumes[i] || 0;
    cumPV += prices[i] * vol;
    cumV += vol;
    result.push(cumV > 0 ? cumPV / cumV : prices[i]);
  }
  return result;
}

/**
 * ADX - Average Directional Index (trend strength, 0-100)
 * For prediction markets we approximate H/L from close ± half-spread.
 */
function adx(prices, period = 14) {
  if (prices.length < period * 2 + 1) return prices.map(() => null);
  const spread = 0.005;
  const highs = prices.map(p => p + spread);
  const lows = prices.map(p => p - spread);

  const plusDM = [0], minusDM = [0], trArr = [highs[0] - lows[0]];
  for (let i = 1; i < prices.length; i++) {
    const upMove = highs[i] - highs[i - 1];
    const downMove = lows[i - 1] - lows[i];
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(Math.max(highs[i] - lows[i], Math.abs(highs[i] - prices[i - 1]), Math.abs(lows[i] - prices[i - 1])));
  }

  const smoothedTR = ema(trArr, period);
  const smoothedPlusDM = ema(plusDM, period);
  const smoothedMinusDM = ema(minusDM, period);

  const dx = [];
  for (let i = 0; i < prices.length; i++) {
    const tr = smoothedTR[i] || 1;
    const pdi = (smoothedPlusDM[i] / tr) * 100;
    const mdi = (smoothedMinusDM[i] / tr) * 100;
    const sum = pdi + mdi;
    dx.push(sum > 0 ? Math.abs(pdi - mdi) / sum * 100 : 0);
  }

  return ema(dx, period);
}

/**
 * Compute all indicators for a market's price history.
 * @param {Array<{t: number, p: number}>} candles - from CLOB /prices-history
 * @param {Array<number>} [volumes] - optional volume per candle
 * @returns {object} All indicator arrays + summary signals
 */
function analyze(candles, volumes = null) {
  if (!candles || candles.length < 5) return null;

  const prices = candles.map(c => c.p);
  const times = candles.map(c => c.t);
  const vols = volumes || candles.map(() => 1);

  const ema9 = ema(prices, 9);
  const ema21 = ema(prices, 21);
  const rsi14 = rsi(prices, 14);
  const bb = bollingerBands(prices, 20, 2);
  const adx14 = adx(prices, 14);
  const obvArr = obv(prices, vols);
  const vwapArr = vwap(prices, vols);

  const last = prices.length - 1;
  const price = prices[last];
  const prevPrice = last > 0 ? prices[last - 1] : price;

  const emaCrossUp = last > 0 && ema9[last] > ema21[last] && ema9[last - 1] <= ema21[last - 1];
  const emaCrossDown = last > 0 && ema9[last] < ema21[last] && ema9[last - 1] >= ema21[last - 1];
  const emaSpread = ema9[last] - ema21[last];
  const emaTrend = emaSpread > 0 ? 'bullish' : emaSpread < 0 ? 'bearish' : 'neutral';

  const currentRSI = rsi14[last];
  const rsiOverbought = currentRSI !== null && currentRSI > 70;
  const rsiOversold = currentRSI !== null && currentRSI < 30;

  const bbPosition = bb.upper[last] !== null
    ? (price - bb.lower[last]) / (bb.upper[last] - bb.lower[last])
    : 0.5;
  const bbSqueeze = bb.upper[last] !== null
    ? (bb.upper[last] - bb.lower[last]) / bb.mid[last]
    : 0;
  const bbAboveUpper = bb.upper[last] !== null && price > bb.upper[last];
  const bbBelowLower = bb.lower[last] !== null && price < bb.lower[last];

  const currentADX = adx14[last] || 0;
  const strongTrend = currentADX > 25;

  const obvTrend = last >= 5
    ? (obvArr[last] - obvArr[last - 5] > 0 ? 'accumulation' : 'distribution')
    : 'neutral';

  const vwapDev = vwapArr[last] > 0 ? (price - vwapArr[last]) / vwapArr[last] : 0;

  // Composite signals
  let momentum = 0;
  if (emaTrend === 'bullish') momentum += 1;
  if (emaTrend === 'bearish') momentum -= 1;
  if (rsiOversold) momentum += 1;
  if (rsiOverbought) momentum -= 1;
  if (bbBelowLower) momentum += 1;
  if (bbAboveUpper) momentum -= 1;
  if (obvTrend === 'accumulation') momentum += 0.5;
  if (obvTrend === 'distribution') momentum -= 0.5;
  if (vwapDev < -0.02) momentum += 0.5;
  if (vwapDev > 0.02) momentum -= 0.5;

  let signal = 'HOLD';
  if (momentum >= 2) signal = 'BUY';
  else if (momentum <= -2) signal = 'SELL';
  else if (momentum >= 1) signal = 'WEAK_BUY';
  else if (momentum <= -1) signal = 'WEAK_SELL';

  return {
    price, prevPrice, times,
    ema9: ema9[last], ema21: ema21[last], emaSpread, emaTrend, emaCrossUp, emaCrossDown,
    rsi: currentRSI, rsiOverbought, rsiOversold,
    bbUpper: bb.upper[last], bbMid: bb.mid[last], bbLower: bb.lower[last],
    bbPosition, bbSqueeze, bbAboveUpper, bbBelowLower,
    adx: currentADX, strongTrend,
    obvTrend,
    vwap: vwapArr[last], vwapDev,
    momentum, signal,
    dataPoints: prices.length,
  };
}

module.exports = { ema, sma, rsi, bollingerBands, atr, obv, vwap, adx, analyze };
