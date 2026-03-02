#!/usr/bin/env node
/**
 * Oracle Research Daemon
 *
 * Runs alongside the main bot as a separate process. Periodically:
 *   1. Scans news for events affecting active markets
 *   2. Monitors X/Twitter sentiment on tracked keywords
 *   3. Tracks whale wallets and large trades on Polymarket
 *   4. Auto-updates news-theses.json with fresh signals
 *   5. Logs a summary to oracle-log.json for the dashboard
 *
 * Usage:
 *   node oracle/index.js              (default: all scanners, 10-minute cycle)
 *   node oracle/index.js --fast       (5-minute cycle)
 *   node oracle/index.js --once       (run once and exit)
 */
const chalk = require('chalk');
const fs = require('fs').promises;
const path = require('path');

const whaleTracker = require('./whale-tracker');
const newsScanner = require('./news-scanner');
const xSentiment = require('./x-sentiment');

const LOG_PATH = path.join(__dirname, '..', 'data', 'oracle-log.json');
const THESES_PATH = path.join(__dirname, '..', 'data', 'news-theses.json');

const DEFAULT_INTERVAL = 10 * 60 * 1000; // 10 minutes
const FAST_INTERVAL = 5 * 60 * 1000;     // 5 minutes

async function loadLog() {
  try {
    return JSON.parse(await fs.readFile(LOG_PATH, 'utf8'));
  } catch { return { runs: [], stats: { totalRuns: 0, totalSignals: 0, totalTheses: 0 } }; }
}

async function saveLog(log) {
  log.runs = log.runs.slice(-100);
  await fs.writeFile(LOG_PATH, JSON.stringify(log, null, 2));
}

async function loadTheses() {
  try {
    const raw = JSON.parse(await fs.readFile(THESES_PATH, 'utf8'));
    if (Array.isArray(raw)) return { theses: raw, lastUpdated: 0 };
    return raw && raw.theses ? raw : { theses: [], lastUpdated: 0 };
  } catch { return { theses: [], lastUpdated: 0 }; }
}

/**
 * Merge whale signals into news-theses.json as actionable theses.
 */
async function mergeWhaleSignalsToTheses(whaleSignals) {
  if (!whaleSignals || whaleSignals.length === 0) return 0;

  const thesesData = await loadTheses();
  const existingIds = new Set(thesesData.theses.map(t => t.id));
  let added = 0;

  for (const signal of whaleSignals) {
    const id = `whale-${signal.type}-${signal.timestamp}`;
    if (existingIds.has(id)) continue;

    let bias, keywords, rationale;

    if (signal.type === 'whale-flow') {
      bias = signal.direction === 'BUY' ? 'BUY_YES' : 'BUY_NO';
      keywords = [signal.marketId];
      rationale = `[Auto/Whale] $${signal.totalSize} in ${signal.direction} flow (${signal.tradeCount} trades, ${Math.round(signal.buyRatio * 100)}% buy)`;
    } else if (signal.type === 'smart-wallet') {
      bias = (signal.side || '').toUpperCase() === 'BUY' ? 'BUY_YES' : 'BUY_NO';
      keywords = [signal.marketId];
      rationale = `[Auto/SmartWallet] @${signal.username} (PnL: $${Math.round(signal.walletPnl)}) placed $${signal.size} ${signal.side}`;
    } else {
      continue;
    }

    thesesData.theses.push({
      id,
      keywords,
      bias,
      confidence: signal.confidence || 0.5,
      rationale,
      source: 'oracle-whale-tracker',
      createdAt: new Date(signal.timestamp).toISOString(),
      expiresAt: new Date(signal.timestamp + 6 * 3600000).toISOString(), // 6-hour expiry
    });
    existingIds.add(id);
    added++;
  }

  if (added > 0) {
    thesesData.lastUpdated = Date.now();
    await fs.writeFile(THESES_PATH, JSON.stringify(thesesData, null, 2));
  }
  return added;
}

/**
 * Merge X sentiment signals into theses.
 */
async function mergeXSentimentToTheses(xSignals) {
  if (!xSignals || xSignals.length === 0) return 0;

  const thesesData = await loadTheses();
  const existingIds = new Set(thesesData.theses.map(t => t.id));
  let added = 0;

  for (const signal of xSignals) {
    if (signal.confidence < 0.15 || signal.sentiment === 'mixed') continue;

    const id = `x-${signal.queryId}-${Math.floor(signal.timestamp / 3600000)}`;
    if (existingIds.has(id)) continue;

    const bias = signal.sentiment === 'bullish' ? 'BUY_YES' : 'BUY_NO';

    thesesData.theses.push({
      id,
      keywords: signal.query.split(' OR ').map(k => k.trim().toLowerCase()),
      bias,
      confidence: Math.min(0.25 + signal.confidence, 0.65),
      rationale: `[Auto/X] ${signal.sentiment} sentiment on "${signal.query}" (${signal.bullish}B/${signal.bearish}Be, ${signal.sampleSize} samples${signal.isTrending ? ', TRENDING' : ''})`,
      source: 'oracle-x-sentiment',
      createdAt: new Date(signal.timestamp).toISOString(),
      expiresAt: new Date(signal.timestamp + 4 * 3600000).toISOString(), // 4-hour expiry
    });
    existingIds.add(id);
    added++;
  }

  if (added > 0) {
    thesesData.lastUpdated = Date.now();
    await fs.writeFile(THESES_PATH, JSON.stringify(thesesData, null, 2));
  }
  return added;
}

