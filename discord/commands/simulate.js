const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PolymarketScanner = require('../../scanner');

/**
 * /simulate - Simulate a trade on a specific market
 * Shows expected P&L, ROI, and scenario analysis
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('simulate')
    .setDescription('Simulate a trade on a market')
    .addStringOption(option =>
      option
        .setName('market')
        .setDescription('Market to simulate (keyword search)')
        .setRequired(true)
        .setMaxLength(200)
    )
    .addNumberOption(option =>
      option
        .setName('amount')
        .setDescription('Position size in USD')
        .setRequired(true)
        .setMinValue(10)
        .setMaxValue(10000)
    )
    .addStringOption(option =>
      option
        .setName('direction')
        .setDescription('Which side to take')
        .setRequired(false)
        .addChoices(
          { name: 'Arbitrage (BUY BOTH)', value: 'both' },
          { name: 'YES only', value: 'yes' },
          { name: 'NO only', value: 'no' }
        )
    ),

  async execute(interaction, cortana) {
    await interaction.deferReply();
    
    const marketQuery = interaction.options.getString('market');
    const amount = interaction.options.getNumber('amount');
    const direction = interaction.options.getString('direction') || 'both';
    
    try {
      await interaction.editReply(`💡 Simulating $${amount} position on "${marketQuery}"...`);
      
      const scanner = new PolymarketScanner();
      const result = await scanner.scan({ threshold: 0.01 });
      
      // Find markets matching the query
      const matchingMarkets = result.opportunities.filter(opp => 
        opp.question.toLowerCase().includes(marketQuery.toLowerCase())
      );
      
      if (matchingMarkets.length === 0) {
        await interaction.editReply(`❌ No markets found matching "${marketQuery}".`);
        return;
      }
      
      const market = matchingMarkets[0];
      
      // Calculate simulation based on direction
      let yesSize, noSize, yesShares, noShares, expectedProfit, roi;
      let scenarioYes, scenarioNo;
      
      if (direction === 'both') {
        // Arbitrage: buy both sides
        yesSize = amount / 2;
        noSize = amount / 2;
        yesShares = yesSize / market.yesPrice;
        noShares = noSize / market.noPrice;
        expectedProfit = amount * market.edgePercent;
        roi = (market.edgePercent * 100).toFixed(2);
        
        scenarioYes = {
          payout: yesShares,
          profit: yesShares - amount,
          roi: ((yesShares - amount) / amount * 100).toFixed(2)
        };
        scenarioNo = {
          payout: noShares,
          profit: noShares - amount,
          roi: ((noShares - amount) / amount * 100).toFixed(2)
        };
      } else if (direction === 'yes') {
        // Long YES
        yesSize = amount;
        noSize = 0;
        yesShares = yesSize / market.yesPrice;
        noShares = 0;
        expectedProfit = yesShares * (1 - market.yesPrice) - amount;
        roi = ((yesShares - amount) / amount * 100).toFixed(2);
        
        scenarioYes = {
          payout: yesShares,
          profit: yesShares - amount,
          roi: ((yesShares - amount) / amount * 100).toFixed(2)
        };
        scenarioNo = {
          payout: 0,
          profit: -amount,
          roi: '-100.00'
        };
      } else {
        // Long NO
        yesSize = 0;
        noSize = amount;
        yesShares = 0;
        noShares = noSize / market.noPrice;
        expectedProfit = noShares * (1 - market.noPrice) - amount;
        roi = ((noShares - amount) / amount * 100).toFixed(2);
        
        scenarioYes = {
          payout: 0,
          profit: -amount,
          roi: '-100.00'
        };
        scenarioNo = {
          payout: noShares,
          profit: noShares - amount,
          roi: ((noShares - amount) / amount * 100).toFixed(2)
        };
      }

      // Determine color based on expected profit
      const color = expectedProfit > 0 ? 0x2ecc71 : expectedProfit < 0 ? 0xe74c3c : 0xf39c12;
      const profitEmoji = expectedProfit > 0 ? '🟢' : expectedProfit < 0 ? '🔴' : '⚪';
      
      const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('💡 Trade Simulation')
        .setDescription(`**${market.question.substring(0, 100)}${market.question.length > 100 ? '...' : ''}**`)
        .addFields(
          { 
            name: '📝 Position Details', 
            value: `Size: **$${amount.toFixed(2)}**\nDirection: **${direction.toUpperCase()}**\nEntry: YES ${(market.yesPrice * 100).toFixed(1)}¢ | NO ${(market.noPrice * 100).toFixed(1)}¢`,
            inline: false 
          },
          { 
            name: '💰 Expected Outcome', 
            value: `${profitEmoji} Expected Profit: **$${expectedProfit.toFixed(2)}**\n📈 Expected ROI: **${roi}%**`,
            inline: false 
          },
          { 
            name: '🎯 If YES Resolves', 
            value: `Payout: $${scenarioYes.payout.toFixed(2)}\nProfit: **$${scenarioYes.profit.toFixed(2)}** (${scenarioYes.roi}%)`,
            inline: true 
          },
          { 
            name: '🎯 If NO Resolves', 
            value: `Payout: $${scenarioNo.payout.toFixed(2)}\nProfit: **$${scenarioNo.profit.toFixed(2)}** (${scenarioNo.roi}%)`,
            inline: true 
          },
          { 
            name: '💧 Market Conditions', 
            value: `Liquidity: $${(market.liquidity / 1000).toFixed(1)}K\nMax Position: $${market.maxPosition.toFixed(0)}`,
            inline: false 
          }
        )
        .setTimestamp()
        .setFooter({ text: 'This is a simulation. Actual results may vary due to slippage and timing.' });

      // Add recommendation
      const edgePercent = (market.edgePercent * 100);
      let recommendation;
      if (direction === 'both' && edgePercent >= 3) {
        recommendation = '✅ Solid arbitrage opportunity';
      } else if (direction === 'both' && edgePercent < 3) {
        recommendation = '⚠️ Edge is thin for arbitrage';
      } else if (expectedProfit > 0) {
        recommendation = '📈 Positive expected value';
      } else {
        recommendation = '❌ Negative expected value';
      }
      
      embed.addFields({ name: '🎓 Cortana Says', value: recommendation });

      await interaction.editReply({ content: null, embeds: [embed] });

    } catch (error) {
      console.error('[Simulate Command] Error:', error);
      await interaction.editReply(`❌ Simulation failed: ${error.message}`);
    }
  }
};
