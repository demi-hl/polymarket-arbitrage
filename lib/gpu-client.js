/**
 * GPU Worker Client
 *
 * Connects the bot to the GPU worker over HTTP.
 * When running on the same machine (PC), uses localhost for zero latency.
 * All methods gracefully degrade — if the GPU server is unreachable,
 * they return null so the bot falls back to local logic.
 *
 * Environment:
 *   GPU_WORKER_URL  — default http://127.0.0.1:8899 (localhost)
 *   GPU_TIMEOUT_MS  — default 10000 (10s, longer for LLM/backtest)
 */

const http = require('http');
const https = require('https');

const BASE_URL = process.env.GPU_WORKER_URL || 'http://127.0.0.1:8899';
const DEFAULT_TIMEOUT = Number(process.env.GPU_TIMEOUT_MS) || 10000;
const LLM_TIMEOUT = 30000;       // LLM inference can take a few seconds
const BACKTEST_TIMEOUT = 60000;   // sweeps can take longer
const MC_TIMEOUT = 30000;

class GPUClient {
  constructor(baseUrl = BASE_URL) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.available = null;  // null = unknown, true/false after first check
    this._lastCheck = 0;
    this._checkInterval = 30000; // re-check availability every 30s
    this._stats = { calls: 0, errors: 0, totalMs: 0 };
  }

  // ── HTTP helper ─────────────────────────────────────────────────

  _post(path, body, timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;
      const payload = JSON.stringify(body);

      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: timeoutMs,
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            reject(new Error(`GPU: invalid JSON from ${path}`));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GPU: timeout')); });
      req.write(payload);
      req.end();
    });
  }

  _get(path, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const url = new URL(path, this.baseUrl);
      const mod = url.protocol === 'https:' ? https : http;

      const req = mod.get(url, { timeout: timeoutMs }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error('GPU: invalid JSON')); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('GPU: timeout')); });
    });
  }

  // ── Availability ────────────────────────────────────────────────

  async checkHealth() {
    try {
      const res = await this._get('/health');
      this.available = res.status === 'ok';
      this._lastCheck = Date.now();
      return res;
    } catch {
      this.available = false;
      this._lastCheck = Date.now();
      return null;
    }
  }

  async isAvailable() {
    if (this.available === null || Date.now() - this._lastCheck > this._checkInterval) {
      await this.checkHealth();
    }
    return this.available;
  }

  // ── Wrapper: call GPU, return null on failure ───────────────────

  async _call(path, body, timeoutMs) {
    if (!(await this.isAvailable())) return null;

    const t0 = Date.now();
    this._stats.calls++;
    try {
      const result = await this._post(path, body, timeoutMs);
      this._stats.totalMs += Date.now() - t0;
      return result;
    } catch (err) {
      this._stats.errors++;
      if (this._stats.errors > 5 && this._stats.errors / this._stats.calls > 0.5) {
        this.available = false;
        console.error(`[GPU] Too many errors — disabling for ${this._checkInterval / 1000}s`);
      }
      return null;
    }
  }

  // ── 1. Edge Prediction ──────────────────────────────────────────

  async predictEdge(opportunities) {
    const res = await this._call('/predict/edge', { opportunities }, DEFAULT_TIMEOUT);
    return res?.predictions || null;
  }

  // ── 2. Sentiment Analysis ───────────────────────────────────────

  async analyzeSentimentFast(texts) {
    const items = texts.map(t => (typeof t === 'string' ? { text: t, depth: 'fast' } : t));
    const res = await this._call('/predict/sentiment', { items }, DEFAULT_TIMEOUT);
    return res?.results || null;
  }

  async analyzeSentimentDeep(text, marketQuestion) {
    const items = [{ text, market_question: marketQuestion, depth: 'deep' }];
    const res = await this._call('/predict/sentiment', { items }, LLM_TIMEOUT);
    return res?.results?.[0] || null;
  }

  async analyzeSentimentBatch(items) {
    const res = await this._call('/predict/sentiment', { items }, LLM_TIMEOUT);
    return res?.results || null;
  }

  // ── 3. Orderbook Pattern Detection ──────────────────────────────

  async detectOrderbookPatterns(orderbooks) {
    const res = await this._call('/predict/orderbook', { orderbooks }, DEFAULT_TIMEOUT);
    return res?.predictions || null;
  }

  // ── 4. Backtesting ─────────────────────────────────────────────

  async auditStrategies(trades) {
    const res = await this._call('/backtest', { trades }, BACKTEST_TIMEOUT);
    return res || null;
  }

  async parameterSweep(trades, strategy, params = {}) {
    const body = { trades, strategy, ...params };
    const res = await this._call('/backtest/sweep', body, BACKTEST_TIMEOUT);
    return res || null;
  }

  async walkForward(trades, strategy, trainPct = 0.7) {
    const body = { trades, strategy, train_pct: trainPct };
    const res = await this._call('/backtest/walk-forward', body, BACKTEST_TIMEOUT);
    return res || null;
  }

  // ── 5. Monte Carlo ─────────────────────────────────────────────

  async monteCarloSimulation(positions, bankroll = 10000, nPaths = 50000, horizonDays = 30) {
    const body = { positions, bankroll, n_paths: nPaths, horizon_days: horizonDays };
    const res = await this._call('/risk/monte-carlo', body, MC_TIMEOUT);
    return res || null;
  }

  async stressTest(positions, bankroll = 10000, scenarios = null) {
    const body = { positions, bankroll, scenarios };
    const res = await this._call('/risk/stress-test', body, MC_TIMEOUT);
    return res || null;
  }

  // ── Training ────────────────────────────────────────────────────

  async trainEdge(trades) {
    return this._call('/train/edge', { trades }, DEFAULT_TIMEOUT);
  }

  async trainOrderbook(samples) {
    return this._call('/train/orderbook', { samples }, DEFAULT_TIMEOUT);
  }

  // ── Status ──────────────────────────────────────────────────────

  async getStatus() {
    if (!(await this.isAvailable())) {
      return { available: false, url: this.baseUrl, stats: this._stats };
    }
    try {
      const status = await this._get('/status');
      return { available: true, url: this.baseUrl, stats: this._stats, ...status };
    } catch {
      return { available: false, url: this.baseUrl, stats: this._stats };
    }
  }

  getLocalStats() {
    return {
      url: this.baseUrl,
      available: this.available,
      ...this._stats,
      avgMs: this._stats.calls > 0 ? Math.round(this._stats.totalMs / this._stats.calls) : 0,
    };
  }
}

module.exports = GPUClient;
