const { Client, GatewayIntentBits, Collection, Events, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const ChatEngine = require('./chat');

/**
 * DiscordBot - Discord integration for Polymarket Arbitrage Bot
 * Handles slash commands, alerts, and notifications
 */
class DiscordBot {
  constructor(config = {}) {
    this.token = config.token || process.env.DISCORD_BOT_TOKEN;
    this.channelId = config.channelId || process.env.DISCORD_CHANNEL_ID;
    this.client = null;
    this.commands = new Collection();
    this.isReady = false;
    
    // Alert queue for batching
    this.alertQueue = [];
    this.alertInterval = null;

    // Chat engine for conversational AI
    this.chat = new ChatEngine(config.chat || {});
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
    this.loadCommands();

    // Event handlers
    this.client.once(Events.ClientReady, () => {
      console.log(`🤖 Discord bot logged in as ${this.client.user.tag}`);
      this.isReady = true;
      this.startAlertProcessor();
      
      // Send startup notification
      this.sendSystemAlert('🚀 **Polymarket Arbitrage Bot Started**', 'success');
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

  loadCommands() {
    const commandsPath = path.join(__dirname, 'commands.js');
    if (fs.existsSync(commandsPath)) {
      const { getCommands } = require('./commands');
      const commands = getCommands();
      
      for (const command of commands) {
        this.commands.set(command.name, command);
      }
      console.log(`📋 Loaded ${commands.length} Discord commands`);
    }
  }

  async handleCommand(interaction) {
    const command = this.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, this);
    } catch (error) {
      console.error(`Command ${interaction.commandName} failed:`, error);
      await interaction.reply({ 
        content: '❌ An error occurred while executing this command.',
        ephemeral: true 
      });
    }
  }

  async handleMessage(message) {
    const isDM = !message.guild;
    const isInBotChannel = message.channel.id === this.channelId;
    const isMentioned = message.mentions.has(this.client.user);
    const nameTriggered = message.content.toLowerCase().includes('cortana');

    if (!isDM && !isInBotChannel && !isMentioned && !nameTriggered) return;

    // Strip the bot mention from the message content
    let userMessage = message.content
      .replace(/<@!?\d+>/g, '')
      .replace(/cortana/gi, '')
      .trim();

    if (!userMessage) {
      await message.reply("Hey! What can I help you with? Ask me about markets, your portfolio, strategies, or anything Polymarket-related.");
      return;
    }

    // "clear" / "reset" clears conversation history
    if (/^(clear|reset|forget|new chat)$/i.test(userMessage)) {
      this.chat.clearHistory(message.author.id);
      await message.reply("Conversation cleared. Fresh start!");
      return;
    }

    try {
      await message.channel.sendTyping();
      const typingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
      }, 8000);

      let statusMsg = null;

      const result = await this.chat.chat(message.author.id, userMessage, {
        onToolUse: async (toolName, args) => {
          const summary = toolName === 'shell' ? `\`${args.command?.slice(0, 60)}\``
            : toolName === 'write_file' ? `\`${args.filepath}\``
            : toolName === 'read_file' ? `\`${args.filepath}\``
            : toolName === 'web_search' ? `"${args.query?.slice(0, 50)}"`
            : toolName === 'web_fetch' ? `\`${args.url?.slice(0, 50)}\``
            : '';
          const text = `⚙️ Using **${toolName}** ${summary}`;
          try {
            if (statusMsg) {
              await statusMsg.edit(text);
            } else {
              statusMsg = await message.channel.send(text);
            }
          } catch {}
        }
      });

      clearInterval(typingInterval);
      if (statusMsg) {
        try { await statusMsg.delete(); } catch {}
      }

      // Discord has a 2000 char limit per message
      const chunks = result.reply.match(/[\s\S]{1,2000}/g) || [];
      for (let i = 0; i < chunks.length; i++) {
        if (i === 0) {
          await message.reply(chunks[i]);
        } else {
          await message.channel.send(chunks[i]);
        }
      }
    } catch (error) {
      console.error('[Chat] Error:', error.message);
      await message.reply(`Sorry, something went wrong: ${error.message}`);
    }
  }

  /**
   * Send trade execution notification
   */
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

  /**
   * Send arbitrage opportunity alert
   */
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

  /**
   * Send daily P&L summary
   */
  async sendDailySummary(portfolio) {
    const totalReturn = ((portfolio.cash - 10000) / 10000 * 100);
    const color = totalReturn >= 0 ? 0x00FF00 : 0xFF0000;
    const emoji = totalReturn >= 0 ? '📈' : '📉';
    
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${emoji} Daily Summary`)
      .addFields(
        { name: 'Cash Balance', value: `$${portfolio.cash.toFixed(2)}`, inline: true },
        { name: 'Total Return', value: `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`, inline: true },
        { name: 'Open Positions', value: `${portfolio.openPositions || 0}`, inline: true },
        { name: 'Closed Positions', value: `${portfolio.closedPositions || 0}`, inline: true },
        { name: 'Realized P&L', value: `$${(portfolio.pnl?.realized || 0).toFixed(2)}`, inline: true },
        { name: 'Unrealized P&L', value: `$${(portfolio.pnl?.unrealized || 0).toFixed(2)}`, inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Polymarket Arbitrage Bot' });

    await this.sendEmbed(embed);
  }

  /**
   * Send system alert/error
   */
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

  /**
   * Send position closed notification
   */
  async sendPositionClosed(position) {
    const isWin = position.realizedPnl > 0;
    const embed = new EmbedBuilder()
      .setColor(isWin ? 0x00FF00 : 0xFF0000)
      .setTitle(isWin ? '✅ Position Closed - WIN' : '❌ Position Closed - LOSS')
      .setDescription(`**${position.question?.substring(0, 100)}${position.question?.length > 100 ? '...' : ''}**`)
      .addFields(
        { name: 'Outcome', value: position.outcome?.toUpperCase() || 'Unknown', inline: true },
        { name: 'Payout', value: `$${position.payout?.toFixed(2) || '0.00'}`, inline: true },
        { name: 'Realized P&L', value: `$${position.realizedPnl?.toFixed(2) || '0.00'}`, inline: true },
        { name: 'ROI', value: position.roi || '0%', inline: true }
      )
      .setTimestamp();

    await this.sendEmbed(embed);
  }

  /**
   * Generic embed sender
   */
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

  /**
   * Queue alert for batching
   */
  queueAlert(type, data) {
    this.alertQueue.push({ type, data, timestamp: Date.now() });
  }

  /**
   * Process alert queue
   */
  startAlertProcessor() {
    this.alertInterval = setInterval(() => {
      this.processAlertQueue();
    }, 5000); // Process every 5 seconds
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
          case 'position_closed':
            await this.sendPositionClosed(alert.data);
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

  /**
   * Get bot status for commands
   */
  getStatus() {
    return {
      connected: this.isReady,
      username: this.client?.user?.tag || 'Not connected',
      channelId: this.channelId,
      queueSize: this.alertQueue.length
    };
  }

  /**
   * Shutdown gracefully
   */
  async shutdown() {
    if (this.alertInterval) {
      clearInterval(this.alertInterval);
    }
    
    if (this.isReady) {
      await this.sendSystemAlert('🛑 **Bot Shutting Down**', 'warning');
    }
    
    if (this.client) {
      this.client.destroy();
    }
    
    console.log('Discord bot shutdown complete');
  }
}

module.exports = DiscordBot;
