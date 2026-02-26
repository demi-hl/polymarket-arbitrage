const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * /help - Show all Cortana capabilities
 * Comprehensive help with navigation buttons
 */
module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all Cortana capabilities and commands')
    .addStringOption(option =>
      option
        .setName('topic')
        .setDescription('Specific help topic')
        .setRequired(false)
        .addChoices(
          { name: 'Trading Commands', value: 'trading' },
          { name: 'AI Features', value: 'ai' },
          { name: 'Strategies', value: 'strategies' },
          { name: 'Quick Tips', value: 'tips' }
        )
    ),

  async execute(interaction, cortana) {
    const topic = interaction.options.getString('topic');
    
    const embed = new EmbedBuilder()
      .setColor(0x9b59b6)
      .setTitle('🎓 Cortana AI - Help & Capabilities')
      .setDescription('Your intelligent trading assistant for Polymarket and prediction markets.')
      .setThumbnail('https://cdn.discordapp.com/attachments/.../cortana-icon.png')
      .setTimestamp();

    switch (topic) {
      case 'trading':
        embed.addFields(
          { 
            name: '📊 Trading Commands', 
            value: 
              '`/pnl` - View your profit/loss summary\n' +
              '`/positions` - See all open positions\n' +
              '`/scan` - Scan for arbitrage opportunities\n' +
              '`/analyze [market]` - Deep dive on a specific market\n' +
              '`/simulate [market] [amount]` - Model a trade before executing'
          },
          { 
            name: '💡 Natural Language', 
            value: 
              'You can also ask naturally:\n' +
              '• "What\'s my P&L?"\n' +
              '• "Show me open positions"\n' +
              '• "Analyze the Iran market"\n' +
              '• "Simulate $500 on BTC $100K"'
          }
        );
        break;
        
      case 'ai':
        embed.addFields(
          { 
            name: '🧠 AI Features', 
            value: 
              '`/ask [question]` - Ask any trading question\n' +
              '`/explain [topic]` - Learn strategies and concepts\n' +
              '• Mention @Cortana or say "Cortana" to chat naturally\n' +
              '• I remember context within conversations\n' +
              '• Say "reset" or "clear" to start fresh'
          },
          { 
            name: '🎯 What I Can Answer', 
            value: 
              '• Strategy explanations (Kelly Criterion, arbitrage types)\n' +
              '• Trading advice and recommendations\n' +
              '• Market analysis and edge calculations\n' +
              '• "What if" scenario modeling\n' +
              '• General prediction market questions'
          }
        );
        break;
        
      case 'strategies':
        embed.addFields(
          { 
            name: '🎯 Available Strategies', 
            value: 
              '**Low Risk:**\n' +
              '• Basic Arbitrage (YES+NO < $1)\n' +
              '• Cross-Market Arbitrage\n' +
              '• Resolution Arbitrage\n\n' +
              '**Medium Risk:**\n' +
              '• Temporal Arbitrage\n' +
              '• News Sentiment\n' +
              '• Statistical Arbitrage\n\n' +
              '**High Risk:**\n' +
              '• Whale Tracker\n' +
              '• Orderbook Scalping\n' +
              '• Flow Imbalance'
          },
          { 
            name: '📚 Learn More', 
            value: 'Use `/explain [strategy]` for detailed breakdowns of any strategy.'
          }
        );
        break;
        
      case 'tips':
        embed.addFields(
          { 
            name: '⚡ Pro Tips', 
            value: 
              '**Edge Thresholds:**\n' +
              '• < 2%: Skip it\n' +
              '• 2-5%: Small position\n' +
              '• 5-10%: Medium position\n' +
              '• > 10%: Large position (if liquid)\n\n' +
              '**Risk Management:**\n' +
              '• Never risk more than 5% on one trade\n' +
              '• Check liquidity before sizing\n' +
              '• Diversify across uncorrelated markets'
          },
          { 
            name: '💬 Chat Tips', 
            value: 
              '• I respond to @mentions and "Cortana"\n' +
              '• Type "help" anytime for a quick refresher\n' +
              '• Rate limited to 10 messages/minute to keep things smooth'
          }
        );
        break;
        
      default:
        // Main help menu
        embed.addFields(
          { 
            name: '📊 Trading Intelligence', 
            value: 
              '`/pnl` - Portfolio performance\n' +
              '`/positions` - Open positions\n' +
              '`/scan` - Find opportunities\n' +
              '`/analyze [market]` - Market deep dive\n' +
              '`/simulate [market] [amount]` - Trade modeling'
          },
          { 
            name: '🧠 AI Assistant', 
            value: 
              '`/ask [question]` - Ask anything\n' +
              '`/explain [topic]` - Learn strategies\n' +
              '`@Cortana [message]` - Chat naturally'
          },
          { 
            name: '🎯 Example Questions', 
            value: 
              '• "What\'s my P&L?"\n' +
              '• "Explain Kelly Criterion"\n' +
              '• "Should I trade the Iran market?"\n' +
              '• "What strategies are working best?"\n' +
              '• "Simulate $500 on BTC $100K"'
          }
        );
    }

    // Create navigation buttons
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('help_trading')
          .setLabel('📊 Trading')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('help_ai')
          .setLabel('🧠 AI Features')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('help_strategies')
          .setLabel('🎯 Strategies')
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId('help_tips')
          .setLabel('⚡ Tips')
          .setStyle(ButtonStyle.Secondary)
      );

    await interaction.reply({ 
      embeds: [embed], 
      components: [row],
      ephemeral: false
    });
  }
};
