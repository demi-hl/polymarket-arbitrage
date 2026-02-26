#!/usr/bin/env node

/**
 * Complete Discord Integration Example
 * 
 * This shows how to wire up the Discord bot to the trading bot
 * for real-time alerts and notifications.
 */

require('dotenv').config();

const { createDiscordBot } = require('./index');
const PolymarketArbitrageBot = require('../bot');
const PolymarketScanner = require('../scanner');

async function main() {
  console.log('🤖 Starting Polymarket Arbitrage Bot with Discord Integration...\n');

  // Initialize Discord bot
  const discord = createDiscordBot();
  const discordReady = await discord.init();
  
  if (!discordReady) {
    console.log('⚠️  Discord not configured, continuing without notifications\n');
  }

  // Initialize trading bot
  const bot = new PolymarketArbitrageBot({
    mode: process.env.MODE || 'paper',
    initialCash: parseFloat(process.env.INITIAL_CAPITAL) || 10000
  });

  // Wire up events to Discord notifications
  bot.on('trade:executed', ({ trade, portfolio }) => {
    console.log(`✅ Trade executed: ${trade.question.substring(0, 50)}...`);
    
    // Send trade alert to Discord
    if (discordReady && process.env.DISCORD_ALERT_TRADES !== 'false') {
      discord.sendTradeAlert(trade);
    }
  });

  bot.on('position:closed', (position) => {
    console.log(`📊 Position closed: ${position.realizedPnl > 0 ? 'WIN' : 'LOSS'} $${Math.abs(position.realizedPnl).toFixed(2)}`);
    
    // Send position closed alert
    if (discordReady) {
      // Need to get question from position, add it if not present
      discord.sendPositionClosed(position);
    }
  });

  // Example: Run a scan and auto-execute with Discord alerts
  async function runScanAndExecute() {
    try {
      discord.sendSystemAlert('🔍 Starting market scan...', 'info');
      
      const scanner = new PolymarketScanner({
        edgeThreshold: parseFloat(process.env.DISCORD_ALERT_THRESHOLD) || 0.05
      });
      
      const result = await scanner.scan();
      
      console.log(`\n📊 Scan complete: ${result.opportunitiesFound} opportunities found`);
      
      // Send high-value opportunities to Discord
      const threshold = parseFloat(process.env.DISCORD_ALERT_THRESHOLD) || 0.10;
      const highValueOpps = result.opportunities.filter(o => o.edgePercent >= threshold);
      
      for (const opp of highValueOpps) {
        if (process.env.DISCORD_ALERT_OPPORTUNITIES !== 'false') {
          discord.sendOpportunityAlert(opp);
        }
      }
      
      // Auto-execute opportunities (paper trading)
      if (result.opportunities.length > 0) {
        console.log('\n💰 Auto-executing trades...');
        const { executed, skipped, failed } = await bot.autoExecute(result.opportunities);
        
        console.log(`   Executed: ${executed.length}`);
        console.log(`   Skipped: ${skipped.length}`);
        console.log(`   Failed: ${failed.length}`);
        
        if (failed.length > 0) {
          discord.sendSystemAlert(`⚠️ ${failed.length} trades failed to execute`, 'warning');
        }
      }
      
      // Send daily summary (or scan summary)
      if (process.env.DISCORD_ALERT_DAILY_SUMMARY !== 'false') {
        const portfolio = bot.getPortfolio();
        discord.sendDailySummary(portfolio);
      }
      
    } catch (error) {
      console.error('❌ Scan failed:', error.message);
      
      if (process.env.DISCORD_ALERT_ERRORS !== 'false') {
        discord.sendSystemAlert(`❌ Scan error: ${error.message}`, 'error');
      }
    }
  }

  // Run initial scan
  await runScanAndExecute();

  // Schedule periodic scans
  const SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
  console.log(`\n⏰ Scheduling scans every ${SCAN_INTERVAL / 1000 / 60} minutes`);
  
  setInterval(runScanAndExecute, SCAN_INTERVAL);

  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Shutting down...');
    await discord.shutdown();
    process.exit(0);
  });

  console.log('\n✅ Bot is running. Press Ctrl+C to stop.\n');
}

// Run if called directly
if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

module.exports = { main };
