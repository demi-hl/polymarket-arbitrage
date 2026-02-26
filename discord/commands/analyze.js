const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketScanner = require('../../scanner');

/**
 * /analyze - Analyze a specific market
 * Provides detailed analysis of a market's edge, liquidity, and trading opportunity
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Analyze a specific market on Polymarket')
    .addStringOption(option =>
      option
        .setName('market')
        .setDescription('Market name or keyword to search for')
        .setRequired(true)
        .setMaxLength(200)
    ),

  async execute(interaction, cortana) {
    await interaction.deferReply();
    
    const marketQuery = interaction.options.getString('market');
    
    try {
      await interaction.editReply(`🔍 Analyzing markets matching "${marketQuery}"...`);
      
      const scanner = new PolymarketScanner();
      const result = await scanner.scan({ threshold: 0.01 });
      
      // Find markets matching the query
      const matchingMarkets = result.opportunities.filter(opp => 
        opp.question.toLowerCase().includes(marketQuery.toLowerCase()) ||
        opp.category?.toLowerCase().includes(marketQuery.toLowerCase()) ||
        opp.eventTitle?.toLowerCase().includes(marketQuery.toLowerCase())
      );
      
      if (matchingMarkets.length === 0) {
        await interaction.editReply(`❌ No markets found matching "${marketQuery}".\n\nTry a broader search or check active markets with /scan`);
        return;
      }
      
      // Get the best opportunity
      const market = matchingMarkets[0];
      const edgePercent = (market.edgePercent * 100).toFixed(2);
      const priceSum = ((market.yesPrice + market.noPrice) * 100).toFixed(1);
      
      // Determine recommendation
      let recommendation, color;
      if (market.edgePercent >= 0.08) {
        recommendation = '🔥 Strong Buy - Excellent edge';
        color = 0x00FF00;
      } else if (market.edgePercent >= 0.05) {
        recommendation = '✅ Buy - Good edge';
        color = 0x2ecc71;
      } else if (market.edgePercent >= 0.02) {
        recommendation = '⚡ Consider - Moderate edge';
        color = 0xf39c12;
      } else {
        recommendation = '❌ Skip - Edge too low';
        color = 0xe74c3c;
      }
      
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('📊 Market Analysis')
        .setDescription(`**${market.question.substring(0, 150)}${market.question.length > 150 ? '...' : ''}**`)
        .addFields(
          { 
            name: '💰 Prices', 
            value: `YES: **${(market.yesPrice * 100).toFixed(1)}¢**\nNO: **${(market.noPrice * 100).toFixed(1)}¢**\nSum: **${priceSum}¢**`,
            inline: true 
          },
          { 
            name: '📈 Edge', 
            value: `**${edgePercent}%**\nMax Pos: $${market.maxPosition.toFixed(0)}`,
            inline: true 
          },
          { 
            name: '💧 Liquidity', 
            value: `$${(market.liquidity / 1000).toFixed(1)}K\nCategory: ${market.category || 'N/A'}`,
            inline: true 
          },
          { 
            name: '🎯 Recommendation', 
            value: recommendation,
            inline: false 
          }
        )
        .setTimestamp()
        .setFooter({ text: `Market ID: ${market.marketId.substring(0, 25)}...` });

      if (matchingMarkets.length > 1) {
        embed.addFields({
          name: '📋 Other Matches',
          value: `${matchingMarkets.length - 1} other market(s) found. Refine your search for specific analysis.`
        });
      }

      await interaction.editReply({ content: null, embeds: [embed] });

    } catch (error) {
      console.error('[Analyze Command] Error:', error);
      await interaction.editReply(`❌ Analysis failed: ${error.message}`);
    }
  }
};
