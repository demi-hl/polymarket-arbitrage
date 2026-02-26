const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

/**
 * /explain - Explain a trading strategy or concept
 * Educational command for learning trading strategies
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('explain')
    .setDescription('Explain a trading strategy or concept')
    .addStringOption(option =>
      option
        .setName('topic')
        .setDescription('What do you want to learn about?')
        .setRequired(true)
        .addChoices(
          { name: 'Basic Arbitrage', value: 'basic-arbitrage' },
          { name: 'Cross-Market Arbitrage', value: 'cross-market-arbitrage' },
          { name: 'Temporal Arbitrage', value: 'temporal-arbitrage' },
          { name: 'Kelly Criterion', value: 'kelly-criterion' },
          { name: 'News Sentiment', value: 'news-sentiment' },
          { name: 'Whale Tracker', value: 'whale-tracker' },
          { name: 'Edge', value: 'edge' },
          { name: 'Implied Probability', value: 'implied-probability' },
          { name: 'Liquidity', value: 'liquidity' },
          { name: 'Resolution Arbitrage', value: 'resolution-arbitrage' }
        )
    ),

  async execute(interaction, cortana) {
    await interaction.deferReply();
    
    const topic = interaction.options.getString('topic');
    
    try {
      const result = await cortana.tradingAI.handleExplainQuery(
        interaction.user.id, 
        topic.replace(/-/g, ' '),
        { userName: interaction.user.username }
      );

      // Split long responses
      const maxLength = 1900;
      const response = result.response;
      
      if (response.length <= maxLength) {
        await interaction.editReply(response);
      } else {
        const chunks = [];
        let current = '';
        const lines = response.split('\n');
        
        for (const line of lines) {
          if ((current + line).length > maxLength) {
            if (current) chunks.push(current.trim());
            current = line + '\n';
          } else {
            current += line + '\n';
          }
        }
        if (current) chunks.push(current.trim());
        
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await interaction.editReply(chunks[i]);
          } else {
            await interaction.followUp(chunks[i]);
          }
        }
      }

    } catch (error) {
      console.error('[Explain Command] Error:', error);
      await interaction.editReply('❌ Couldn\'t fetch that explanation. Try another topic?');
    }
  }
};
