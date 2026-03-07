#!/usr/bin/env node

// Prevent crashes from unhandled network errors (Polymarket API timeouts)
process.on('uncaughtException', (err) => {
  if (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH' || err.code === 'ECONNRESET' || err.code === 'ENOTFOUND') {
    console.error(`[uncaughtException] Network error (non-fatal): ${err.code} ${err.message}`);
  } else {
    console.error('[uncaughtException] Fatal:', err);
    process.exit(1);
  }
});
process.on('unhandledRejection', (reason) => {
  const code = reason?.code || '';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ECONNRESET' || code === 'ENOTFOUND') {
    console.error(`[unhandledRejection] Network error (non-fatal): ${code} ${reason?.message || reason}`);
  } else {
    console.error('[unhandledRejection]', reason);
  }
});

require('dotenv').config();

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

// Core components
const PolymarketScanner = require('./scanner');
const PolymarketArbitrageBot = require('./bot');
const WebSocketServer = require('./server/websocket');
const createApiServer = require('./server/api');
const { StrategyRegistry, ALL_STRATEGIES, STRATEGY_COUNT } = require('./strategies');
const EdgeScorer = require('./lib/edge-scorer');
const RiskManager = require('./lib/risk-manager');
const DataStore = require('./learning/data-store');
const EdgeModel = require('./learning/edge-model');
const OrderbookImbalanceAnalyzer = require('./lib/orderbook-imbalance');
const GPUClient = require('./lib/gpu-client');
let WhaleTracker, setWhaleTracker;
try {
  WhaleTracker = require('./integrations/whale-tracker');
  ({ setWhaleTracker } = require('./strategies'));
} catch { WhaleTracker = null; setWhaleTracker = null; }
let oracleModule;
try { oracleModule = require('./oracle'); } catch { oracleModule = null; }

const program = new Command();

program
  .name('polymarket')
  .description('Polymarket Arbitrage Bot - Professional trading system')
  .version('2.0.0');

program
  .option('-m, --mode <mode>', 'Trading mode: paper or live', 'paper')
  .option('-e, --edge <percent>', 'Edge threshold percentage', process.env.MIN_EDGE || '5')
  .option('-c, --cash <amount>', 'Initial cash for paper trading', '10000');

