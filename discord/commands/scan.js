const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketScanner = require('../../scanner');

/**
 * /scan - Trigger a manual market scan for arbitrage opportunities
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('scan')
    .setDescription('Trigger a manual market scan for arbitrage opportunities')
    .addNumberOption(option =>
      option
        .setName('threshold')
        .setDescription('Minimum edge threshold (%)')
        .setMinValue(0.1)
        .setMaxValue(50)
        .setRequired(false)
    ),

  async execute(interaction, cortana) {
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
          oppText += `${emoji} **${edge}%** - ${opp.question.substring(0, 55)}${opp.question.length > 55 ? '...' : ''}\n`;
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
      console.error('[Scan Command] Error:', error);
      await interaction.editReply(`❌ Scan failed: ${error.message}`);
    }
  }
};
