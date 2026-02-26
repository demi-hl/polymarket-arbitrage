# 🤖 Cortana AI - Discord Trading Bot

An AI-powered Discord bot for Polymarket trading intelligence, inspired by Cortana from Halo.

## Features

### 🧠 Natural Language Understanding
- Chat naturally with Cortana about trading
- Context-aware conversations
- Trading-specific knowledge base
- Cortana personality (competent, direct, witty)

### 📊 Trading Commands
- `/pnl` - Portfolio profit/loss summary
- `/positions` - View open positions
- `/scan` - Scan for arbitrage opportunities
- `/analyze [market]` - Deep market analysis
- `/simulate [market] [amount]` - Trade simulation

### 🧠 AI Commands
- `/ask [question]` - Ask any trading question
- `/explain [topic]` - Learn strategies and concepts
- `/help` - Show all capabilities

### 💬 Natural Chat Examples

```
User: @cortana what's my P&L?
Cortana: You're up $247 today (+2.47%). Your best trade was 
Cross-Market Arbitrage on BTC $100K for +$50.

User: @cortana explain Kelly Criterion
Cortana: Kelly Criterion tells you exactly how much to bet.
Formula: f* = (bp - q) / b
[full explanation follows]

User: @cortana should I trade the Iran market?
Cortana: Current edge is 3%. Below your 5% threshold. 
I'd wait for better opportunities.

User: @cortana what strategies are working best?
Cortana: This week: Cross-Market (+12%), Temporal (+8%), 
Scalping (+5%). Resolution is down -2%.
```

## Setup

### Environment Variables
```env
DISCORD_BOT_TOKEN=your_discord_bot_token
DISCORD_CHANNEL_ID=your_channel_id

# AI Provider (at least one required)
OPENAI_API_KEY=your_openai_key
MOONSHOT_API_KEY=your_moonshot_key
OLLAMA_BASE_URL=http://localhost:11434
```

### Installation
```bash
npm install discord.js axios
```

### Deploy Commands
```bash
node deploy-commands.js
```

### Start Bot
```bash
node discord/index.js
```

## Architecture

```
discord/
├── ai-bot.js           # Main bot class with Discord integration
├── trading-ai.js       # AI engine with trading knowledge base
├── commands/           # Slash commands
│   ├── ask.js         # Natural language queries
│   ├── analyze.js     # Market analysis
│   ├── explain.js     # Strategy explanations
│   ├── help.js        # Help menu
│   ├── pnl.js         # P&L summary
│   ├── positions.js   # Open positions
│   ├── scan.js        # Market scan
│   └── simulate.js    # Trade simulation
├── index.js           # Entry point
└── deploy-commands.js # Command deployment
```

## Trading Knowledge Base

### Strategies
- Basic Arbitrage
- Cross-Market Arbitrage
- Temporal Arbitrage
- Kelly Criterion
- News Sentiment
- Whale Tracker
- And more...

### Concepts
- Edge
- Implied Probability
- Liquidity
- Risk Management

## Safety

- Read-only by default (no subagent spawning)
- No file system access from Discord
- No command execution from Discord
- Rate limiting (10 requests/minute per user)
- Trading actions only through approved channels

## Personality

Cortana is designed to be:
- **Competent and direct** - No fluff, gets to the point
- **Slightly witty** - But never cheesy
- **Confident** - In analysis but not arrogant
- **Casual** - Uses modern language and trading slang
- **Educational** - Explains the "why" behind recommendations

## License

MIT - See parent project license
