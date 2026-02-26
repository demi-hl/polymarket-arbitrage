/**
 * Polymarket Arbitrage Bot - Notification System
 * Real-time alerts for trading opportunities and execution results
 */

const axios = require('axios');
const EventEmitter = require('events');

const EMOJI = {
  rocket: '🚀',
  money: '💰',
  chart: '📊',
  warning: '⚠️',
  error: '❌',
  success: '✅',
  bell: '🔔',
  fire: '🔥',
  think: '🤔',
  wave: '👋'
};

class Notifier extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.telegramToken = process.env.TELEGRAM_BOT_TOKEN || options.telegramToken;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID || options.telegramChatId;
    this.slackWebhook = process.env.SLACK_WEBHOOK_URL || options.slackWebhook;
    
    this.rateLimitMap = new Map();
    this.batchQueue = [];
    this.batchTimer = null;
    this.batchFlushInterval = 60000; // 60 seconds
    
    this.thresholds = {
      critical: { minEdge: 0.15 },
      high: { minEdge: 0.10 },
      normal: { minEdge: 0.05 }
    };
    
    this.startBatchTimer();
  }

  async alert(level, data) {
    const upperLevel = level.toUpperCase();
    
    if (this.isQuietHours() && upperLevel !== 'CRITICAL') {
      return { sent: false, reason: 'quiet_hours' };
    }
    
    if (this.isRateLimited(data.market, upperLevel)) {
      return { sent: false, reason: 'rate_limited' };
    }

    const message = this.formatMessage(upperLevel, data);
    
    const results = [];
    if (upperLevel === 'CRITICAL' && this.telegramToken) {
      try {
        await this.sendTelegram(message);
        results.push({ channel: 'telegram', success: true });
      } catch (err) {
        results.push({ channel: 'telegram', success: false, error: err.message });
      }
    }
    
    if (this.slackWebhook) {
      try {
        await this.sendSlack({ text: message });
        results.push({ channel: 'slack', success: true });
      } catch (err) {
        results.push({ channel: 'slack', success: false, error: err.message });
      }
    }
    
    this.updateRateLimit(data.market, upperLevel);
    this.emit('alert', { level: upperLevel, market: data.market, results });
    
    return { sent: results.some(r => r.success), level: upperLevel, results };
  }

  async tradeExecuted(trade) {
    const message = `${EMOJI.success} TRADE EXECUTED\n\n` +
      `Market: ${trade.question?.substring(0, 50)}...\n` +
      `Edge: ${(trade.edgePercent * 100).toFixed(2)}%\n` +
      `Size: $${trade.totalCost?.toFixed(2)}\n` +
      `Expected Profit: $${trade.expectedProfit?.toFixed(2)}`;
    
    if (this.telegramToken) {
      try { await this.sendTelegram(message); } catch (e) {}
    }
  }

  async pnlUpdate(pnl) {
    const emoji = pnl.total >= 0 ? EMOJI.money : EMOJI.warning;
    const message = `${emoji} P&L UPDATE\n\n` +
      `Realized: $${pnl.realized?.toFixed(2)}\n` +
      `Unrealized: $${pnl.unrealized?.toFixed(2)}\n` +
      `Total: $${pnl.total?.toFixed(2)}`;
    
    if (this.slackWebhook) {
      try { await this.sendSlack({ text: message }); } catch (e) {}
    }
  }

  async sendDailySummary(data) {
    const message = `${EMOJI.chart} DAILY SUMMARY\n\n` +
      `Total Trades: ${data.totalTrades || 0}\n` +
      `Win Rate: ${data.winRate || 0}%\n` +
      `P&L: $${(data.pnl || 0).toFixed(2)}\n` +
      `Open Positions: ${data.openPositions || 0}`;
    
    const results = [];
    if (this.telegramToken) {
      try { await this.sendTelegram(message); results.push({ channel: 'telegram', success: true }); } catch (e) { results.push({ channel: 'telegram', success: false }); }
    }
    if (this.slackWebhook) {
      try { await this.sendSlack({ text: message }); results.push({ channel: 'slack', success: true }); } catch (e) { results.push({ channel: 'slack', success: false }); }
    }
    
    return { sent: results.some(r => r.success), results };
  }

  async error(error, context = '') {
    const message = `${EMOJI.error} ERROR${context ? ` - ${context}` : ''}\n\n${error.message || error}`;
    
    if (this.telegramToken) {
      try { await this.sendTelegram(message); } catch (e) {}
    }
    if (this.slackWebhook) {
      try { await this.sendSlack({ text: message }); } catch (e) {}
    }
  }

  formatMessage(level, data) {
    const edge = data.edge || data.edgePercent || 0;
    const edgeStr = (edge * 100).toFixed(2);
    
    switch (level) {
      case 'CRITICAL':
        return `${EMOJI.fire}${EMOJI.fire} CRITICAL ARBITRAGE ${EMOJI.fire}${EMOJI.fire}\n\n` +
          `Market: ${data.question || data.market}\n` +
          `Edge: ${edgeStr}%\n` +
          `Liquidity: $${(data.liquidity || 0).toLocaleString()}\n` +
          `Action: ${EMOJI.rocket} EXECUTE NOW`;
      case 'HIGH':
        return `${EMOJI.rocket} HIGH OPPORTUNITY\n\n` +
          `Market: ${data.question || data.market}\n` +
          `Edge: ${edgeStr}%\n` +
          `Liquidity: $${(data.liquidity || 0).toLocaleString()}`;
      default:
        return `${EMOJI.money} Arbitrage Opportunity\n\n` +
          `Market: ${data.question || data.market}\n` +
          `Edge: ${edgeStr}%`;
    }
  }

  async sendTelegram(message) {
    if (!this.telegramToken) return false;
    
    const url = `https://api.telegram.org/bot${this.telegramToken}/sendMessage`;
    const response = await axios.post(url, {
      chat_id: this.telegramChatId,
      text: message,
      parse_mode: 'HTML'
    }, { timeout: 10000 });
    
    return response.data?.ok;
  }

  async sendSlack(payload) {
    if (!this.slackWebhook) return false;
    
    const response = await axios.post(this.slackWebhook, payload, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json' }
    });
    
    return response.status === 200;
  }

  isQuietHours() {
    const hour = new Date().getHours();
    return hour >= 22 || hour < 8;
  }

  isRateLimited(market, level) {
    const key = `${market}:${level}`;
    const lastAlert = this.rateLimitMap.get(key);
    if (!lastAlert) return false;
    
    const intervals = { critical: 1, high: 5, normal: 15 };
    const intervalMs = (intervals[level.toLowerCase()] || 5) * 60 * 1000;
    return (Date.now() - lastAlert) < intervalMs;
  }

  updateRateLimit(market, level) {
    const key = `${market}:${level}`;
    this.rateLimitMap.set(key, Date.now());
  }

  startBatchTimer() {
    this.batchTimer = setInterval(() => {
      this.flushBatch();
    }, this.batchFlushInterval);
  }

  async flushBatch() {
    if (this.batchQueue.length === 0) return;
    
    const fills = [...this.batchQueue];
    this.batchQueue = [];
    
    const totalPnl = fills.reduce((sum, f) => sum + (f.pnl || 0), 0);
    const message = `${EMOJI.chart} BATCH UPDATE (${fills.length} trades)\n\n` +
      `Total P&L: $${totalPnl.toFixed(2)}`;
    
    if (this.slackWebhook) {
      try { await this.sendSlack({ text: message }); } catch (e) {}
    }
  }

  async critical(data) { return this.alert('CRITICAL', data); }
  async high(data) { return this.alert('HIGH', data); }
  async normal(data) { return this.alert('NORMAL', data); }

  destroy() {
    if (this.batchTimer) clearInterval(this.batchTimer);
    this.removeAllListeners();
  }
}

module.exports = Notifier;
