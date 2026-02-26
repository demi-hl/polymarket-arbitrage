#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const fs = require('fs');

// Core components
const PolymarketScanner = require('./scanner');
const PolymarketArbitrageBot = require('./bot');
const WebSocketServer = require('./server/websocket');
const createApiServer = require('./server/api');

const program = new Command();

program
  .name('polymarket')
  .description('Polymarket Arbitrage Bot - Professional trading system')
  .version('2.0.0');

program
  .option('-m, --mode <mode>', 'Trading mode: paper or live', 'paper')
  .option('-e, --edge <percent>', 'Edge threshold percentage', '5')
  .option('-c, --cash <amount>', 'Initial cash for paper trading', '10000');

// SCAN COMMAND
program
  .command('scan')
  .description('Scan Polymarket for arbitrage opportunities')
  .option('-t, --threshold <percent>', 'Minimum edge threshold %', '5')
  .option('-l, --liquidity <amount>', 'Minimum liquidity USD', '1000')
  .option('-j, --json', 'Output as JSON')
  .action(async (options) => {
    try {
      const threshold = parseFloat(options.threshold) / 100;
      const minLiquidity = parseFloat(options.liquidity);
      
      const scanner = new PolymarketScanner({ minLiquidity, edgeThreshold: threshold });
      const result = await scanner.scan({ threshold });
      
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      console.log(chalk.bold('\n📊 SCAN RESULTS'));
      console.log(chalk.gray(`Time: ${new Date(result.timestamp).toLocaleString()}`));
      console.log(chalk.gray(`Markets scanned: ${result.marketsScanned}`));
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
  .option('-i, --interval <seconds>', 'Scan interval in seconds', '30')
  .option('-t, --threshold <percent>', 'Auto-execute threshold %', '5')
  .option('-a, --auto', 'Auto-execute trades (paper mode only)', false)
  .action(async (options) => {
    const interval = parseInt(options.interval) * 1000;
    const threshold = parseFloat(options.threshold) / 100;
    const autoExecute = options.auto;
    
    const scanner = new PolymarketScanner({ edgeThreshold: threshold });
    const bot = new PolymarketArbitrageBot({ mode: 'paper', edgeThreshold: threshold });

    console.log(chalk.bold('👁️  POLYMARKET ARBITRAGE BOT - WATCH MODE\n'));
    console.log(chalk.gray(`Mode: ${autoExecute ? 'AUTO-EXECUTE' : 'MONITOR ONLY'}`));
    console.log(chalk.gray(`Threshold: ${(threshold * 100).toFixed(2)}%`));
    console.log(chalk.gray(`Interval: ${options.interval}s`));
    console.log(chalk.gray(`Press Ctrl+C to stop\n`));

    let scanCount = 0, opportunitiesFound = 0, tradesExecuted = 0;

    const runScan = async () => {
      scanCount++;
      const timestamp = new Date().toLocaleTimeString();
      
      try {
        process.stdout.write(chalk.gray(`[${timestamp}] Scan #${scanCount}... `));
        
        const opportunities = await scanner.quickScan(threshold);
        
        if (opportunities.length === 0) {
          console.log(chalk.gray('No opportunities'));
          return;
        }

        opportunitiesFound += opportunities.length;
        console.log(chalk.green(`${opportunities.length} opportunity(s) found!`));

        opportunities.forEach(opp => {
          const edgeColor = opp.edgePercent >= 0.10 ? chalk.green : chalk.yellow;
          console.log(chalk.gray(`  └─ ${opp.question.substring(0, 50)}... `) + edgeColor(`${(opp.edgePercent * 100).toFixed(2)}% edge`));
        });

        if (autoExecute) {
          const result = await bot.autoExecute(opportunities, { minEdge: threshold });
          tradesExecuted += result.executed.length;
          if (result.executed.length > 0) console.log(chalk.green(`  ✅ Executed ${result.executed.length} trade(s)`));
          if (result.skipped.length > 0) console.log(chalk.yellow(`  ⏭️ Skipped ${result.skipped.length}`));
        }

      } catch (error) {
        console.error(chalk.red(` Error: ${error.message}`));
      }
    };

    await runScan();
    const intervalId = setInterval(runScan, interval);

    process.on('SIGINT', () => {
      clearInterval(intervalId);
      console.log(chalk.bold('\n\n📊 WATCH SUMMARY'));
      console.log(chalk.gray(`Total scans: ${scanCount}`));
      console.log(chalk.gray(`Opportunities found: ${opportunitiesFound}`));
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
    app.listen(port, () => {
      console.log(chalk.green(`✓ API server started on port ${port}`));
      console.log(chalk.gray(`\nEndpoints:`));
      console.log(chalk.gray(`  - API: http://localhost:${port}/api`));
      console.log(chalk.gray(`  - Health: http://localhost:${port}/health`));
      console.log(chalk.gray(`  - WebSocket: ws://localhost:${wsPort}`));
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
    
    // API routes
    const apiRouter = createApiServer();
    app.use('/api', apiRouter);
    
    // Serve React app for all other routes
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
    
    console.log(chalk.bold('📊 POLYMARKET ARBITRAGE BOT - DASHBOARD\n'));
    
    app.listen(port, () => {
      console.log(chalk.green(`✓ Dashboard running at http://localhost:${port}`));
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
    console.log(chalk.bold('\n🧠 AVAILABLE STRATEGIES\n'));
    
    const strategies = [
      { name: 'basic-arbitrage', type: 'fundamental', risk: 'low', desc: 'YES+NO sum arbitrage' },
      { name: 'cross-market', type: 'fundamental', risk: 'low', desc: 'Polymarket vs Kalshi/PredictIt' },
      { name: 'temporal-arbitrage', type: 'event', risk: 'medium', desc: 'Time-based mispricing' },
      { name: 'correlation-arbitrage', type: 'statistical', risk: 'medium', desc: 'Related market mispricing' },
      { name: 'whale-tracker', type: 'flow', risk: 'medium', desc: 'Follow large orders' },
      { name: 'resolution-arbitrage', type: 'event', risk: 'low', desc: 'Resolution certainty edge' },
      { name: 'orderbook-scalper', type: 'micro', risk: 'high', desc: 'Micro-spread scalping' },
      { name: 'news-sentiment', type: 'event', risk: 'high', desc: 'News-driven opportunities' },
    ];
    
    strategies.forEach((s, i) => {
      const riskColor = s.risk === 'low' ? chalk.green : s.risk === 'medium' ? chalk.yellow : chalk.red;
      console.log(`${i + 1}. ${chalk.bold(s.name)} ${chalk.gray(`(${s.type})`)}`);
      console.log(`   Risk: ${riskColor(s.risk)} | ${s.desc}\n`);
    });
    
    console.log(chalk.gray('Run with specific strategy: node polymarket.js scan --strategy <name>'));
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
