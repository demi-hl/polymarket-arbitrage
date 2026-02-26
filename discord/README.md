# Discord Integration for Polymarket Arbitrage Bot

Real-time notifications and slash commands for monitoring your arbitrage bot.

## Features

### 🔔 Automatic Alerts
- **Trade Executed**: "Bought YES @ 45¢, +$50 P&L"
- **Opportunity Found**: "🔥 15% edge on BTC $100K"
- **Daily Summary**: "Today's P&L: +$247"
- **System Errors**: "Scanner down, restarting..."
- **Position Closed**: Win/Loss notifications with ROI

### 🤖 Slash Commands
| Command | Description |
|---------|-------------|
| `/status` | Bot connection and system status |
| `/pnl` | Show P&L summary and performance metrics |
| `/positions` | List all open positions |
| `/strategies` | Show all 24 trading strategies |
| `/scan` | Trigger manual market scan (optional threshold) |

## Setup

### 1. Create Discord Bot
1. Go to https://discord.com/developers/applications
2. Click "New Application" and name it
3. Go to "Bot" section and click "Add Bot"
4. Copy the **Bot Token** (keep this secret!)
5. Enable "Message Content Intent" under Privileged Gateway Intents

### 2. Invite Bot to Server
1. Go to "OAuth2" → "URL Generator"
2. Select scopes: `bot`, `applications.commands`
3. Select permissions:
   - Send Messages
   - Read Message History
   - Embed Links
   - Use Slash Commands
4. Copy the generated URL and open it in browser
5. Select your server and authorize

### 3. Get Channel ID
1. Enable Developer Mode: User Settings → Advanced → Developer Mode
2. Right-click your alert channel → "Copy Channel ID"
3. Paste into `.env` file

### 4. Configure Environment
```bash
# .env
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_CHANNEL_ID=your_channel_id_here
DISCORD_ALERT_THRESHOLD=0.05  # Only alert on 5%+ edges
```

### 5. Register Slash Commands
```bash
node discord/deploy-commands.js
```

## Usage

### Basic Integration
```javascript
const { createDiscordBot } = require('./discord');
const PolymarketArbitrageBot = require('./bot');

// Initialize Discord
const discord = createDiscordBot();
await discord.init();

// Initialize trading bot
const bot = new PolymarketArbitrageBot({ mode: 'paper' });

// Wire up events
bot.on('trade:executed', ({ trade }) => {
  discord.sendTradeAlert(trade);
});

bot.on('position:closed', (position) => {
  discord.sendPositionClosed(position);
});
```

### Send Custom Alerts
```javascript
// System notifications
discord.sendSystemAlert('🚀 Bot started', 'success');
discord.sendSystemAlert('⚠️ Low liquidity detected', 'warning');
discord.sendSystemAlert('❌ API connection failed', 'error');

// Daily summary
discord.sendDailySummary(portfolio);

// Opportunity alert
discord.sendOpportunityAlert({
  question: 'Will BTC hit $100K?',
  yesPrice: 0.45,
  noPrice: 0.52,
  edgePercent: 0.03,
  liquidity: 50000
});
```

## API Endpoints

When using the built-in server, these endpoints are available:

```
POST /api/discord/daily-summary    # Send daily P&L to Discord
POST /api/discord/alert            # Send custom alert
GET  /api/discord/status           # Get Discord connection status
POST /api/scan                     # Trigger scan with Discord alerts
```

## Alert Thresholds

Control which alerts are sent via environment variables:

```bash
DISCORD_ALERT_TRADES=true          # Trade execution alerts
DISCORD_ALERT_OPPORTUNITIES=true   # Opportunity detection (10%+ edges)
DISCORD_ALERT_DAILY_SUMMARY=true   # Daily P&L summary
DISCORD_ALERT_ERRORS=true          # System error alerts
DISCORD_ALERT_THRESHOLD=0.10       # Minimum edge % for opportunity alerts
```

## Testing

Run the test suite:
```bash
npm test -- discord/
```

Manual test:
```bash
node -e "
const { createDiscordBot } = require('./discord');
const discord = createDiscordBot();
discord.init().then(() => {
  discord.sendSystemAlert('✅ Discord integration test successful!', 'success');
});
"
```

## Troubleshooting

### Bot not responding to commands
1. Check if bot has `applications.commands` scope
2. Re-run `node discord/deploy-commands.js`
3. Wait up to 1 hour for global commands to sync

### Alerts not sending
1. Verify `DISCORD_CHANNEL_ID` is correct
2. Check bot has permission to send messages in that channel
3. Check bot token is valid (not expired)

### Slash commands not appearing
1. Kick and re-invite bot with correct permissions
2. Use guild-specific commands for faster sync (see deploy-commands.js)

## Architecture

```
discord/
├── bot.js           # Discord client and alert methods
├── commands.js      # Slash command definitions
├── index.js         # Module exports
└── README.md        # This file
```

The Discord bot runs alongside the trading bot and listens for:
- API endpoint calls
- Direct method invocations
- Trading bot events (when wired up)

Alerts are queued and processed every 5 seconds to avoid rate limits.