/**
 * Prune expired theses from all oracle sources.
 */
async function pruneExpiredTheses() {
  const thesesData = await loadTheses();
  const before = thesesData.theses.length;
  thesesData.theses = thesesData.theses.filter(t => {
    if (!t.expiresAt) return true;
    return new Date(t.expiresAt) > new Date();
  });
  const pruned = before - thesesData.theses.length;
  if (pruned > 0) {
    thesesData.lastUpdated = Date.now();
    await fs.writeFile(THESES_PATH, JSON.stringify(thesesData, null, 2));
  }
  return pruned;
}

async function runCycle() {
  const start = Date.now();
  const results = { timestamp: start, scanners: {} };

  console.log(chalk.magenta('\n╔══════════════════════════════════════════╗'));
  console.log(chalk.magenta('║        ORACLE RESEARCH DAEMON            ║'));
  console.log(chalk.magenta('╚══════════════════════════════════════════╝'));
  console.log(chalk.gray(`  ${new Date().toLocaleString()}\n`));

  // 1. Prune expired theses
  const pruned = await pruneExpiredTheses();
  if (pruned > 0) console.log(chalk.gray(`  Pruned ${pruned} expired theses`));

  // 2. News Scanner
  console.log(chalk.cyan('  [1/3] Scanning news sources...'));
  try {
    const newsResult = await newsScanner.scan();
    results.scanners.news = newsResult;
    console.log(chalk.green(`    ✓ Scanned ${newsResult.newsResults} sources, ${newsResult.matches} matches against ${newsResult.markets} markets`));
  } catch (err) {
    results.scanners.news = { error: err.message };
    console.log(chalk.red(`    ✗ News scan failed: ${err.message}`));
  }

  // 3. X/Twitter Sentiment
  console.log(chalk.cyan('  [2/3] Scanning X/Twitter sentiment...'));
  try {
    const xSignals = await xSentiment.scan();
    results.scanners.xSentiment = { signals: xSignals.length };
    const xTheses = await mergeXSentimentToTheses(xSignals);
    console.log(chalk.green(`    ✓ ${xSignals.length} sentiment signals, ${xTheses} new theses`));
    if (xSignals.length > 0) {
      for (const s of xSignals.slice(0, 3)) {
        const icon = s.sentiment === 'bullish' ? '📈' : s.sentiment === 'bearish' ? '📉' : '↔';
        console.log(chalk.gray(`      ${icon} ${s.queryId}: ${s.sentiment} (conf: ${s.confidence}${s.isTrending ? ' TRENDING' : ''})`));
      }
    }
  } catch (err) {
    results.scanners.xSentiment = { error: err.message };
    console.log(chalk.red(`    ✗ X sentiment scan failed: ${err.message}`));
  }

  // 4. Whale Tracker
  console.log(chalk.cyan('  [3/3] Scanning whale activity...'));
  try {
    const whaleSignals = await whaleTracker.scan();
    results.scanners.whales = { signals: whaleSignals.length };
    const whaleTheses = await mergeWhaleSignalsToTheses(whaleSignals);
    console.log(chalk.green(`    ✓ ${whaleSignals.length} whale signals, ${whaleTheses} new theses`));
    if (whaleSignals.length > 0) {
      for (const s of whaleSignals.slice(0, 3)) {
        if (s.type === 'whale-flow') {
          console.log(chalk.yellow(`      🐋 $${s.totalSize} ${s.direction} flow (${s.tradeCount} trades)`));
        } else if (s.type === 'smart-wallet') {
          console.log(chalk.yellow(`      💰 @${s.username} placed $${s.size} ${s.side}`));
        }
      }
    }
  } catch (err) {
    results.scanners.whales = { error: err.message };
    console.log(chalk.red(`    ✗ Whale scan failed: ${err.message}`));
  }

  // Summary
  const thesesData = await loadTheses();
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  results.elapsed = elapsed;
  results.activeTheses = thesesData.theses.length;

  console.log(chalk.magenta(`\n  ═══ Cycle complete in ${elapsed}s | ${thesesData.theses.length} active theses ═══\n`));

  // Save log
  const log = await loadLog();
  log.runs.push(results);
  log.stats.totalRuns++;
  log.stats.totalSignals += (results.scanners.whales?.signals || 0) + (results.scanners.xSentiment?.signals || 0);
  log.stats.totalTheses = thesesData.theses.length;
  log.stats.lastRun = new Date().toISOString();
  await saveLog(log);

  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const once = args.includes('--once');
  const fast = args.includes('--fast');
  const interval = fast ? FAST_INTERVAL : DEFAULT_INTERVAL;

  console.log(chalk.magenta.bold('\n  Oracle Research Daemon starting...'));
  console.log(chalk.gray(`  Mode: ${once ? 'single run' : `loop (every ${interval / 60000} min)`}`));
  console.log(chalk.gray(`  Scanners: news, x-sentiment, whale-tracker\n`));

  await runCycle();

  if (!once) {
    console.log(chalk.gray(`  Next scan in ${interval / 60000} minutes...\n`));
    setInterval(async () => {
      try {
        await runCycle();
        console.log(chalk.gray(`  Next scan in ${interval / 60000} minutes...\n`));
      } catch (err) {
        console.error(chalk.red(`  Oracle cycle error: ${err.message}`));
      }
    }, interval);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Oracle daemon fatal error:', err);
    process.exit(1);
  });
}

module.exports = { runCycle, mergeWhaleSignalsToTheses, mergeXSentimentToTheses, pruneExpiredTheses };
