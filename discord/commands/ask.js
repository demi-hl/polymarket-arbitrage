const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

/**
 * /ask - Ask Cortana any trading question
 * Natural language interface to the trading AI
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask Cortana any trading question')
    .addStringOption(option =>
      option
        .setName('question')
        .setDescription('What do you want to know?')
        .setRequired(true)
        .setMaxLength(500)
    ),

  async execute(interaction, cortana) {
    await interaction.deferReply();
    
    const question = interaction.options.getString('question');
    
    try {
      const result = await cortana.tradingAI.process(interaction.user.id, question, {
        userName: interaction.user.username
      });

      // Send main response
      const chunks = [];
      let current = '';
      const lines = result.response.split('\n');
      for (const line of lines) {
        if ((current + line).length > 1900) {
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

      // Send embeds if present
      if (result.embeds && result.embeds.length > 0) {
        for (const embedData of result.embeds) {
          const embed = new EmbedBuilder(embedData);
          await interaction.followUp({ embeds: [embed] });
        }
      }

    } catch (error) {
      console.error('[Ask Command] Error:', error);
      await interaction.editReply('❌ My circuits are buzzing. Try again in a moment?');
    }
  }
};
