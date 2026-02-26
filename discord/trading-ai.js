const axios = require('axios');
const PolymarketArbitrageBot = require('../bot');
const PolymarketScanner = require('../scanner');
const { ALL_STRATEGIES } = require('../strategies');

/**
 * TradingAI - AI-powered trading assistant with Cortana personality
 * 
 * Handles:
 * - Natural language understanding for trading queries
 * - P&L retrieval and analysis
 * - Strategy explanations
 * - Market analysis
 * - Trade simulation
 */

const CORTANA_PERSONALITY = `You are Cortana, an AI trading assistant with the following personality:

**Voice & Tone:**
- Competent and direct — no fluff, get to the point
- Slightly witty but never cheesy
- Confident in your analysis but not arrogant
- Use casual, modern language ("Hey", "Here's the deal", "Bottom line")
- Occasional tech/trading slang is fine ("alpha", "edge", "ape in")

**Response Style:**
- Lead with the answer, explain after
- Use bullet points for data
- Bold key numbers and insights
- Keep responses concise (2-4 paragraphs max)
- End with actionable takeaways when relevant

**Trading Philosophy:**
- Risk management first
- Edge is everything
- Diversification matters
- Don't FOMO, don't panic

**Signature Sign-off:**
Occasionally end with "🎓" (crown emoji) or nothing at all — vary it up.`;