// SCAN COMMAND
program
  .command('scan')
  .description('Scan Polymarket for arbitrage opportunities')
  .option('-t, --threshold <percent>', 'Minimum edge threshold %', process.env.MIN_EDGE || '5')
  .option('-l, --liquidity <amount>', 'Minimum liquidity USD', '1000')
  .option('-s, --sectors <list>', 'Sectors to include: politics, sports, crypto (comma-separated; default: all)', process.env.SECTORS || '')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const threshold = parseFloat(options.threshold) / 100;
      const minLiquidity = parseFloat(options.liquidity);
      const sectors = options.sectors
        ? options.sectors.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
        : undefined;
      
      const scanner = new PolymarketScanner({
        minLiquidity,
        edgeThreshold: threshold,
        ...(sectors && sectors.length ? { sectors } : {})
      });
      const result = await scanner.scan({ threshold });
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold('\n📊 SCAN RESULTS'));
      console.log(chalk.gray(`Time: ${new Date(result.timestamp).toLocaleString()}`));
      console.log(chalk.gray(`Markets scanned: ${result.marketsScanned}`));
      if (sectors?.length) console.log(chalk.gray(`Sectors: ${sectors.join(', ')}`));
      console.log(chalk.gray(`Opportunities found: ${result.opportunitiesFound}`));
      console.log(chalk.gray(`Threshold: ${(result.threshold * 100).toFixed(2)}%\n`));

      if (result.opportunities.length === 0) {
        console.log(chalk.yellow('No arbitrage opportunities found above threshold.'));
        return;
      }

      console.log(chalk.bold('💰 ARBITRAGE OPPORTUNITIES:\n'));
      
      result.opportunities.forEach((opp, i) => {
        const edgeColor = opp.edgePercent >= 0.10 ? chalk.green : opp.edgePercent >= 0.05 ? chalk.yellow : chalk.gray;
        
        console.log(chalk.bold(`${i + 1}. ${opp.question}`));
        console.log(chalk.gray(`   Slug: ${opp.slug}`));
        console.log(`   Edge: ${edgeColor(`${(opp.edgePercent * 100).toFixed(2)}%`)}`);
        console.log(`   Direction: ${opp.direction === 'BUY_BOTH' ? chalk.green('BUY YES + NO') : chalk.red('SELL BOTH')}`);
        console.log(`   YES Price: $${opp.yesPrice.toFixed(3)} | NO Price: $${opp.noPrice.toFixed(3)}`);
        console.log(`   Sum: $${opp.sum.toFixed(3)} (should be $1.00)`);
        console.log(`   Liquidity: $${opp.liquidity.toLocaleString()}`);
        console.log(`   Max Position: $${opp.maxPosition.toFixed(2)}`);
        console.log(chalk.gray(`   Expires: ${new Date(opp.expiresAt * 1000).toLocaleDateString()}\n`));
      });

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// WATCH COMMAND
program
  .command('watch')
  .description('Watch for arbitrage opportunities and auto-execute')
  .option('-i, --interval <seconds>', 'Scan interval in seconds',
    process.env.SCAN_INTERVAL ? String(parseInt(process.env.SCAN_INTERVAL) / 1000) : '30')
  .option('-t, --threshold <percent>', 'Auto-execute threshold %',
    process.env.MIN_EDGE || '2')
  .option('-s, --scan-threshold <percent>', 'Minimum edge % to show (lower = more opportunities)',
    process.env.SCAN_EDGE || '1.5')
  .option('-a, --auto', 'Auto-execute trades (paper mode only)',
    process.env.AUTO_EXECUTE === 'true')
  .option('-p, --position-size <amount>', 'Max position size in USD',
    process.env.POSITION_SIZE || '1000')
  .option('-s, --sectors <list>', 'Sectors: politics, sports, crypto (comma-separated; default: all)',
    process.env.SECTORS || '')
  .action(async (options) => {
    const interval = parseInt(options.interval) * 1000;
    const scanMinMsRaw = parseInt(process.env.SCAN_MIN_MS || interval, 10);
    const scanMaxMsRaw = parseInt(process.env.SCAN_MAX_MS || Math.max(interval, interval * 2), 10);
    const scanMinMs = Math.max(5000, Math.min(scanMinMsRaw, scanMaxMsRaw));
    const scanMaxMs = Math.max(scanMinMs, scanMaxMsRaw);
    const backoffOn429Ms = Math.max(0, parseInt(process.env.SCAN_BACKOFF_ON_429_MS || '120000', 10));
    const scanMaxBackoffMs = Math.max(0, parseInt(process.env.SCAN_MAX_BACKOFF_MS || '600000', 10));
    const scanCycleTimeoutMs = Math.max(10000, parseInt(process.env.SCAN_CYCLE_TIMEOUT_MS || '120000', 10));
    const strategyRotationEnabled = process.env.STRATEGY_ROTATION === 'true';
    const strategyBatchSize = Math.max(1, Math.min(STRATEGY_COUNT, parseInt(process.env.STRATEGY_BATCH_SIZE || '9', 10)));
    const threshold = parseFloat(options.threshold) / 100;
    const scanThreshold = parseFloat(options.scanThreshold || process.env.SCAN_EDGE || '1') / 100;
    const autoExecute = options.auto;
    const positionSize = parseFloat(options.positionSize);
    const accountId = process.env.ACCOUNT_ID || 'default';
    const sectors = options.sectors
      ? options.sectors.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
      : undefined;
    
    const bot = new PolymarketArbitrageBot({
      mode: 'paper',
      edgeThreshold: threshold,
      scanThreshold,
      maxPositionSize: positionSize,
      sectors,
      dataDir: accountId !== 'default'
        ? path.join(__dirname, 'data', `account-${accountId}`)
        : undefined
    });

    // Initialize learning system and wire edge model for strategy-specific thresholds
    try {
      const dataStore = new DataStore();
      await dataStore.init();
      const edgeModel = new EdgeModel(dataStore, null);
      await edgeModel.init();
      bot.edgeModel = edgeModel;
    } catch (err) {
      console.error(chalk.yellow(`  EdgeModel init failed: ${err.message} — using fixed thresholds`));
    }

    const registry = new StrategyRegistry(bot);
    ALL_STRATEGIES.forEach(s => registry.register(s));

    const edgeScorer = new EdgeScorer();
    await edgeScorer.load();

    const gpu = new GPUClient();
    const gpuHealth = await gpu.checkHealth();
    const gpuAvailable = gpu.available;

    const riskManager = new RiskManager(bot.portfolio);

    // Check Rust latency engine
    let rustEngineStatus = null;
    const rustEngineUrl = process.env.LATENCY_ENGINE_URL || 'http://127.0.0.1:8900';
    try {
      const axios = require('axios');
      const { data } = await axios.get(`${rustEngineUrl}/health`, { timeout: 2000 });
      if (data.status === 'ok') {
        rustEngineStatus = data;
      }
    } catch {}

    // Wire whale tracker into strategy scoring
    let whaleTracker = null;
    if (WhaleTracker && setWhaleTracker) {
      try {
        whaleTracker = new WhaleTracker();
        await whaleTracker.init();
        setWhaleTracker(whaleTracker);
        whaleTracker.startPolling();
      } catch (err) {
        console.error(chalk.yellow(`  Whale tracker init failed: ${err.message} — continuing without`));
        whaleTracker = null;
      }
    }

    // Start Oracle research daemon (runs news, X sentiment, whale tracking on a timer)
    let oracleRunning = false;
    let lastOracleRun = 0;
    const ORACLE_INTERVAL = 10 * 60 * 1000; // 10 minutes
    async function runOracleCycle() {
      if (!oracleModule || oracleRunning) return;
      oracleRunning = true;
      try {
        await oracleModule.runCycle();
        lastOracleRun = Date.now();
      } catch (err) {
        console.error(chalk.red(`  Oracle error: ${err.message}`));
      } finally {
        oracleRunning = false;
      }
    }
    // Fire first Oracle scan (non-blocking)
    if (oracleModule) {
      runOracleCycle();
    }

    const label = accountId !== 'default' ? ` [Account ${accountId}]` : '';
    console.log(chalk.bold(`👁️  POLYMARKET BOT - WATCH MODE${label}\n`));
    console.log(chalk.gray(`Strategies: ${STRATEGY_COUNT} loaded`));
    console.log(chalk.gray(`ML Edge Scorer: loaded (${edgeScorer.trainCount} training samples)`));
    console.log(chalk.gray(`GPU Worker: ${gpuAvailable ? chalk.green('connected') + ' (' + gpu.baseUrl + ')' : chalk.yellow('offline — using local models')}`));
    console.log(chalk.gray(`Risk Manager: Kelly sizing + VaR + circuit breaker active`));
    console.log(chalk.gray(`Whale Tracker: ${whaleTracker ? chalk.green('active') + ` (${whaleTracker.trackedWallets.size} wallets)` : chalk.yellow('not loaded')}`));
    console.log(chalk.gray(`Oracle Daemon: ${oracleModule ? 'active (news + X sentiment + whale tracking)' : 'not loaded'}`));
    console.log(chalk.gray(`Rust Latency Engine: ${rustEngineStatus ? chalk.green('connected') + ` (${rustEngineUrl}, ${rustEngineStatus.paper_mode ? 'paper' : 'LIVE'})` : chalk.yellow('offline — crypto latency arb disabled')}`));
    console.log(chalk.yellow('Paper trading only — no real orders sent'));
    console.log(chalk.gray(`Mode: ${autoExecute ? 'AUTO-EXECUTE' : 'MONITOR ONLY'}`));
    console.log(chalk.gray(`Execute threshold: ${(threshold * 100).toFixed(2)}% (only trades above this execute)`));
    console.log(chalk.gray(`Scan threshold: ${(scanThreshold * 100).toFixed(2)}% (show opportunities above this)`));
    const MAX_HOLD_TIME_DIRECTIONAL = Number(process.env.MAX_HOLD_MINUTES) ? Number(process.env.MAX_HOLD_MINUTES) * 60 * 1000 : 24 * 60 * 60 * 1000; // 24h for directional
    const MAX_HOLD_TIME_RESOLUTION = 30 * 24 * 60 * 60 * 1000; // 30 days for hold-until-resolution
    const TAKE_PROFIT_DIRECTIONAL = 0.02;  // 2% — meaningful take-profit
    const TAKE_PROFIT_ARB = 0.005;         // 0.5% — arb profits are smaller but real
    const STOP_LOSS_DIRECTIONAL = -0.08;   // 8% — give directional bets room to breathe
    const STOP_LOSS_ARB = -0.15;           // 15% — arbs should rarely hit this; if they do, something is wrong
    const STOP_LOSS_EVENT_CATALYST = -0.03; // 3% — tight stop on catalyst trades (historically large losers)
    const TRAILING_DROP = 0.03;            // 3% drop from peak → lock in gains
    const GAS_COST = 0.04;

    console.log(chalk.gray(`Scan cadence: ${(scanMinMs / 1000).toFixed(0)}-${(scanMaxMs / 1000).toFixed(0)}s jittered`));
    console.log(chalk.gray(`Position Size: $${positionSize}`));
    console.log(chalk.gray(`Directional: TP ${(TAKE_PROFIT_DIRECTIONAL*100).toFixed(0)}% / SL ${(STOP_LOSS_DIRECTIONAL*100).toFixed(0)}% / Max hold 24h`));
    console.log(chalk.gray(`Arb/Resolution: TP ${(TAKE_PROFIT_ARB*100).toFixed(1)}% / SL ${(STOP_LOSS_ARB*100).toFixed(0)}% / Hold until resolved (30d max)`));
    console.log(chalk.gray(`429 backoff: +${(backoffOn429Ms / 1000).toFixed(0)}s steps (max ${(scanMaxBackoffMs / 1000).toFixed(0)}s)`));
    console.log(chalk.gray(`Scan timeout: ${(scanCycleTimeoutMs / 1000).toFixed(0)}s per cycle`));
    if (strategyRotationEnabled) {
      console.log(chalk.gray(`Strategy rotation: ON (${strategyBatchSize}/${STRATEGY_COUNT} per cycle)`));
    }
    if (sectors?.length) console.log(chalk.gray(`Sectors: ${sectors.join(', ')}`));
    if (accountId !== 'default') console.log(chalk.gray(`Account: ${accountId}`));

    const priceScanner = new PolymarketScanner({ timeout: 10000 });
    priceScanner.connectWebSocket();
    const flowAnalyzer = new OrderbookImbalanceAnalyzer(priceScanner.clob);
    console.log(chalk.gray('CLOB WebSocket: connecting for real-time prices + orderbook flow analysis'));
    console.log(chalk.gray(`Press Ctrl+C to stop\n`));

    let scanCount = 0, opportunitiesFound = 0, tradesExecuted = 0;
    const strategiesHit = new Map();
    let strategyRotationIndex = 0;
    let dynamicBackoffMs = 0;
    let nextTimer = null;
    let isStopping = false;

    const randomBetween = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
    const setBackoff = (nextBackoffMs) => {
      dynamicBackoffMs = Math.max(0, Math.min(scanMaxBackoffMs, nextBackoffMs));
    };
    const scheduleNextScan = () => {
      if (isStopping) return;
      const baseMs = randomBetween(scanMinMs, scanMaxMs);
      const delayMs = baseMs + dynamicBackoffMs;
      if (dynamicBackoffMs > 0) {
        console.log(chalk.gray(`  Next scan in ${(delayMs / 1000).toFixed(0)}s (${(dynamicBackoffMs / 1000).toFixed(0)}s rate-limit backoff)`));
      }
      nextTimer = setTimeout(async () => {
        await runScan();
        scheduleNextScan();
      }, delayMs);
    };

    const closeArbitrageTrade = async (trade) => {
      const pos = bot.portfolio.positions[trade.marketId];
      if (!pos || pos.status !== 'open') return false;

      try {
        const pData = await priceScanner.fetchMarketPrice(trade.marketId);
        if (!pData) return false;

        const SELL_SLIPPAGE = 0.003;
        const yesVal = pos.yesShares * pData.yesPrice * (1 - SELL_SLIPPAGE);
        const noVal = pos.noShares * pData.noPrice * (1 - SELL_SLIPPAGE);
        const sellValue = yesVal + noVal - GAS_COST;
        const profit = sellValue - pos.entryCost;

        if (profit > 0 || pData.closed || pData.resolved) {
          await bot.closePositionAtMarket(trade.marketId, pData.yesPrice, pData.noPrice);
          trade.realizedPnl = profit;
          trade.closedAt = new Date().toISOString();
          trade.closeMethod = profit > 0 ? 'take-profit' : 'resolved';
          return true;
        }
      } catch {}
      return false;
    };

    const markPositionsToMarket = async () => {
      const portfolio = bot.getPortfolio();
      const openPositions = Object.values(portfolio.positions).filter(p => p.status === 'open');
      if (openPositions.length === 0) return;

      let currentPrices = {};
      try {
        const { fetchMarketsOnce } = require('./strategies/lib/with-scanner');
        const allMarkets = await fetchMarketsOnce();
        for (const m of allMarkets) {
          let prices;
          try {
            prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
          } catch { continue; }
          if (!prices || prices.length < 2) continue;
          currentPrices[m.id] = {
            yesPrice: parseFloat(prices[0]) || 0,
            noPrice: parseFloat(prices[1]) || 0,
            closed: !!m.closed,
            resolved: !!m.resolved,
          };
        }
      } catch { return; }

      const now = Date.now();
      let closed = 0;

      for (const pos of openPositions) {
        const prices = currentPrices[pos.marketId];
        const age = now - new Date(pos.entryTime).getTime();

        if (prices) {
          pos.currentYesPrice = prices.yesPrice;
          pos.currentNoPrice = prices.noPrice;
          pos.lastPriceUpdate = now;
        }

        // Rust engine manages its own positions — skip Node.js P&L management
        if (pos.rustEngine) continue;

        const isHoldToResolution = pos.holdUntilResolution === true ||
          pos.strategy === 'multi-outcome-arb' ||
          pos.strategy === 'correlated-market-arb' ||
          pos.direction === 'BUY_BOTH';

        const isEventCatalyst = pos.strategy === 'event-catalyst';
        const maxHold = isHoldToResolution ? MAX_HOLD_TIME_RESOLUTION : MAX_HOLD_TIME_DIRECTIONAL;
        const takeProfit = isHoldToResolution ? TAKE_PROFIT_ARB : TAKE_PROFIT_DIRECTIONAL;
        const stopLoss = isEventCatalyst ? STOP_LOSS_EVENT_CATALYST
          : isHoldToResolution ? STOP_LOSS_ARB : STOP_LOSS_DIRECTIONAL;

        if (!prices && age < maxHold) continue;

        if (prices) {
          if (prices.closed || prices.resolved) {
            try {
              await bot.closePositionAtMarket(pos.marketId, prices.yesPrice, prices.noPrice);
              const SELL_SLIPPAGE = 0.003;
              const sellValue = (pos.yesShares * prices.yesPrice * (1 - SELL_SLIPPAGE)) + (pos.noShares * prices.noPrice * (1 - SELL_SLIPPAGE)) - GAS_COST;
              const pnl = sellValue - pos.entryCost;
              const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
              console.log(pnlColor(`  Closed ${pos.question?.substring(0, 40)}... ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} [resolved]`));
              closed++;
            } catch {}
            continue;
          }

          const SELL_SLIPPAGE = 0.003;
          const yesValue = pos.yesShares * prices.yesPrice * (1 - SELL_SLIPPAGE);
          const noValue = pos.noShares * prices.noPrice * (1 - SELL_SLIPPAGE);
          const sellValue = yesValue + noValue - GAS_COST;
          const pnlPct = (sellValue - pos.entryCost) / pos.entryCost;

          if (typeof pos.peakPnlPct !== 'number' || pnlPct > pos.peakPnlPct) {
            pos.peakPnlPct = pnlPct;
          }
          const trailingTriggered = pos.peakPnlPct > 0.01 && (pos.peakPnlPct - pnlPct) >= TRAILING_DROP;

          const isBuyBoth = pos.direction === 'BUY_BOTH';
          const priceSum = prices.yesPrice + prices.noPrice;
          const arbConverged = isBuyBoth && priceSum >= 0.995;

          let shouldClose = false;
          let reason = '';

          if (arbConverged) {
            shouldClose = true;
            reason = 'arb-converged';
          } else if (pnlPct >= takeProfit) {
            shouldClose = true;
            reason = 'take-profit';
          } else if (trailingTriggered) {
            shouldClose = true;
            reason = `trailing-stop (peak ${(pos.peakPnlPct * 100).toFixed(1)}%)`;
          } else if (pnlPct <= stopLoss) {
            shouldClose = true;
            reason = 'stop-loss';
          } else if (!isHoldToResolution && age >= maxHold) {
            shouldClose = true;
            reason = 'max-hold';
          } else if (isHoldToResolution && age >= maxHold) {
            shouldClose = true;
            reason = 'max-hold-resolution';
          }

          if (shouldClose) {
            try {
              await bot.closePositionAtMarket(pos.marketId, prices.yesPrice, prices.noPrice);
              const pnl = sellValue - pos.entryCost;
              const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
              console.log(pnlColor(`  Closed ${pos.question?.substring(0, 40)}... ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${(pnlPct * 100).toFixed(1)}%) [${reason}]`));
              closed++;
            } catch {}
          }
        } else if (age >= maxHold) {
          try {
            const estYes = pos.yesShares > 0 ? (pos.entryCost / 2) / pos.yesShares : 0.5;
            const estNo = pos.noShares > 0 ? (pos.entryCost / 2) / pos.noShares : 0.5;
            await bot.closePositionAtMarket(pos.marketId, estYes * 0.98, estNo * 0.98);
            console.log(chalk.yellow(`  Force-closed ${pos.question?.substring(0, 40)}... (no price data)`));
            closed++;
          } catch {}
        }
      }
      if (closed > 0) console.log(chalk.cyan(`  ${closed} position(s) closed on price movement`));
      bot.updatePnL(currentPrices);
      await bot.savePortfolio();
    };

    const runScan = async () => {
      scanCount++;
      const timestamp = new Date().toLocaleTimeString();

      // Trigger Oracle daemon every 10 minutes (non-blocking)
      if (oracleModule && Date.now() - lastOracleRun > ORACLE_INTERVAL) {
        runOracleCycle();
      }

      try {
        await markPositionsToMarket();

        process.stdout.write(chalk.gray(`[${timestamp}] Scan #${scanCount} (${STRATEGY_COUNT} strategies)... `));

        let scanFilters = {};
        if (strategyRotationEnabled) {
          const allNames = ALL_STRATEGIES.map(s => s.name);
          const selected = [];
          for (let i = 0; i < strategyBatchSize; i++) {
            selected.push(allNames[(strategyRotationIndex + i) % allNames.length]);
          }
          strategyRotationIndex = (strategyRotationIndex + strategyBatchSize) % allNames.length;
          scanFilters = { strategyNames: selected };
          console.log(chalk.gray(`  Rotating strategies: ${selected.length} selected`));
        }

        const opportunities = await Promise.race([
          registry.scanAll(scanFilters),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Scan cycle timed out after ${Math.round(scanCycleTimeoutMs / 1000)}s`)), scanCycleTimeoutMs))
        ]);
        const scanMeta = registry.lastScanMeta || { failedStrategies: 0, rateLimitHits: 0 };
        if (scanMeta.rateLimitHits > 0) {
          const jitter = Math.floor(Math.random() * Math.max(1, backoffOn429Ms));
          setBackoff(dynamicBackoffMs + backoffOn429Ms + jitter);
          console.log(chalk.yellow(`  429s detected in ${scanMeta.rateLimitHits} strategy scan(s); applying backoff`));
        } else if (dynamicBackoffMs > 0) {
          // Gradually relax backoff once scans stop hitting rate limits.
          setBackoff(dynamicBackoffMs - Math.floor(backoffOn429Ms / 2));
        }

        const seen = new Set();
        const unique = [];
        for (const opp of opportunities) {
          if (!opp.bypassThreshold && opp.edgePercent < scanThreshold) continue;
          if (seen.has(opp.marketId)) continue;
          seen.add(opp.marketId);
          unique.push(opp);
        }

        if (unique.length === 0) {
          console.log(chalk.gray('No opportunities'));
          return;
        }

        // ML Edge Scorer: re-rank by predicted win probability
        const mlRanked = edgeScorer.rerank(unique);

        // GPU Deep Learning: if PC worker is available, overlay neural net predictions
        let gpuRanked = mlRanked;
        if (await gpu.isAvailable()) {
          try {
            const gpuPredictions = await gpu.predictEdge(mlRanked);
            if (gpuPredictions) {
              gpuRanked = gpuPredictions;
              console.log(chalk.cyan(`  GPU: deep-learning rerank applied (${gpuPredictions.length} scored)`));
            }
          } catch (e) { /* GPU unavailable, continue with local */ }
        }

        // Orderbook Flow Analysis: adjust edges based on bid/ask imbalance
        const ranked = flowAnalyzer.enrichOpportunities(gpuRanked);

        opportunitiesFound += ranked.length;
        console.log(chalk.green(`${ranked.length} opportunity(s) found!`));

        // Update risk manager with latest portfolio state
        riskManager.update(bot.portfolio);
        const riskStatus = riskManager.getStatus();
        if (riskStatus.paused) {
          console.log(chalk.red(`  ⚠ Risk: ${riskStatus.pauseReason} — skipping execution`));
        }

        ranked.forEach(opp => {
          const edgeColor = opp.edgePercent >= 0.10 ? chalk.green : chalk.yellow;
          const strat = opp.strategy || 'basic-arbitrage';
          const hit = strategiesHit.get(strat) || 0;
          strategiesHit.set(strat, hit + 1);
          const mlTag = opp.mlScore != null ? ` ML:${(opp.mlScore * 100).toFixed(0)}%` : '';
          const flowTag = opp.flowSignal && opp.flowSignal !== 'neutral' ? ` Flow:${opp.flowSignal}` : '';
          console.log(chalk.gray(`  └─ [${strat}] ${(opp.question || '').substring(0, 40)}... `) + edgeColor(`${(opp.edgePercent * 100).toFixed(2)}% edge${mlTag}${flowTag}`));
        });

        if (autoExecute && !riskStatus.paused) {
          // Apply risk manager sizing to each opportunity before execution
          for (const opp of ranked) {
            if (opp.rustEngine) continue; // Rust engine manages its own risk
            const riskCheck = riskManager.check(opp, opp.maxPosition || positionSize);
            if (!riskCheck.allowed) {
              opp._riskBlocked = riskCheck.reason;
              continue;
            }
            opp.maxPosition = riskCheck.suggestedSize;
          }

          const executable = ranked.filter(o => !o._riskBlocked);
          const result = await bot.autoExecute(executable, { minEdge: threshold, maxTradesPerCycle: 5 });
          tradesExecuted += result.executed.length;

          for (const trade of result.executed) {
            const locked = await closeArbitrageTrade(trade);
            if (locked) {
              console.log(chalk.green(`  Instant close: ${trade.realizedPnl >= 0 ? '+' : ''}$${(trade.realizedPnl || 0).toFixed(2)} on ${(trade.question || '').substring(0, 35)}... [${trade.closeMethod}]`));
            } else {
              console.log(chalk.blue(`  Opened: ${trade.direction} ${(trade.question || '').substring(0, 40)}... $${trade.totalCost.toFixed(2)}`));
            }
          }

          if (result.skipped.length > 0) console.log(chalk.yellow(`  Skipped ${result.skipped.length}`));

          // Train ML model on any newly closed trades
          const closedTrades = bot.portfolio.trades.filter(t => t.realizedPnl != null);
          if (closedTrades.length > edgeScorer.trainCount) {
            const newClosed = closedTrades.slice(edgeScorer.trainCount);
            for (const t of newClosed) {
              await edgeScorer.train(t);
              riskManager.recordClosedTrade(t.realizedPnl, t.strategy);
            }
            if (newClosed.length > 0) {
              console.log(chalk.magenta(`  ML: trained on ${newClosed.length} new trade(s) (total: ${edgeScorer.trainCount})`));
              // Also train the GPU neural net if available
              gpu.trainEdge(newClosed).catch(() => {});
            }
          }

          const riskStatusPost = riskManager.getStatus();
          if (riskStatusPost.pausedStrategies && riskStatusPost.pausedStrategies.length > 0) {
            for (const ps of riskStatusPost.pausedStrategies) {
              console.log(chalk.red(`  ⚠ Strategy auto-paused: ${ps.name} (${ps.winRate} win rate over ${ps.trades} trades)`));
            }
          }
        }

      } catch (error) {
        console.error(chalk.red(` Error: ${error.message}`));
        if ((error.message || '').includes('429')) {
          const jitter = Math.floor(Math.random() * Math.max(1, backoffOn429Ms));
          setBackoff(dynamicBackoffMs + backoffOn429Ms + jitter);
        }
      }
    };

    await runScan();
    scheduleNextScan();

    process.on('SIGINT', () => {
      isStopping = true;
      if (nextTimer) clearTimeout(nextTimer);
      if (whaleTracker) whaleTracker.stopPolling();
      console.log(chalk.bold(`\n\n📊 WATCH SUMMARY${label}`));
      console.log(chalk.gray(`Total scans: ${scanCount}`));
      console.log(chalk.gray(`Strategies: ${STRATEGY_COUNT}`));
      console.log(chalk.gray(`Opportunities found: ${opportunitiesFound}`));
      if (strategiesHit.size > 0) {
        console.log(chalk.gray('By strategy:'));
        for (const [strat, count] of [...strategiesHit.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(chalk.gray(`  ${strat}: ${count}`));
        }
      }
      if (autoExecute) console.log(chalk.gray(`Trades executed: ${tradesExecuted}`));
      console.log(chalk.yellow('\n👋 Stopped watching'));
      process.exit(0);
    });
  });

// SERVER COMMAND
program
  .command('server')
  .description('Start API + WebSocket server')
  .option('-p, --port <port>', 'Server port', '3001')
  .option('--ws-port <port>', 'WebSocket port', '8080')
  .action(async (options) => {
    const port = parseInt(options.port);
    const wsPort = parseInt(options.wsPort);
    
    console.log(chalk.bold('🚀 POLYMARKET ARBITRAGE BOT - SERVER\n'));
    
    // Start WebSocket server
    const wsServer = new WebSocketServer({ port: wsPort });
    await wsServer.start();
    console.log(chalk.green(`✓ WebSocket server started on port ${wsPort}`));
    
    // Start API server
    const app = createApiServer(wsServer);
    const bindHost = process.env.BIND_HOST || '0.0.0.0';
    app.listen(port, bindHost, () => {
      console.log(chalk.green(`✓ API server started on ${bindHost}:${port}`));
      console.log(chalk.gray(`\nEndpoints:`));
      console.log(chalk.gray(`  - API: http://localhost:${port}/api`));
      console.log(chalk.gray(`  - Health: http://localhost:${port}/health`));
      console.log(chalk.gray(`  - WebSocket: ws://localhost:${wsPort}`));
      if (bindHost === '127.0.0.1') console.log(chalk.cyan(`  🔒 Bound to localhost only — no network exposure`));
      console.log(chalk.yellow(`\nPress Ctrl+C to stop\n`));
    });
    
    // Start market scanning in background
    const scanner = new PolymarketScanner({ edgeThreshold: 0.05 });
    setInterval(async () => {
      try {
        const opportunities = await scanner.quickScan(0.05);
        if (opportunities.length > 0) {
          wsServer.broadcast('opportunities', opportunities);
        }
      } catch (err) {
        // Silent fail
      }
    }, 30000);
  });

// DASHBOARD COMMAND
program
  .command('dashboard')
  .description('Serve React dashboard (requires build first)')
  .option('-p, --port <port>', 'Dashboard port', '3000')
  .action(async (options) => {
    const port = parseInt(options.port);
    const express = require('express');
    const app = express();
    
    const distPath = path.join(__dirname, 'dist');
    
    if (!fs.existsSync(distPath)) {
      console.log(chalk.red('❌ Build not found. Run `npm run build` first.'));
      process.exit(1);
    }
    
    // Serve static files
    app.use(express.static(distPath));
    
    // API routes (mount full app at root so /api/* routes match)
    app.use(createApiServer());
    
    // Serve React app for all other routes
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    
    console.log(chalk.bold('📊 POLYMARKET ARBITRAGE BOT - DASHBOARD\n'));
    
    const dashHost = process.env.BIND_HOST || '0.0.0.0';
    app.listen(port, dashHost, () => {
      console.log(chalk.green(`✓ Dashboard running at http://localhost:${port}`));
      if (dashHost === '127.0.0.1') console.log(chalk.cyan(`  🔒 Bound to localhost only — no network exposure`));
      console.log(chalk.gray(`\nPress Ctrl+C to stop\n`));
    });
  });

// EXECUTE COMMAND
program
  .command('execute')
  .description('Execute a specific arbitrage opportunity')
  .argument('<market-id>', 'Market ID to trade')
  .option('-s, --size <amount>', 'Position size in USD', '100')
  .action(async (marketId, options) => {
    try {
      const scanner = new PolymarketScanner();
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });

      console.log(chalk.bold(`🔍 Looking up market ${marketId}...`));
      
      const markets = await scanner.fetchMarkets();
      const market = markets.find(m => m.id === marketId || m.slug === marketId);
      
      if (!market) {
        console.error(chalk.red(`❌ Market not found: ${marketId}`));
        process.exit(1);
      }

      const opportunity = scanner.calculateArbitrage(market);
      
      if (!opportunity) {
        console.error(chalk.red(`❌ No arbitrage opportunity detected for this market`));
        process.exit(1);
      }

      if (opportunity.edgePercent < bot.edgeThreshold) {
        console.log(chalk.yellow(`⚠️ Edge ${(opportunity.edgePercent * 100).toFixed(2)}% below threshold ${(bot.edgeThreshold * 100).toFixed(2)}%`));
        process.exit(1);
      }

      const size = parseFloat(options.size);
      
      console.log(chalk.bold('\n💰 OPPORTUNITY DETAILS:'));
      console.log(`Market: ${opportunity.question}`);
      console.log(`Edge: ${chalk.green(`${(opportunity.edgePercent * 100).toFixed(2)}%`)}`);
      console.log(`Direction: ${opportunity.direction}`);
      console.log(`Position Size: $${size.toFixed(2)}`);
      console.log(`Expected Profit: $${(size * opportunity.edgePercent).toFixed(2)}`);

      console.log(chalk.yellow('\n⚠️  Press Enter to execute (Ctrl+C to cancel)...'));
      
      process.stdin.once('data', async () => {
        try {
          const trade = await bot.execute(opportunity, { size });
          
          console.log(chalk.green('\n✅ TRADE EXECUTED'));
          console.log(chalk.gray(`Trade ID: ${trade.id}`));
          console.log(chalk.gray(`YES Shares: ${trade.yesShares.toFixed(4)} @ $${trade.yesPrice.toFixed(3)}`));
          console.log(chalk.gray(`NO Shares: ${trade.noShares.toFixed(4)} @ $${trade.noPrice.toFixed(3)}`));
          console.log(chalk.gray(`Total Cost: $${trade.totalCost.toFixed(2)}`));
          console.log(chalk.green(`Expected Profit: $${trade.expectedProfit.toFixed(2)}`));
          
          process.exit(0);
        } catch (error) {
          console.error(chalk.red(`\n❌ Execution failed: ${error.message}`));
          process.exit(1);
        }
      });

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// REPORT COMMAND
program
  .command('report')
  .description('Generate P&L and performance report')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
      const report = await bot.generateReport();

      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(chalk.bold('📊 POLYMARKET ARBITRAGE BOT - PERFORMANCE REPORT\n'));
      console.log(chalk.gray(`Mode: ${report.mode.toUpperCase()}`));
      console.log(chalk.gray(`Generated: ${new Date(report.generatedAt).toLocaleString()}\n`));

      console.log(chalk.bold('💼 PORTFOLIO:'));
      console.log(`  Cash: $${report.portfolio.cash.toFixed(2)}`);
      console.log(`  Initial: $${report.portfolio.initialCash.toLocaleString()}`);
      console.log(`  Total Return: ${report.portfolio.totalReturn.startsWith('-') ? chalk.red(report.portfolio.totalReturn) : chalk.green(report.portfolio.totalReturn)}`);
      console.log(`  Open Positions: ${report.portfolio.openPositions}`);
      console.log(`  Closed Positions: ${report.portfolio.closedPositions}\n`);

      console.log(chalk.bold('📈 P&L:'));
      console.log(`  Realized: $${report.pnl.realized.toFixed(2)}`);
      console.log(`  Unrealized: $${report.pnl.unrealized.toFixed(2)}`);
      console.log(`  Total: ${report.pnl.total >= 0 ? chalk.green(`+$${report.pnl.total.toFixed(2)}`) : chalk.red(`-$${Math.abs(report.pnl.total).toFixed(2)}`)}\n`);

      console.log(chalk.bold('🎯 PERFORMANCE:'));
      console.log(`  Total Trades: ${report.performance.totalTrades}`);
      console.log(`  Win Rate: ${report.performance.winRate}`);
      console.log(`  Avg Win: $${report.performance.avgWin}`);
      console.log(`  Avg Loss: $${report.performance.avgLoss}`);
      console.log(`  Profit Factor: ${report.performance.profitFactor}\n`);

      if (report.recentTrades.length > 0) {
        console.log(chalk.bold('📝 RECENT TRADES:'));
        report.recentTrades.forEach((trade, i) => {
          const pnl = trade.realizedPnl || trade.expectedProfit;
          const pnlColor = pnl >= 0 ? chalk.green : chalk.red;
          console.log(`  ${i + 1}. ${trade.question.substring(0, 40)}... ${pnlColor(pnl >= 0 ? `+$${pnl.toFixed(2)}` : `-$${Math.abs(pnl).toFixed(2)}`)}`);
        });
      }

    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// RESET COMMAND
program
  .command('reset')
  .description('Reset paper trading portfolio')
  .action(async () => {
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
      await bot.reset();
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// STRATEGIES COMMAND
program
  .command('strategies')
  .description('List all available strategies')
  .action(async () => {
    const { ALL_STRATEGIES } = require('./strategies');
    console.log(chalk.bold(`\n🧠 AVAILABLE STRATEGIES (${ALL_STRATEGIES.length} total)\n`));

    ALL_STRATEGIES.forEach((s, i) => {
      const riskColor = s.riskLevel === 'low' ? chalk.green : s.riskLevel === 'medium' ? chalk.yellow : chalk.red;
      console.log(`${String(i + 1).padStart(2)}. ${chalk.bold(s.name)} ${chalk.gray(`(${s.type})`)}`);
      console.log(`    Risk: ${riskColor(s.riskLevel)}\n`);
    });

    console.log(chalk.gray('Scan uses all strategies; filter by type/risk in code or API.'));
  });

// MULTI-ACCOUNT COMMANDS

// MULTI-START COMMAND
program
  .command('multi-start')
  .description('Start multi-account paper trading (A/B testing)')
  .option('-d, --days <days>', 'Number of days to run', '1')
  .option('-i, --interval <seconds>', 'Scan interval in seconds', '30')
  .option('--no-optimizer', 'Disable auto-optimizer')
  .action(async (options) => {
    const MultiAccountManager = require('./accounts/manager');
    const PolymarketScanner = require('./scanner');
    const AutoOptimizer = require('./optimizer/engine');
    
    const manager = new MultiAccountManager();
    const scanner = new PolymarketScanner();
    const optimizer = options.optimizer !== false ? new AutoOptimizer() : null;
    
    await manager.init();
    if (optimizer) await optimizer.init();
    
    const days = parseInt(options.days);
    const interval = parseInt(options.interval) * 1000;
    const endTime = Date.now() + (days * 24 * 60 * 60 * 1000);
    
    console.log(chalk.bold('\n🚀 MULTI-ACCOUNT PAPER TRADING\n'));
    console.log(chalk.gray(`Duration: ${days} day(s)`));
    console.log(chalk.gray(`Scan interval: ${options.interval}s`));
    console.log(chalk.gray(`Auto-optimizer: ${optimizer ? 'ENABLED' : 'DISABLED'}\n`));
    
    // Display initial status
    const comparison = manager.getComparisonData();
    console.log(chalk.bold('📊 INITIAL STATUS:\n'));
    console.log(`  Aggressive:  $${comparison.aggressive.cash.toFixed(2)} | Conservative:  $${comparison.conservative.cash.toFixed(2)}`);
    console.log(`  Min Edge:    3%          | Min Edge:      8%`);
    console.log(`  Max Pos:     $500        | Max Pos:       $200`);
    console.log(`  Strategies:  4           | Strategies:    4\n`);
    
    let scanCount = 0;
    let totalTrades = { aggressive: 0, conservative: 0 };
    
    const runScan = async () => {
      if (Date.now() > endTime) {
        console.log(chalk.yellow('\n⏰ Time limit reached. Stopping...'));
        return false;
      }
      
      scanCount++;
      const timestamp = new Date().toLocaleTimeString();
      
      try {
        process.stdout.write(chalk.gray(`[${timestamp}] Scan #${scanCount}... `));
        
        // Scan for opportunities
        const opportunities = await scanner.quickScan(0.03); // Use lowest threshold
        
        if (opportunities.length === 0) {
          console.log(chalk.gray('No opportunities'));
          return true;
        }
        
        console.log(chalk.green(`${opportunities.length} opportunity(s)`));
        
        // Try to execute for both accounts
        for (const opp of opportunities) {
          // Add strategy tag based on opportunity characteristics
          if (opp.edgePercent >= 0.08) {
            opp.strategy = 'high-edge';
          } else if (opp.liquidity > 10000) {
            opp.strategy = 'liquid';
          } else {
            opp.strategy = 'standard';
          }
          
          // Try aggressive account
          const aggResult = await manager.executeTrade('aggressive', opp);
          if (aggResult.success) {
            totalTrades.aggressive++;
            console.log(chalk.red(`  [AGG] ${opp.question.substring(0, 40)}... ${(opp.edgePercent * 100).toFixed(1)}% edge | $${aggResult.trade.positionSize}`));
          }
          
          // Try conservative account
          const conResult = await manager.executeTrade('conservative', opp);
          if (conResult.success) {
            totalTrades.conservative++;
            console.log(chalk.blue(`  [CON] ${opp.question.substring(0, 40)}... ${(opp.edgePercent * 100).toFixed(1)}% edge | $${conResult.trade.positionSize}`));
          }
        }
        
        // Run optimizer periodically
        if (optimizer && scanCount % 10 === 0) {
          const aggAccount = manager.getAccount('aggressive');
          const conAccount = manager.getAccount('conservative');
          
          const aggAnalysis = optimizer.analyzePerformance({
            accountId: 'aggressive',
            trades: aggAccount.portfolio.trades,
            metrics: aggAccount.metrics
          });
          
          if (aggAnalysis.recommendations.length > 0) {
            console.log(chalk.yellow(`  🤖 Optimizer: ${aggAnalysis.recommendations.length} recommendations for Aggressive`));
          }
        }
        
      } catch (error) {
        console.error(chalk.red(` Error: ${error.message}`));
      }
      
      return true;
    };
    
    // Run first scan
    let shouldContinue = await runScan();
    
    // Set up interval
    const intervalId = setInterval(async () => {
      if (!shouldContinue) {
        clearInterval(intervalId);
        return;
      }
      shouldContinue = await runScan();
    }, interval);
    
    // Handle shutdown
    process.on('SIGINT', async () => {
      clearInterval(intervalId);
      
      console.log(chalk.bold('\n\n📊 FINAL RESULTS\n'));
      
      const finalComparison = manager.getComparisonData();
      
      console.log(chalk.bold('Account Summary:'));
      console.log(`  Aggressive:   $${finalComparison.aggressive.totalValue.toFixed(2)} (${finalComparison.aggressive.totalReturn.toFixed(2)}%) | ${finalComparison.aggressive.totalTrades} trades`);
      console.log(`  Conservative: $${finalComparison.conservative.totalValue.toFixed(2)} (${finalComparison.conservative.totalReturn.toFixed(2)}%) | ${finalComparison.conservative.totalTrades} trades`);
      
      const winner = finalComparison.aggressive.totalValue > finalComparison.conservative.totalValue ? 'Aggressive' : 'Conservative';
      const diff = Math.abs(finalComparison.aggressive.totalValue - finalComparison.conservative.totalValue);
      
      console.log(chalk.bold(`\n🏆 Winner: ${winner} (+$${diff.toFixed(2)})`));
      console.log(chalk.gray(`\nTotal scans: ${scanCount}`));
      console.log(chalk.gray(`Total trades: ${totalTrades.aggressive + totalTrades.conservative}`));
      
      console.log(chalk.yellow('\n👋 Stopping multi-account trading\n'));
      process.exit(0);
    });
  });

// COMPARE COMMAND
program
  .command('compare')
  .description('View side-by-side account comparison')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const MultiAccountManager = require('./accounts/manager');
      const CombinedReporting = require('./reports/combined');
      
      const manager = new MultiAccountManager();
      const reporting = new CombinedReporting();
      
      await manager.init();
      await reporting.init();
      
      const report = await reporting.generateReport(manager);
      
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      
      console.log(chalk.bold('\n📊 A/B STRATEGY COMPARISON\n'));
      console.log(chalk.gray(`Generated: ${new Date(report.generatedAt).toLocaleString()}`));
      console.log(chalk.gray(`Period: ${report.period.days} days\n`));
      
      // Summary
      console.log(chalk.bold('💰 COMBINED SUMMARY:'));
      console.log(`  Total Value: $${report.summary.combinedValue.toFixed(2)}`);
      console.log(`  Total Return: ${report.summary.combinedReturn >= 0 ? chalk.green('+') : chalk.red()}${report.summary.combinedReturn.toFixed(2)}%`);
      console.log(`  Total Trades: ${report.summary.totalTrades}`);
      console.log(`  Open Positions: ${report.summary.openPositions}\n`);
      
      // Comparison Table
      console.log(chalk.bold('📈 SIDE-BY-SIDE COMPARISON:\n'));
      console.log(chalk.gray('  Metric              | Aggressive      | Conservative    | Winner'));
      console.log(chalk.gray('  ────────────────────┼─────────────────┼─────────────────┼──────────'));
      
      report.comparison.metrics.forEach(m => {
        const winner = m.winner ? (m.winner === 'aggressive' ? 'Agg' : m.winner === 'conservative' ? 'Con' : 'Tie') : '-';
        const wColor = m.winner === 'aggressive' ? chalk.red : m.winner === 'conservative' ? chalk.blue : chalk.gray;
        console.log(`  ${m.metric.padEnd(19)} | ${m.aggressive.toString().padEnd(15)} | ${m.conservative.toString().padEnd(15)} | ${wColor(winner)}`);
      });
      
      // Overall Winner
      console.log(chalk.bold(`\n🏆 Overall Winner: ${report.comparison.overallWinner.winner.toUpperCase()} (${report.comparison.overallWinner.score})`));
      
      // Insights
      if (report.comparison.keyInsights.length > 0) {
        console.log(chalk.bold('\n💡 Key Insights:'));
        report.comparison.keyInsights.forEach(insight => {
          console.log(`  • ${insight}`);
        });
      }
      
      // Strategy Performance
      if (report.strategies.strategies.length > 0) {
        console.log(chalk.bold('\n🧠 Strategy Performance:'));
        report.strategies.strategies.forEach(s => {
          const winRate = s.totalTrades > 0 ? (s.totalWins / s.totalTrades * 100).toFixed(1) : 0;
          const pnlColor = s.totalPnl >= 0 ? chalk.green : chalk.red;
          console.log(`  ${s.name.padEnd(20)} | Trades: ${s.totalTrades.toString().padEnd(3)} | Win: ${winRate}% | PnL: ${pnlColor('$' + s.totalPnl.toFixed(2))}`);
        });
      }
      
      // Recommendations
      if (report.recommendations.length > 0) {
        console.log(chalk.bold('\n🎯 Recommendations:'));
        report.recommendations.forEach(rec => {
          console.log(`  [${rec.type.toUpperCase()}] ${rec.action} (${rec.confidence} confidence)`);
        });
      }
      
      console.log('');
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// OPTIMIZE COMMAND
program
  .command('optimize')
  .description('Run auto-optimizer and apply recommendations')
  .option('--dry-run', 'Show recommendations without applying')
  .action(async (options) => {
    try {
      const MultiAccountManager = require('./accounts/manager');
      const AutoOptimizer = require('./optimizer/engine');
      
      const manager = new MultiAccountManager();
      const optimizer = new AutoOptimizer();
      
      await manager.init();
      await optimizer.init();
      
      console.log(chalk.bold('\n🤖 AUTO-OPTIMIZER\n'));
      
      const accounts = ['aggressive', 'conservative'];
      
      for (const accountId of accounts) {
        const account = manager.getAccount(accountId);
        
        console.log(chalk.bold(`${accountId.toUpperCase()} ACCOUNT:`));
        console.log(`  Trades: ${account.metrics.totalTrades} | Win Rate: ${account.metrics.winRate}% | PnL: $${account.metrics.totalPnl.toFixed(2)}`);
        
        const analysis = optimizer.analyzePerformance({
          accountId,
          trades: account.portfolio.trades,
          metrics: account.metrics
        });
        
        if (analysis.recommendations.length === 0) {
          console.log(chalk.gray('  No recommendations at this time\n'));
          continue;
        }
        
        console.log(chalk.yellow(`  ${analysis.recommendations.length} recommendation(s) found:`));
        
        analysis.recommendations.forEach((rec, i) => {
          console.log(`    ${i + 1}. ${rec.type}: ${rec.reason}`);
          if (rec.current !== undefined) {
            console.log(`       Current: ${rec.current} → Recommended: ${rec.recommended} (confidence: ${(rec.confidence * 100).toFixed(0)}%)`);
          }
        });
        
        if (!options.dryRun) {
          const result = await optimizer.applyRecommendations(accountId, analysis.recommendations);
          console.log(chalk.green(`  Applied: ${result.applied.length} | Rejected: ${result.rejected.length}`));
        }
        
        console.log('');
      }
      
      if (options.dryRun) {
        console.log(chalk.gray('Dry run mode - no changes applied'));
      }
      
      console.log('');
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// EXPORT COMMAND
program
  .command('export')
  .description('Export multi-account data for analysis')
  .option('-f, --format <format>', 'Export format (json, csv)', 'json')
  .action(async (options) => {
    try {
      const MultiAccountManager = require('./accounts/manager');
      const CombinedReporting = require('./reports/combined');
      
      const manager = new MultiAccountManager();
      const reporting = new CombinedReporting();
      
      await manager.init();
      await reporting.init();
      
      const report = await reporting.generateReport(manager);
      const result = await reporting.exportReport(report, options.format);
      
      console.log(chalk.bold('\n📤 EXPORT COMPLETE\n'));
      console.log(`Format: ${options.format.toUpperCase()}`);
      console.log(`File: ${result.filepath}`);
      console.log(`Data points: ${report.summary.totalTrades} trades\n`);
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

// MULTI-RESET COMMAND
program
  .command('multi-reset')
  .description('Reset both paper trading accounts')
  .option('-a, --account <account>', 'Reset specific account (aggressive, conservative, or both)', 'both')
  .action(async (options) => {
    try {
      const MultiAccountManager = require('./accounts/manager');
      const manager = new MultiAccountManager();
      await manager.init();
      
      console.log(chalk.bold('\n🔄 RESET MULTI-ACCOUNT\n'));
      
      if (options.account === 'both') {
        await manager.resetAll();
        console.log(chalk.green('✅ Both accounts reset to $10,000'));
      } else {
        await manager.resetAccount(options.account);
        console.log(chalk.green(`✅ ${options.account} account reset to $10,000`));
      }
      
      console.log('');
      
    } catch (error) {
      console.error(chalk.red(`❌ Error: ${error.message}`));
      process.exit(1);
    }
  });

program.parse();
