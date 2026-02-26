const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketArbitrageBot = require('../../bot');

/**
 * /positions - Show all open positions
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('positions')
    .setDescription('Show all open positions'),

  async execute(interaction, cortana) {
    await interaction.deferReply();
    
    try {
      const bot = new PolymarketArbitrageBot({ mode: 'paper' });
      const portfolio = bot.getPortfolio();
      const openPositions = Object.values(portfolio.positions).filter(p => p.status === 'open');
      
      if (openPositions.length === 0) {
        await interaction.editReply('📭 No open positions. The bot is waiting for opportunities.\n\nCash available: $' + portfolio.cash.toFixed(2));
        return;
      }
      
      const embed = new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle(`📊 Open Positions (${openPositions.length})`)
        .setDescription(`Total unrealized P&L: $${portfolio.pnl.unrealized.toFixed(2)}`)
        .setTimestamp();
      
      // Add first 10 positions to embed
      for (const pos of openPositions.slice(0, 10)) {
        const yesValue = pos.yesShares * 0.5; // Assuming 50% current price
        const noValue = pos.noShares * 0.5;
        const currentValue = yesValue + noValue;
        const pnl = currentValue - pos.entryCost;
        const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
        
        embed.addFields({
          name: `${pos.question?.substring(0, 50)}${pos.question?.length > 50 ? '...' : ''}`,
          value: `${pnlEmoji} YES: ${pos.yesShares.toFixed(2)} | NO: ${pos.noShares.toFixed(2)}\nEntry: $${pos.entryCost.toFixed(2)} | P&L: $${pnl.toFixed(2)}`,
          inline: false
        });
      }
      
      if (openPositions.length > 10) {
        embed.setFooter({ text: `... and ${openPositions.length - 10} more positions` });
      }
      
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      console.error('[Positions Command] Error:', error);
      await interaction.editReply(`❌ Error fetching positions: ${error.message}`);
    }
  }
};
