const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketArbitrageBot = require('../bot');
const PolymarketScanner = require('../scanner');

/**
 * Discord Slash Commands for Polymarket Arbitrage Bot
 * 
 * Commands:
 * - /status - Show bot status
 * - /pnl - Show P&L summary
 * - /positions - Show open positions
 * - /strategies - List all strategies
 * - /scan - Trigger manual market scan
 */

const getCommands = () => [
  {
    name: 'status',
    description: 'Show bot status and connection info',
    data: new SlashCommandBuilder()
      .setName('status')
      .setDescription('Show bot status and connection info'),
    async execute(interaction, discordBot) {
      const botStatus = discordBot.getStatus();
      
      const embed = new EmbedBuilder()
        .setColor(botStatus.connected ? 0x00FF00 : 0xFF0000)
        .setTitle('🤖 Bot Status')
        .addFields(
          { name: 'Discord Connection', value: botStatus.connected ? '✅ Connected' : '❌ Disconnected', inline: true },
          { name: 'Bot User', value: botStatus.username || 'Unknown', inline: true },
          { name: 'Alert Queue', value: `${botStatus.queueSize} pending`, inline: true },
          { name: 'Mode', value: process.env.MODE || 'paper', inline: true },
          { name: 'Channel ID', value: botStatus.channelId || 'Not set', inline: true }
        )
        .setTimestamp();
      
      await interaction.reply({ embeds: [embed] });
    }
  },

  {
    name: 'pnl',
    description: 'Show P&L summary and performance metrics',
    data: new SlashCommandBuilder()
      .setName('pnl')
      .setDescription('Show P&L summary and performance metrics'),
    async execute(interaction) {
      await interaction.deferReply();
      
      try {
        const bot = new PolymarketArbitrageBot({ mode: 'paper' });
        const report = await bot.generateReport();
        
        const totalReturn = parseFloat(report.portfolio.totalReturn);
        const color = totalReturn >= 0 ? 0x00FF00 : 0xFF0000;
        const emoji = totalReturn >= 0 ? '📈' : '📉';
        
        const embed = new EmbedBuilder()
          .setColor(color)
          .setTitle(`${emoji} P&L Summary`)
          .addFields(
            { name: 'Cash Balance', value: `$${report.portfolio.cash.toFixed(2)}`, inline: true },
            { name: 'Total Return', value: report.portfolio.totalReturn, inline: true },
            { name: 'Total Trades', value: `${report.performance.totalTrades}`, inline: true },
            { name: 'Win Rate', value: report.performance.winRate, inline: true },
            { name: 'Realized P&L', value: `$${report.pnl.realized.toFixed(2)}`, inline: true },
            { name: 'Unrealized P&L', value: `$${report.pnl.unrealized.toFixed(2)}`, inline: true },
            { name: 'Open Positions', value: `${report.portfolio.openPositions}`, inline: true },
            { name: 'Closed Positions', value: `${report.portfolio.closedPositions}`, inline: true },
            { name: 'Profit Factor', value: report.performance.profitFactor, inline: true }
          )
          .setTimestamp()
          .setFooter({ text: `Winning: ${report.performance.winningTrades} | Losing: ${report.performance.losingTrades}` });
        
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply(`❌ Error fetching P&L: ${error.message}`);
      }
    }
  },

  {
    name: 'positions',
    description: 'Show all open positions',
    data: new SlashCommandBuilder()
      .setName('positions')
      .setDescription('Show all open positions'),
    async execute(interaction) {
      await interaction.deferReply();
      
      try {
        const bot = new PolymarketArbitrageBot({ mode: 'paper' });
        const portfolio = bot.getPortfolio();
        const openPositions = Object.values(portfolio.positions).filter(p => p.status === 'open');
        
        if (openPositions.length === 0) {
          await interaction.editReply('📭 No open positions. The bot is waiting for opportunities.');
          return;
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x3498db)
          .setTitle(`📊 Open Positions (${openPositions.length})`)
          .setDescription(`Total unrealized P&L: $${portfolio.pnl.unrealized.toFixed(2)}`)
          .setTimestamp();
        
        // Add first 10 positions to embed
        for (const pos of openPositions.slice(0, 10)) {
          embed.addFields({
            name: `${pos.question?.substring(0, 50)}${pos.question?.length > 50 ? '...' : ''}`,
            value: `YES: ${pos.yesShares.toFixed(2)} shares | NO: ${pos.noShares.toFixed(2)} shares\nEntry: $${pos.entryCost.toFixed(2)}`,
            inline: false
          });
        }
        
        if (openPositions.length > 10) {
          embed.setFooter({ text: `... and ${openPositions.length - 10} more positions` });
        }
        
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        await interaction.editReply(`❌ Error fetching positions: ${error.message}`);
      }
    }
  },

  {
    name: 'strategies',
    description: 'List all available trading strategies',
    data: new SlashCommandBuilder()
      .setName('strategies')
      .setDescription('List all available trading strategies'),
    async execute(interaction) {
      try {
        const { ALL_STRATEGIES } = require('../strategies');
        
        // Group by type
        const byType = {};
        for (const strategy of ALL_STRATEGIES) {
          if (!byType[strategy.type]) byType[strategy.type] = [];
          byType[strategy.type].push(strategy);
        }
        
        const embed = new EmbedBuilder()
          .setColor(0x9b59b6)
          .setTitle('🎯 Trading Strategies')
          .setDescription(`${ALL_STRATEGIES.length} strategies available`)
          .setTimestamp();
        
        for (const [type, strategies] of Object.entries(byType)) {
          const lowRisk = strategies.filter(s => s.riskLevel === 'low').length;
          const mediumRisk = strategies.filter(s => s.riskLevel === 'medium').length;
          const highRisk = strategies.filter(s => s.riskLevel === 'high').length;
          
          const riskText = [
            lowRisk > 0 ? `🟢 ${lowRisk}` : '',
            mediumRisk > 0 ? `🟡 ${mediumRisk}` : '',
            highRisk > 0 ? `🔴 ${highRisk}` : ''
          ].filter(Boolean).join(' | ');
          
          embed.addFields({
            name: `${type.charAt(0).toUpperCase() + type.slice(1)} (${strategies.length})`,
            value: riskText || 'No strategies',
            inline: true
          });
        }
        
        await interaction.reply({ embeds: [embed] });
      } catch (error) {
        await interaction.reply(`❌ Error fetching strategies: ${error.message}`);
      }
    }
  },

  {
    name: 'scan',
    description: 'Trigger a manual market scan for arbitrage opportunities',
    data: new SlashCommandBuilder()
      .setName('scan')
      .setDescription('Trigger a manual market scan')
      .addNumberOption(option =>
        option
          .setName('threshold')
          .setDescription('Minimum edge threshold (%)')
          .setMinValue(0.1)
          .setMaxValue(50)
          .setRequired(false)
      ),
    async execute(interaction) {
      await interaction.deferReply();
      
      try {
        const threshold = (interaction.options.getNumber('threshold') || 5) / 100;
        
        await interaction.editReply(`🔍 Scanning Polymarket for opportunities above ${(threshold * 100).toFixed(1)}% edge...`);
        
        const scanner = new PolymarketScanner({ edgeThreshold: threshold });
        const result = await scanner.scan({ threshold });
        
        const embed = new EmbedBuilder()
          .setColor(result.opportunitiesFound > 0 ? 0x00FF00 : 0xFFA500)
          .setTitle('🔍 Scan Results')
          .addFields(
            { name: 'Markets Scanned', value: `${result.marketsScanned}`, inline: true },
            { name: 'Opportunities', value: `${result.opportunitiesFound}`, inline: true },
            { name: 'Threshold', value: `${(threshold * 100).toFixed(1)}%`, inline: true }
          )
          .setTimestamp();
        
        if (result.opportunitiesFound > 0) {
          const topOpps = result.opportunities.slice(0, 5);
          let oppText = '';
          
          for (const opp of topOpps) {
            const edge = (opp.edgePercent * 100).toFixed(1);
            const emoji = opp.edgePercent >= 0.15 ? '🔥' : opp.edgePercent >= 0.10 ? '⚡' : '💡';
            oppText += `${emoji} **${edge}%** - ${opp.question.substring(0, 60)}${opp.question.length > 60 ? '...' : ''}\n`;
            oppText += `   YES: ${(opp.yesPrice * 100).toFixed(1)}¢ | NO: ${(opp.noPrice * 100).toFixed(1)}¢ | Liq: $${(opp.liquidity / 1000).toFixed(1)}K\n\n`;
          }
          
          embed.addFields({ name: 'Top Opportunities', value: oppText || 'None' });
          
          if (result.opportunitiesFound > 5) {
            embed.setFooter({ text: `... and ${result.opportunitiesFound - 5} more opportunities` });
          }
        } else {
          embed.addFields({ name: 'Result', value: 'No arbitrage opportunities found above threshold.' });
        }
        
        await interaction.editReply({ content: null, embeds: [embed] });
      } catch (error) {
        await interaction.editReply(`❌ Scan failed: ${error.message}`);
      }
    }
  }
];

module.exports = { getCommands };
