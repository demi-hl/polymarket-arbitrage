const CortanaAI = require('./ai-bot');

/**
 * Discord Bot Entry Point
 * Initializes the Cortana AI-powered trading assistant
 */

const config = {
  token: process.env.DISCORD_BOT_TOKEN,
  channelId: process.env.DISCORD_CHANNEL_ID,
  ai: {
    moonshotApiKey: process.env.MOONSHOT_API_KEY,
    moonshotModel: process.env.MOONSHOT_MODEL || 'kimi-k2.5',
    openaiApiKey: process.env.OPENAI_API_KEY,
    openaiModel: process.env.OPENAI_MODEL || 'gpt-4-turbo',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL,
    ollamaModel: process.env.OLLAMA_MODEL || 'qwen3:14b'
  }
};

const cortana = new CortanaAI(config);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down Cortana...');
  await cortana.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down Cortana...');
  await cortana.shutdown();
  process.exit(0);
});

// Start the bot
console.log('🚀 Starting Cortana AI...');
cortana.init().then(success => {
  if (success) {
    console.log('✅ Cortana AI is online and ready');
  } else {
    console.log('⚠️  Cortana AI failed to start (check DISCORD_BOT_TOKEN)');
    process.exit(1);
  }
});

module.exports = cortana;