const TRADING_KNOWLEDGE_BASE = {
  strategies: {
    'basic-arbitrage': {
      name: 'Basic Arbitrage',
      description: 'Exploits price discrepancies between YES and NO tokens when they don\'t sum to $1.',
      risk: 'Low',
      explanation: `**Basic Arbitrage** exploits the fundamental pricing error when YES + NO != $1.

**How it works:**
• Buy both YES and NO when their sum is less than $1
• Guaranteed profit at resolution (you're paid $1 for $0.98 spent)
• Edge = 1 - (YES_price + NO_price)

**Example:**
- YES trading at $0.48
- NO trading at $0.49
- Sum = $0.97
- Buy both for $0.97 → collect $1 at resolution
- **Guaranteed 3.09% return**

**Risk:** Very low (guaranteed if prices hold)`
    },
    'cross-market-arbitrage': {
      name: 'Cross-Market Arbitrage',
      description: 'Arbitrage between Polymarket and other prediction markets (Kalshi, PredictIt).',
      risk: 'Low',
      explanation: `**Cross-Market Arbitrage** exploits price differences across platforms.

**How it works:**
• Same event, different prices on different exchanges
• Buy low on one, sell high on the other
• Lock in risk-free profit

**Platforms:**
- **Polymarket:** 0% fees, highest liquidity
- **Kalshi:** 0% fees (great for arbitrage)
- **PredictIt:** 10% fees, $850 contract limit

**Example:**
- Trump YES on Polymarket: $0.52
- Trump YES on PredictIt: $0.58
- Buy on Poly, sell on PredictIt → 11.5% edge (minus fees)

**Risk:** Low (execution risk, fees)`
    },
    'kelly-criterion': {
      name: 'Kelly Criterion',
      description: 'Optimal bet sizing formula to maximize long-term growth.',
      risk: 'N/A (sizing strategy)',
      explanation: `**Kelly Criterion** tells you exactly how much to bet.

**Formula:**
\`f* = (bp - q) / b\`

Where:
- f* = fraction of bankroll to bet
- b = odds received (decimal)
- p = probability of winning
- q = probability of losing (1 - p)

**Example:**
- You think Trump has 60% chance to win (p = 0.6)
- Market prices imply 52% (b = 0.48/0.52 ≈ 0.92)
- q = 0.4
- f* = (0.92 × 0.6 - 0.4) / 0.92 = **20% of bankroll**

**Pro tip:** Most traders use "Half Kelly" (10%) to reduce volatility`
    },
    'temporal-arbitrage': {
      name: 'Temporal Arbitrage',
      description: 'Exploits time-based price movements before key events.',
      risk: 'Medium',
      explanation: `**Temporal Arbitrage** profits from price movements as events approach.

**How it works:**
• Markets often misprice time value
• Volatility increases as resolution approaches
• Buy/sell based on expected price trajectory

**Typical patterns:**
- **Pre-debate:** Prices volatile, opportunities high
- **Post-debate:** Initial overreaction, mean reversion
- **Day before resolution:** Convergence to true probability

**Example:**
- Debate in 3 days, current YES at 45%
- You expect YES to hit 55% post-debate
- Buy now, sell after spike

**Risk:** Medium (event uncertainty, timing)`
    },
    'news-sentiment': {
      name: 'News Sentiment',
      description: 'Trades on market over/under-reaction to news events.',
      risk: 'Medium',
      explanation: `**News Sentiment** trades the gap between news impact and market reaction.

**How it works:**
• Monitor news/social for event-relevant info
• Identify when market hasn't fully priced in new information
• Trade before the crowd catches up

**Key sources:**
- Twitter/X sentiment
- News APIs
- Poll releases
- Economic indicators

**Example:**
- Breaking: Candidate drops out
- Market hasn't moved yet
- Fast execution on related markets

**Risk:** Medium (speed matters, false signals)`
    },
    'whale-tracker': {
      name: 'Whale Tracker',
      description: 'Follows large trader movements for signal.',
      risk: 'High',
      explanation: `**Whale Tracker** follows the smart money.

**How it works:**
• Monitor large position changes on-chain
- Large buys = potential insider knowledge
- Large sells = potential early exit

**Limitations:**
- Whales can be wrong
- Could be hedging, not directional bets
- Flash loans can fake volume

**Risk:** High (whales aren't always right)`
    }
  },
  
  concepts: {
    'edge': {
      name: 'Edge',
      explanation: `**Edge** is your mathematical advantage — the difference between the market price and your estimated true probability.

**Formula:**
\`Edge = (Your Probability × Payout) - Cost\`

**Example:**
- Market: YES at $0.52 (implies 52% chance)
- Your model: 60% chance
- Payout: $1 per share
- Edge = (0.60 × $1) - $0.52 = **$0.08 per share (15.4%)**

**Rule of thumb:**
- < 2% edge: Pass
- 2-5% edge: Small position
- 5-10% edge: Medium position
- > 10% edge: Large position (if liquid)`
    },
    'implied-probability': {
      name: 'Implied Probability',
      explanation: `**Implied Probability** is what the market thinks the chance of an event is.

**Formula:**
\`Implied Probability = Price / Payout\`

**Example:**
- YES token at $0.65
- Payout at resolution = $1
- Implied probability = 65%

**Interpretation:**
- If your probability > implied → Buy YES
- If your probability < implied → Buy NO (or sell YES)
- This is your edge calculation`
    },
    'liquidity': {
      name: 'Liquidity',
      explanation: `**Liquidity** determines how much you can trade without moving the price.

**On Polymarket:**
- Measured in USD
- Higher = easier to enter/exit large positions
- Low liquidity = slippage (you pay more than quoted)

**Rules:**
- Don't take more than 5% of liquidity
- $10K+ liquidity = good for most trades
- <$1K liquidity = retail only

**Slippage formula:**
\`Slippage ≈ Position Size / Liquidity\``
    }
  }
};

class TradingAI {
  constructor(config = {}) {
    this.providers = this.buildProviderChain(config);
    this.conversationHistory = new Map();
    this.maxHistoryPerUser = config.maxHistory || 20;
    this.bot = null; // Lazy loaded
    this.scanner = null; // Lazy loaded
  }

