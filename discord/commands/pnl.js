const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketArbitrageBot = require('../../bot');

/**
 * /pnl - Show P&L summary and performance metrics
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('pnl')
    .setDescription('Show P&L summary and performance metrics'),

  async execute(interaction, cortana) {
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
      console.error('[PnL Command] Error:', error);
      await interaction.editReply(`❌ Error fetching P&L: ${error.message}`);
    }
  }
};
