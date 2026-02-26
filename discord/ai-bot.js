const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const TradingAI = require('./trading-ai');

/**
 * CortanaAI - AI-Powered Discord Bot for Trading Intelligence
 * 
 * Features:
 * - Natural language understanding for trading queries
 * - P&L and portfolio insights on demand
 * - Strategy explanations and advice
 * - Market analysis and simulation
 * - Cortana personality: competent, direct, witty
 */
class CortanaAI {
  constructor(config = {}) {
    this.token = config.token || process.env.DISCORD_BOT_TOKEN;
    this.channelId = config.channelId || process.env.DISCORD_CHANNEL_ID;
    this.client = null;
    this.commands = new Collection();
    this.isReady = false;
    
    // Alert queue for batching
    this.alertQueue = [];
    this.alertInterval = null;

    // Trading AI engine with Cortana personality
    this.tradingAI = new TradingAI(config.ai || {});
    
    // Context storage for user sessions
    this.userContext = new Map();
    
    // Rate limiting
    this.rateLimits = new Map();
    this.rateLimitWindow = 60000; // 1 minute
    this.maxRequestsPerWindow = 10;
  }

  async init() {
    if (!this.token) {
      console.log('⚠️  Discord bot token not configured. Skipping Discord integration.');
      return false;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent
      ]
    });

    // Load commands
    await this.loadCommands();

    // Event handlers
    this.client.once(Events.ClientReady, () => {
      console.log(`🎓 Cortana online as ${this.client.user.tag}`);
      this.isReady = true;
      this.startAlertProcessor();
      
      // Send startup notification
      this.sendSystemAlert('🚀 **Cortana AI Trading Bot Online**', 'success');
    });

    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await this.handleCommand(interaction);
    });

    this.client.on(Events.MessageCreate, async (message) => {
      if (message.author.bot) return;
      await this.handleMessage(message);
    });

    this.client.on(Events.Error, (error) => {
      console.error('Discord client error:', error);
    });

    try {
      await this.client.login(this.token);
      return true;
    } catch (error) {
      console.error('❌ Failed to login to Discord:', error.message);
      return false;
    }
  }

  async loadCommands() {
    const commandsDir = path.join(__dirname, 'commands');
    
    // Create commands directory if it doesn't exist
    if (!fs.existsSync(commandsDir)) {
      fs.mkdirSync(commandsDir, { recursive: true });
      return;
    }

    const commandFiles = fs.readdirSync(commandsDir)
      .filter(file => file.endsWith('.js'));

    for (const file of commandFiles) {
      try {
        const command = require(path.join(commandsDir, file));
        if (command.data && command.execute) {
          this.commands.set(command.data.name, command);
          console.log(`📋 Loaded command: ${command.data.name}`);
        }
      } catch (error) {
        console.error(`Failed to load command ${file}:`, error.message);
      }
    }

    console.log(`📋 Loaded ${this.commands.size} slash commands`);
  }

  async handleCommand(interaction) {
    const command = this.commands.get(interaction.commandName);
    if (!command) return;

    // Check rate limits
    if (!this.checkRateLimit(interaction.user.id)) {
      await interaction.reply({ 
        content: '⏱️ Whoa there, Chief. Too many requests. Give me a second.',
        ephemeral: true 
      });
      return;
    }

    try {
      await command.execute(interaction, this);
    } catch (error) {
      console.error(`Command ${interaction.commandName} failed:`, error);
      const reply = { 
        content: '❌ Something went sideways. Try again?',
        ephemeral: true 
      };
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(reply);
      } else {
        await interaction.reply(reply);
      }
    }
  }

  async handleMessage(message) {
    const isDM = !message.guild;
    const isInBotChannel = message.channel.id === this.channelId;
    const isMentioned = message.mentions.has(this.client.user);
    const nameTriggered = message.content.toLowerCase().includes('cortana');

    if (!isDM && !isInBotChannel && !isMentioned && !nameTriggered) return;

    // Rate limiting
    if (!this.checkRateLimit(message.author.id)) {
      await message.reply('⏱️ Easy there. I can only process so many thoughts at once.');
      return;
    }

    // Strip the bot mention and name from the message content
    let userMessage = message.content
      .replace(/<@!?\d+>/g, '')
      .replace(/cortana/gi, '')
      .trim();

    if (!userMessage) {
      const greetings = [
        "Hey! I'm Cortana, your trading AI. Ask me about markets, P&L, strategies, or say 'help' for options.",
        "Cortana here. Ready to find some alpha. What do you need?",
        "What's up? I'm your AI trading assistant. Ask me anything about Polymarket."
      ];
      await message.reply(greetings[Math.floor(Math.random() * greetings.length)]);
      return;
    }

    // Clear/reset conversation
    if (/^(clear|reset|forget|new chat)$/i.test(userMessage)) {
      this.tradingAI.clearContext(message.author.id);
      await message.reply("Memory wiped. Fresh slate. Let's do this. 🧹");
      return;
    }

    // Handle special quick commands without AI
    const quickResponse = this.handleQuickCommand(userMessage, message.author.id);
    if (quickResponse) {
      await message.reply(quickResponse);
      return;
    }

    try {
      await message.channel.sendTyping();
      
      // Get user context
      const userContext = this.getUserContext(message.author.id);
      
      // Process through trading AI
      const result = await this.tradingAI.process(message.author.id, userMessage, {
        userName: message.author.username,
        context: userContext,
        onThinking: async () => {
          // Keep typing indicator alive
        }
      });

      // Update user context
      this.updateUserContext(message.author.id, result.context);

      // Send response (handle Discord's 2000 char limit)
      const chunks = this.chunkMessage(result.response, 2000);
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply(chunks[i]);
        } else {
          await message.channel.send(chunks[i]);
        }
      }

      // Send any embeds if present
      if (result.embeds && result.embeds.length > 0) {
        for (const embedData of result.embeds) {
          const embed = new EmbedBuilder(embedData);
          await message.channel.send({ embeds: [embed] });
        }
      }

    } catch (error) {
      console.error('[Cortana] Error:', error.message);
      await message.reply(`My circuits are a bit fried right now. Try again in a moment? 🎓`);
    }
  }

  handleQuickCommand(message, userId) {
    const lower = message.toLowerCase();

    // Help shortcut
    if (/^help$|^commands$|^what can you do$/i.test(lower)) {
      return `**Here's what I can do:**

📊 **Trading Intelligence**
• "What's my P&L?" - Portfolio summary
• "Show positions" - Open positions
• "Scan for opportunities" - Market scan
• "Analyze [market]" - Market analysis

🧠 **Knowledge**
• "Explain [strategy]" - Strategy breakdown
• "What is Kelly Criterion?" - Concept explanations
• "Should I trade [market]?" - Trading advice

💡 **Simulation**
• "Simulate $500 on BTC $100K" - Trade simulation
• "What if I bought YES on Iran?" - Scenario analysis

⚡ **Quick Commands**
• "/pnl" - P&L summary
• "/positions" - Open positions  
• "/scan" - Market scan
• "/ask" - Ask any question
• "/analyze" - Analyze market
• "/explain" - Explain strategy
• "/simulate" - Simulate trade

Or just chat naturally. I'm listening. 🎓`;
    }

    return null;
  }

  getUserContext(userId) {
    if (!this.userContext.has(userId)) {
      this.userContext.set(userId, {
        lastQuery: null,
        preferences: {},
        history: []
      });
    }
    return this.userContext.get(userId);
  }

  updateUserContext(userId, updates) {
    const context = this.getUserContext(userId);
    Object.assign(context, updates);
    context.history.push({ timestamp: Date.now(), ...updates });
    // Keep last 50 history entries
    if (context.history.length > 50) {
      context.history = context.history.slice(-50);
    }
  }

  checkRateLimit(userId) {
    const now = Date.now();
    const userLimit = this.rateLimits.get(userId);

    if (!userLimit || now - userLimit.resetTime > this.rateLimitWindow) {
      this.rateLimits.set(userId, {
        count: 1,
        resetTime: now
      });
      return true;
    }

    if (userLimit.count >= this.maxRequestsPerWindow) {
      return false;
    }

    userLimit.count++;
    return true;
  }

  chunkMessage(text, maxLength) {
    const chunks = [];
    let current = '';
    
    const lines = text.split('\n');
    for (const line of lines) {
      if ((current + line).length > maxLength) {
        if (current) chunks.push(current.trim());
        current = line + '\n';
      } else {
        current += line + '\n';
      }
    }
    if (current) chunks.push(current.trim());
    
    return chunks.length > 0 ? chunks : [text.slice(0, maxLength)];
  }

  // Alert methods
  async sendTradeAlert(trade) {
    const embed = new EmbedBuilder()
      .setColor(trade.expectedProfit > 0 ? 0x00FF00 : 0xFF6600)
      .setTitle('💰 Trade Executed')
      .setDescription(`**${trade.question.substring(0, 100)}${trade.question.length > 100 ? '...' : ''}**`)
      .addFields(
        { name: 'Direction', value: trade.direction, inline: true },
        { name: 'YES Price', value: `${(trade.yesPrice * 100).toFixed(1)}¢`, inline: true },
        { name: 'NO Price', value: `${(trade.noPrice * 100).toFixed(1)}¢`, inline: true },
        { name: 'Position Size', value: `$${trade.totalCost.toFixed(2)}`, inline: true },
        { name: 'Expected Profit', value: `$${trade.expectedProfit.toFixed(2)}`, inline: true },
        { name: 'Edge', value: `${(trade.edgePercent * 100).toFixed(2)}%`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: `Trade ID: ${trade.id}` });

    await this.sendEmbed(embed);
  }

  async sendOpportunityAlert(opportunity) {
    const edgePercent = (opportunity.edgePercent * 100).toFixed(1);
    const emoji = opportunity.edgePercent >= 0.15 ? '🔥' : opportunity.edgePercent >= 0.10 ? '⚡' : '💡';
    
    const embed = new EmbedBuilder()
      .setColor(opportunity.edgePercent >= 0.15 ? 0xFF0000 : 0xFFA500)
      .setTitle(`${emoji} ${edgePercent}% Edge Detected`)
      .setDescription(`**${opportunity.question.substring(0, 100)}${opportunity.question.length > 100 ? '...' : ''}**`)
      .addFields(
        { name: 'YES Price', value: `${(opportunity.yesPrice * 100).toFixed(1)}¢`, inline: true },
        { name: 'NO Price', value: `${(opportunity.noPrice * 100).toFixed(1)}¢`, inline: true },
        { name: 'Sum', value: `${((opportunity.yesPrice + opportunity.noPrice) * 100).toFixed(1)}¢`, inline: true },
        { name: 'Liquidity', value: `$${(opportunity.liquidity / 1000).toFixed(1)}K`, inline: true },
        { name: 'Max Position', value: `$${opportunity.maxPosition.toFixed(0)}`, inline: true },
        { name: 'Category', value: opportunity.category || 'Unknown', inline: true }
      )
      .setTimestamp()
      .setFooter({ text: `Market ID: ${opportunity.marketId.substring(0, 20)}...` });

    await this.sendEmbed(embed);
  }

  async sendSystemAlert(message, type = 'info') {
    const colors = {
      info: 0x3498db,
      success: 0x2ecc71,
      warning: 0xf39c12,
      error: 0xe74c3c
    };
    
    const emojis = {
      info: 'ℹ️',
      success: '✅',
      warning: '⚠️',
      error: '❌'
    };

    const embed = new EmbedBuilder()
      .setColor(colors[type] || colors.info)
      .setDescription(`${emojis[type] || 'ℹ️'} ${message}`)
      .setTimestamp();

    await this.sendEmbed(embed);
  }

  async sendEmbed(embed) {
    if (!this.isReady || !this.channelId) return;

    try {
      const channel = await this.client.channels.fetch(this.channelId);
      if (channel && channel.send) {
        await channel.send({ embeds: [embed] });
      }
    } catch (error) {
      console.error('Failed to send Discord message:', error.message);
    }
  }

  queueAlert(type, data) {
    this.alertQueue.push({ type, data, timestamp: Date.now() });
  }

  startAlertProcessor() {
    this.alertInterval = setInterval(() => {
      this.processAlertQueue();
    }, 5000);
  }

  async processAlertQueue() {
    if (this.alertQueue.length === 0) return;

    const alerts = this.alertQueue.splice(0, this.alertQueue.length);
    
    for (const alert of alerts) {
      try {
        switch (alert.type) {
          case 'trade':
            await this.sendTradeAlert(alert.data);
            break;
          case 'opportunity':
            await this.sendOpportunityAlert(alert.data);
            break;
          case 'system':
            await this.sendSystemAlert(alert.data.message, alert.data.level);
            break;
        }
      } catch (error) {
        console.error('Alert processing error:', error);
      }
    }
  }

  getStatus() {
    return {
      connected: this.isReady,
      username: this.client?.user?.tag || 'Not connected',
      channelId: this.channelId,
      queueSize: this.alertQueue.length,
      commands: this.commands.size
    };
  }

  async shutdown() {
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
    
    if (this.isReady) {
      await this.sendSystemAlert('🛑 **Cortana shutting down**', 'warning');
    }
    
    if (this.client) {
      this.client.destroy();
    }
    
    console.log('Cortana AI shutdown complete');
  }
}

module.exports = CortanaAI;