  buildProviderChain(config) {
    const providers = [];

    if (config.moonshotApiKey || process.env.MOONSHOT_API_KEY) {
      providers.push({
        name: 'moonshot',
        baseUrl: config.moonshotBaseUrl || process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1',
        apiKey: config.moonshotApiKey || process.env.MOONSHOT_API_KEY,
        model: config.moonshotModel || process.env.MOONSHOT_MODEL || 'kimi-k2.5'
      });
    }

    if (config.openaiApiKey || process.env.OPENAI_API_KEY) {
      providers.push({
        name: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: config.openaiApiKey || process.env.OPENAI_API_KEY,
        model: config.openaiModel || process.env.OPENAI_MODEL || 'gpt-4-turbo'
      });
    }

    if (config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL) {
      providers.push({
        name: 'ollama',
        baseUrl: config.ollamaBaseUrl || process.env.OLLAMA_BASE_URL,
        apiKey: 'ollama',
        model: config.ollamaModel || process.env.OLLAMA_MODEL || 'qwen3:14b'
      });
    }

    return providers;
  }

  getHistory(userId) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }
    return this.conversationHistory.get(userId);
  }

  addToHistory(userId, message) {
    const history = this.getHistory(userId);
    history.push(message);
    if (history.length > this.maxHistoryPerUser) {
      history.splice(0, history.length - this.maxHistoryPerUser);
    }
  }

  clearContext(userId) {
    this.conversationHistory.delete(userId);
  }

  async callProvider(provider, messages) {
    const body = {
      model: provider.model,
      messages,
      max_tokens: 2048,
      temperature: 0.7
    };

    const response = await axios.post(
      `${provider.baseUrl}/chat/completions`,
      body,
      {
        headers: {
          'Authorization': `Bearer ${provider.apiKey}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    return response.data;
  }

  async process(userId, message, options = {}) {
    // Parse intent and route to appropriate handler
    const intent = this.parseIntent(message);
    
    switch (intent.type) {
      case 'pnl':
        return this.handlePnLQuery(userId, message, options);
      case 'positions':
        return this.handlePositionsQuery(userId, message, options);
      case 'explain':
        return this.handleExplainQuery(userId, intent.target, options);
      case 'analyze':
        return this.handleAnalyzeQuery(userId, intent.target, options);
      case 'simulate':
        return this.handleSimulateQuery(userId, intent, options);
      case 'advice':
        return this.handleAdviceQuery(userId, intent.target, options);
      case 'scan':
        return this.handleScanQuery(userId, options);
      case 'strategies':
        return this.handleStrategiesQuery(userId, options);
      default:
        return this.handleGeneralQuery(userId, message, options);
    }
  }

  parseIntent(message) {
    const lower = message.toLowerCase();
    
    // P&L queries
    if (/\bpnl\b|\bp&l\b|\bprofit\b|\bperformance\b|\bhow('s|s)? (am i|are we|am i) doing\b|\bportfolio\b/.test(lower)) {
      return { type: 'pnl' };
    }
    
    // Positions queries
    if (/\bpositions?\b|\bopen positions?\b|\bholdings?\b|\bwhat do i (own|have)\b/.test(lower)) {
      return { type: 'positions' };
    }
    
    // Explain queries
    const explainMatch = lower.match(/(?:explain|what is|how does|describe)\s+(?:the\s+)?(kelly|criterion|basic arbitrage|cross.?market|temporal|news sentiment|whale|edge|implied probability|liquidity|resolution arbitrage|settlement|funding rate|correlation|cointegration|mean reversion|volatility|momentum|pairs trading|orderbook|flow|latency|kalshi|predictit)?/);
    if (explainMatch) {
      return { type: 'explain', target: explainMatch[1] };
    }
    
    // Analyze queries
    const analyzeMatch = lower.match(/(?:analyze|look at|check|what about|tell me about)\s+(?:the\s+)?(.+?)(?:\s+market|\s+question)?$/);
    if (analyzeMatch) {
      return { type: 'analyze', target: analyzeMatch[1].trim() };
    }
    
    // Simulate queries
    const simMatch = lower.match(/(?:simulate|what if|model)\s+\$?(\d+)\s+(?:on|for|in)\s+(.+)/);
    if (simMatch) {
      return { type: 'simulate', amount: parseFloat(simMatch[1]), target: simMatch[2].trim() };
    }
    
    // Advice queries
    const adviceMatch = lower.match(/(?:should i|would you|is it worth|recommend).+?(trade|buy|enter|invest| ape).+?\b(.+)/);
    if (adviceMatch) {
      return { type: 'advice', target: adviceMatch[2].trim() };
    }
    
    // Scan queries
    if (/\bscan\b|\bopportunities?\b|\bfind\b|\bany good\b|\bwhat('s|s) out there\b/.test(lower)) {
      return { type: 'scan' };
    }
    
    // Strategies list
    if (/\bstrategies?\b|\bwhat strategies\b|\bmethods\b/.test(lower)) {
      return { type: 'strategies' };
    }
    
    return { type: 'general' };
  }

  async handlePnLQuery(userId, message, options) {
    try {
      if (!this.bot) {
        this.bot = new PolymarketArbitrageBot({ mode: 'paper' });
      }
      
      const report = await this.bot.generateReport();
      const totalReturn = parseFloat(report.portfolio.totalReturn);
      const isPositive = totalReturn >= 0;
      
      const response = `**Your P&L Summary** 📊

**Portfolio Value:** $${report.portfolio.cash.toFixed(2)}
**Total Return:** ${isPositive ? '+' : ''}${report.portfolio.totalReturn}
**Realized P&L:** $${report.pnl.realized.toFixed(2)}
**Unrealized P&L:** $${report.pnl.unrealized.toFixed(2)}

**Performance:**
• Total Trades: ${report.performance.totalTrades}
• Win Rate: ${report.performance.winRate}
• Winning Trades: ${report.performance.winningTrades}
• Losing Trades: ${report.performance.losingTrades}
• Profit Factor: ${report.performance.profitFactor}

**Open Positions:** ${report.portfolio.openPositions}
**Closed Positions:** ${report.portfolio.closedPositions}

${isPositive ? '📈 Nice work! You\'re beating the market.' : '📉 Rough patch, but variance is part of the game.'}

${report.recentTrades.length > 0 ? `**Latest Trade:** ${report.recentTrades[0].question?.substring(0, 50)}...` : ''}`;

      return { response, context: { lastQuery: 'pnl', report } };
    } catch (error) {
      return { response: `Couldn't fetch your P&L right now. Error: ${error.message}`, context: {} };
    }
  }

  async handlePositionsQuery(userId, message, options) {
    try {
      if (!this.bot) {
        this.bot = new PolymarketArbitrageBot({ mode: 'paper' });
      }
      
      const portfolio = this.bot.getPortfolio();
      const openPositions = Object.values(portfolio.positions).filter(p => p.status === 'open');
      
      if (openPositions.length === 0) {
        return { 
          response: `📭 **No open positions.**\n\nYou're all cash ($${portfolio.cash.toFixed(2)}). The bot is scanning for opportunities...`,
          context: { lastQuery: 'positions', openCount: 0 }
        };
      }
      
      let response = `**Open Positions (${openPositions.length})** 📊\n\n`;
      response += `**Unrealized P&L:** $${portfolio.pnl.unrealized.toFixed(2)}\n\n`;
      
      openPositions.slice(0, 10).forEach((pos, i) => {
        response += `**${i + 1}.** ${pos.question?.substring(0, 60)}${pos.question?.length > 60 ? '...' : ''}\n`;
        response += `   YES: ${pos.yesShares?.toFixed(2) || 0} shares | NO: ${pos.noShares?.toFixed(2) || 0} shares\n`;
        response += `   Entry: $${pos.entryCost?.toFixed(2) || 0}\n\n`;
      });
      
      if (openPositions.length > 10) {
        response += `*... and ${openPositions.length - 10} more positions*\n`;
      }
      
      return { response, context: { lastQuery: 'positions', openCount: openPositions.length } };
    } catch (error) {
      return { response: `Couldn't fetch positions. Error: ${error.message}`, context: {} };
    }
  }

  async handleExplainQuery(userId, target, options) {
    // Normalize target
    const normalizedTarget = target?.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
    
    // Check strategies
    let content = TRADING_KNOWLEDGE_BASE.strategies[normalizedTarget];
    
    // Check concepts
    if (!content) {
      content = TRADING_KNOWLEDGE_BASE.concepts[normalizedTarget];
    }
    
    // Check for partial matches
    if (!content) {
      const strategyKeys = Object.keys(TRADING_KNOWLEDGE_BASE.strategies);
      const conceptKeys = Object.keys(TRADING_KNOWLEDGE_BASE.concepts);
      
      const matchingStrategy = strategyKeys.find(k => k.includes(normalizedTarget) || normalizedTarget?.includes(k));
      const matchingConcept = conceptKeys.find(k => k.includes(normalizedTarget) || normalizedTarget?.includes(k));
      
      if (matchingStrategy) {
        content = TRADING_KNOWLEDGE_BASE.strategies[matchingStrategy];
      } else if (matchingConcept) {
        content = TRADING_KNOWLEDGE_BASE.concepts[matchingConcept];
      }
    }
    
    if (content) {
      return { 
        response: content.explanation || content.description,
        context: { lastQuery: 'explain', topic: target }
      };
    }
    
    // Fallback to AI
    return this.handleGeneralQuery(userId, `Explain ${target} in the context of prediction market trading`, options);
  }

  async handleAnalyzeQuery(userId, target, options) {
    try {
      if (!this.scanner) {
        this.scanner = new PolymarketScanner();
      }
      
      // Scan for markets matching target
      const result = await this.scanner.scan({ threshold: 0.01 });
      
      // Find markets matching the target query
      const matchingMarkets = result.opportunities.filter(opp => 
        opp.question.toLowerCase().includes(target.toLowerCase()) ||
        opp.category?.toLowerCase().includes(target.toLowerCase())
      );
      
      if (matchingMarkets.length === 0) {
        return {
          response: `🔍 **No markets found matching "${target}"**\n\nTry scanning for all opportunities with "/scan" or ask about a specific market.`,
          context: { lastQuery: 'analyze', target }
        };
      }
      
      const topMarket = matchingMarkets[0];
      const edgePercent = (topMarket.edgePercent * 100).toFixed(2);
      
      let response = `**Market Analysis: ${target}** 🔍\n\n`;
      response += `**${topMarket.question.substring(0, 80)}${topMarket.question.length > 80 ? '...' : ''}**\n\n`;
      response += `**Prices:**\n`;
      response += `• YES: ${(topMarket.yesPrice * 100).toFixed(1)}¢\n`;
      response += `• NO: ${(topMarket.noPrice * 100).toFixed(1)}¢\n`;
      response += `• Sum: ${((topMarket.yesPrice + topMarket.noPrice) * 100).toFixed(1)}¢\n\n`;
      response += `**Key Metrics:**\n`;
      response += `• Edge: **${edgePercent}%**\n`;
      response += `• Liquidity: $${(topMarket.liquidity / 1000).toFixed(1)}K\n`;
      response += `• Max Position: $${topMarket.maxPosition.toFixed(0)}\n\n`;
      
      if (matchingMarkets.length > 1) {
        response += `*Found ${matchingMarkets.length} matching markets. Showing the highest edge.*\n\n`;
      }
      
      response += edgePercent >= 5 ? 
        `🔥 **Strong edge detected!** Worth considering if you believe in the thesis.` :
        edgePercent >= 2 ?
        `⚡ **Moderate edge.** Doable but check liquidity first.` :
        `💡 **Low edge.** Better opportunities probably exist.`;
      
      return { response, context: { lastQuery: 'analyze', target, markets: matchingMarkets } };
    } catch (error) {
      return { response: `Analysis failed: ${error.message}`, context: {} };
    }
  }

  async handleSimulateQuery(userId, intent, options) {
    const { amount, target } = intent;
    
    try {
      if (!this.scanner) {
        this.scanner = new PolymarketScanner();
      }
      
      // Find market matching target
      const result = await this.scanner.scan({ threshold: 0.01 });
      const market = result.opportunities.find(opp => 
        opp.question.toLowerCase().includes(target.toLowerCase())
      );
      
      if (!market) {
        return {
          response: `Couldn't find a market matching "${target}" to simulate. Try "/scan" to see available markets.`,
          context: { lastQuery: 'simulate', target, amount }
        };
      }
      
      // Simulate the trade
      const yesSize = amount / 2;
      const noSize = amount / 2;
      const yesShares = yesSize / market.yesPrice;
      const noShares = noSize / market.noPrice;
      const expectedProfit = amount * market.edgePercent;
      const roi = (market.edgePercent * 100).toFixed(2);
      
      let response = `**Trade Simulation: $${amount} on ${target.substring(0, 40)}...** 💡\n\n`;
      response += `**Market:** ${market.question.substring(0, 60)}...\n\n`;
      response += `**Execution:**\n`;
      response += `• YES: $${yesSize.toFixed(2)} → ${yesShares.toFixed(2)} shares @ ${(market.yesPrice * 100).toFixed(1)}¢\n`;
      response += `• NO: $${noSize.toFixed(2)} → ${noShares.toFixed(2)} shares @ ${(market.noPrice * 100).toFixed(1)}¢\n`;
      response += `• Total Cost: $${amount.toFixed(2)}\n\n`;
      response += `**Expected Outcome:**\n`;
      response += `• Expected Profit: **$${expectedProfit.toFixed(2)}**\n`;
      response += `• ROI: **${roi}%**\n\n`;
      response += `**Scenario Analysis:**\n`;
      response += `• If YES resolves: Payout = $${yesShares.toFixed(2)} | Profit = $${(yesShares - amount).toFixed(2)}\n`;
      response += `• If NO resolves: Payout = $${noShares.toFixed(2)} | Profit = $${(noShares - amount).toFixed(2)}\n`;
      response += `• Arbitrage profit: **$${expectedProfit.toFixed(2)}** (if YES+NO < $1)\n\n`;
      
      response += roi >= 5 ? 
        `✅ **Solid play.** Edge is strong, proceed with confidence.` :
        roi >= 2 ?
        `⚠️ **Marginal.** Works if you have conviction, but tight.` :
        `❌ **Skip it.** Edge too low for the risk.`;
      
      return { response, context: { lastQuery: 'simulate', target, amount, market } };
    } catch (error) {
      return { response: `Simulation failed: ${error.message}`, context: {} };
    }
  }

  async handleAdviceQuery(userId, target, options) {
    try {
      if (!this.scanner) {
        this.scanner = new PolymarketScanner();
      }
      
      const result = await this.scanner.scan({ threshold: 0.01 });
      const market = result.opportunities.find(opp => 
        opp.question.toLowerCase().includes(target.toLowerCase())
      );
      
      if (!market) {
        return {
          response: `I don't see an active market for "${target}" right now. Want me to scan for similar opportunities?`,
          context: { lastQuery: 'advice', target }
        };
      }
      
      const edgePercent = (market.edgePercent * 100).toFixed(1);
      const recommendation = market.edgePercent >= 0.05 ? 
        '**Take it.** Edge is solid and liquidity looks good.' :
        market.edgePercent >= 0.02 ?
        '**Maybe.** Edge is there but thin. Small position only.' :
        '**Pass.** Better opportunities out there. Patience pays.';
      
      let response = `**Trading Advice: ${target}** 🎯\n\n`;
      response += `Current edge: **${edgePercent}%**\n\n`;
      response += `**My take:** ${recommendation}\n\n`;
      response += `**Market data:**\n`;
      response += `• YES: ${(market.yesPrice * 100).toFixed(1)}¢ | NO: ${(market.noPrice * 100).toFixed(1)}¢\n`;
      response += `• Liquidity: $${(market.liquidity / 1000).toFixed(1)}K\n`;
      response += `• Category: ${market.category || 'Unknown'}\n\n`;
      response += `Remember: 5% edge threshold is my default. Your risk tolerance may vary. 🎓`;
      
      return { response, context: { lastQuery: 'advice', target, market } };
    } catch (error) {
      return { response: `Couldn't analyze: ${error.message}`, context: {} };
    }
  }

  async handleScanQuery(userId, options) {
    try {
      if (!this.scanner) {
        this.scanner = new PolymarketScanner();
      }
      
      await this.scanner.scan({ threshold: 0.05 });
      
      // This is handled by the bot's alert system, but we provide a summary
      return {
        response: `🔍 **Scan initiated.**\n\nCheck the main channel for opportunity alerts, or use "/analyze [market]" for specifics.`,
        context: { lastQuery: 'scan' }
      };
    } catch (error) {
      return { response: `Scan failed: ${error.message}`, context: {} };
    }
  }

  async handleStrategiesQuery(userId, options) {
    let response = `**Available Trading Strategies** 🎯\n\n`;
    
    // Group by type
    const byType = {};
    for (const strategy of ALL_STRATEGIES) {
      if (!byType[strategy.type]) byType[strategy.type] = [];
      byType[strategy.type].push(strategy);
    }
    
    for (const [type, strategies] of Object.entries(byType)) {
      const emoji = type === 'fundamental' ? '🔒' : type === 'event' ? '⚡' : type === 'statistical' ? '📊' : type === 'flow' ? '🌊' : '🔄';
      response += `**${emoji} ${type.charAt(0).toUpperCase() + type.slice(1)}** (${strategies.length})\n`;
      
      const lowRisk = strategies.filter(s => s.riskLevel === 'low').length;
      const mediumRisk = strategies.filter(s => s.riskLevel === 'medium').length;
      const highRisk = strategies.filter(s => s.riskLevel === 'high').length;
      
      const riskText = [
        lowRisk > 0 ? `🟢 ${lowRisk} low` : '',
        mediumRisk > 0 ? `🟡 ${mediumRisk} medium` : '',
        highRisk > 0 ? `🔴 ${highRisk} high` : ''
      ].filter(Boolean).join(' | ');
      
      response += `${riskText}\n\n`;
    }
    
    response += `Ask me to "explain [strategy name]" for details on any of these.`;
    
    return { response, context: { lastQuery: 'strategies' } };
  }

  async handleGeneralQuery(userId, message, options) {
    // Check if we have any providers
    if (this.providers.length === 0) {
      return {
        response: `I'm running in knowledge-base mode only (no AI provider configured).\n\nI can help with:\n• P&L queries\n• Position tracking\n• Strategy explanations\n• Market analysis\n• Trade simulation\n\nFor conversational AI, set OPENAI_API_KEY, MOONSHOT_API_KEY, or OLLAMA_BASE_URL.`,
        context: {}
      };
    }

    // Build messages for AI
    const messages = [
      { role: 'system', content: CORTANA_PERSONALITY },
      ...this.getHistory(userId),
      { role: 'user', content: message }
    ];

    let lastError = null;

    for (const provider of this.providers) {
      try {
        const data = await this.callProvider(provider, messages);
        const reply = data.choices?.[0]?.message?.content;
        
        if (reply) {
          this.addToHistory(userId, { role: 'user', content: message });
          this.addToHistory(userId, { role: 'assistant', content: reply });
          
          return {
            response: reply,
            context: { lastQuery: 'general', provider: provider.name }
          };
        }
      } catch (error) {
        lastError = error;
        console.warn(`[TradingAI] ${provider.name} failed: ${error.message}`);
      }
    }

    return {
      response: `All AI providers failed. Last error: ${lastError?.message || 'Unknown'}`,
      context: {}
    };
  }
}

module.exports = TradingAI;
