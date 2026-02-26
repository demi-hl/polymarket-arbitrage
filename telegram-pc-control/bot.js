/**
 * Telegram PC Control Bot
 * Remote PC control via queue bridge system
 * 
 * Features:
 * - Command whitelisting for safety
 * - Rate limiting (1 command per 5 seconds per user)
 * - Authorized user validation
 * - Queue-based execution via Syncthing bridge
 * - Comprehensive logging
 */

const { Telegraf } = require('telegraf');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

// Import command handlers
const pcCommand = require('./commands/pc');
const pcStatusCommand = require('./commands/pcstatus');
const pcStartCommand = require('./commands/pcstart');
const pcStopCommand = require('./commands/pcstop');
const pcQueueCommand = require('./commands/pcqueue');
const pcResultsCommand = require('./commands/pcresults');

// Configuration
const CONFIG = {
  botToken: process.env.TELEGRAM_PC_BOT_TOKEN,
  allowedUsers: (process.env.TELEGRAM_ALLOWED_USERS || '').split(',').map(id => id.trim()).filter(Boolean),
  queuePath: process.env.QUEUE_BRIDGE_PATH || path.join(require('os').homedir(), 'clawd-local', 'queue'),
  rateLimitMs: 5000, // 5 seconds between commands
  maxQueueWaitTime: 120000, // 2 minutes max wait for result
  checkInterval: 2000, // Check for results every 2 seconds
};

// Validate configuration
function validateConfig() {
  const errors = [];
  if (!CONFIG.botToken) errors.push('TELEGRAM_PC_BOT_TOKEN is required');
  if (CONFIG.allowedUsers.length === 0) errors.push('TELEGRAM_ALLOWED_USERS is required');
  if (errors.length > 0) {
    console.error('❌ Configuration errors:');
    errors.forEach(err => console.error(`   - ${err}`));
    process.exit(1);
  }
  console.log('✅ Configuration validated');
  console.log(`   Allowed users: ${CONFIG.allowedUsers.join(', ')}`);
  console.log(`   Queue path: ${CONFIG.queuePath}`);
}

// Rate limiter
class RateLimiter {
  constructor() {
    this.lastCommandTime = new Map();
  }

  canExecute(userId) {
    const now = Date.now();
    const lastTime = this.lastCommandTime.get(userId) || 0;
    return now - lastTime >= CONFIG.rateLimitMs;
  }

  getRemainingTime(userId) {
    const now = Date.now();
    const lastTime = this.lastCommandTime.get(userId) || 0;
    const remaining = CONFIG.rateLimitMs - (now - lastTime);
    return Math.max(0, Math.ceil(remaining / 1000));
  }

  recordExecution(userId) {
    this.lastCommandTime.set(userId, Date.now());
  }
}

// Logger
class Logger {
  constructor() {
    this.logDir = path.join(__dirname, 'logs');
    this.ensureLogDir();
  }

  async ensureLogDir() {
    try {
      await fs.mkdir(this.logDir, { recursive: true });
    } catch (err) {
      console.error('Failed to create log directory:', err);
    }
  }

  getLogFile() {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `bot-${date}.log`);
  }

  async log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = {
      timestamp,
      level,
      message,
      ...meta
    };
    
    const logLine = JSON.stringify(logEntry);
    
    // Console output
    const colors = {
      INFO: '\x1b[32m',
      WARN: '\x1b[33m',
      ERROR: '\x1b[31m',
      DEBUG: '\x1b[36m'
    };
    console.log(`${colors[level] || ''}[${timestamp}] [${level}] ${message}\x1b[0m`);
    
    // File output
    try {
      await fs.appendFile(this.getLogFile(), logLine + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err);
    }
  }

  info(message, meta) { return this.log('INFO', message, meta); }
  warn(message, meta) { return this.log('WARN', message, meta); }
  error(message, meta) { return this.log('ERROR', message, meta); }
  debug(message, meta) { return this.log('DEBUG', message, meta); }
}

// Queue Bridge Manager
class QueueBridge {
  constructor(queuePath) {
    this.basePath = queuePath;
    this.dirs = {
      pending: path.join(queuePath, 'pending'),
      inProgress: path.join(queuePath, 'in-progress'),
      completed: path.join(queuePath, 'completed'),
      failed: path.join(queuePath, 'failed')
    };
  }

  async ensureDirs() {
    for (const dir of Object.values(this.dirs)) {
      await fs.mkdir(dir, { recursive: true });
    }
  }

  generateTaskId() {
    return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  async submitTask(command, args = [], options = {}) {
    const taskId = this.generateTaskId();
    const task = {
      id: taskId,
      command,
      args,
      options: {
        timeout: options.timeout || 30000,
        workingDir: options.workingDir || null,
        env: options.env || {},
        ...options
      },
      submittedAt: new Date().toISOString(),
      submittedBy: options.userId || 'unknown',
      source: 'telegram-pc-control'
    };

    const taskFile = path.join(this.dirs.pending, `${taskId}.json`);
    await fs.writeFile(taskFile, JSON.stringify(task, null, 2));
    
    return { taskId, taskFile };
  }

  async getTaskResult(taskId, maxWaitTime = CONFIG.maxQueueWaitTime) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitTime) {
      // Check completed
      const completedFile = path.join(this.dirs.completed, `${taskId}.json`);
      const failedFile = path.join(this.dirs.failed, `${taskId}.json`);
      
      try {
        const completed = await fs.readFile(completedFile, 'utf8');
        await fs.unlink(completedFile).catch(() => {}); // Clean up
        return JSON.parse(completed);
      } catch (err) {
        // Not in completed
      }
      
      try {
        const failed = await fs.readFile(failedFile, 'utf8');
        await fs.unlink(failedFile).catch(() => {}); // Clean up
        return JSON.parse(failed);
      } catch (err) {
        // Not in failed
      }
      
      // Wait before checking again
      await new Promise(resolve => setTimeout(resolve, CONFIG.checkInterval));
    }
    
    throw new Error('Timeout waiting for task result');
  }

  async getPendingTasks() {
    const files = await fs.readdir(this.dirs.pending);
    const tasks = [];
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const content = await fs.readFile(path.join(this.dirs.pending, file), 'utf8');
        tasks.push(JSON.parse(content));
      } catch (err) {
        // Skip invalid files
      }
    }
    return tasks.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
  }

  async getRecentResults(limit = 10) {
    const [completedFiles, failedFiles] = await Promise.all([
      fs.readdir(this.dirs.completed).catch(() => []),
      fs.readdir(this.dirs.failed).catch(() => [])
    ]);
    
    const allResults = [];
    
    for (const file of completedFiles.filter(f => f.endsWith('.json')).slice(0, limit)) {
      try {
        const content = await fs.readFile(path.join(this.dirs.completed, file), 'utf8');
        allResults.push({ status: 'completed', ...JSON.parse(content) });
      } catch (err) {}
    }
    
    for (const file of failedFiles.filter(f => f.endsWith('.json')).slice(0, limit)) {
      try {
        const content = await fs.readFile(path.join(this.dirs.failed, file), 'utf8');
        allResults.push({ status: 'failed', ...JSON.parse(content) });
      } catch (err) {}
    }
    
    return allResults
      .sort((a, b) => new Date(b.completedAt || b.failedAt) - new Date(a.completedAt || a.failedAt))
      .slice(0, limit);
  }
}

// Main Bot Class
class TelegramPCBot {
  constructor() {
    validateConfig();
    
    this.bot = new Telegraf(CONFIG.botToken);
    this.rateLimiter = new RateLimiter();
    this.logger = new Logger();
    this.queue = new QueueBridge(CONFIG.queuePath);
    
    this.setupMiddleware();
    this.setupCommands();
    this.setupErrorHandling();
  }

  setupMiddleware() {
    // Authorization middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.from?.id?.toString();
      
      if (!userId || !CONFIG.allowedUsers.includes(userId)) {
        this.logger.warn('Unauthorized access attempt', {
          userId,
          username: ctx.from?.username,
          command: ctx.message?.text
        });
        return ctx.reply('⛔ *Unauthorized*\n\nYou are not authorized to use this bot.', {
          parse_mode: 'Markdown'
        });
      }
      
      // Attach user info for commands
      ctx.state.userId = userId;
      ctx.state.username = ctx.from?.username;
      ctx.state.queue = this.queue;
      ctx.state.logger = this.logger;
      ctx.state.rateLimiter = this.rateLimiter;
      
      await next();
    });

    // Rate limiting middleware
    this.bot.use(async (ctx, next) => {
      const userId = ctx.state.userId;
      
      if (!this.rateLimiter.canExecute(userId)) {
        const waitTime = this.rateLimiter.getRemainingTime(userId);
        return ctx.reply(`⏳ *Rate Limited*\n\nPlease wait ${waitTime} second(s) before sending another command.`, {
          parse_mode: 'Markdown'
        });
      }
      
      this.rateLimiter.recordExecution(userId);
      await next();
    });

    // Logging middleware
    this.bot.use(async (ctx, next) => {
      const command = ctx.message?.text || 'unknown';
      this.logger.info('Command received', {
        userId: ctx.state.userId,
        username: ctx.state.username,
        command: command.split(' ')[0]
      });
      
      const startTime = Date.now();
      await next();
      
      this.logger.debug('Command processed', {
        userId: ctx.state.userId,
        command: command.split(' ')[0],
        duration: Date.now() - startTime
      });
    });
  }

  setupCommands() {
    // Help command
    this.bot.command('start', (ctx) => {
      ctx.reply(`🖥️ *PC Control Bot*\n\n` +
        `Available commands:\n\n` +
        `• /pc <command> - Execute any command on PC\n` +
        `• /pcstatus - Check PC status (GPU, CPU, memory)\n` +
        `• /pcstart <service> - Start services\n` +
        `• /pcstop <service> - Stop services\n` +
        `• /pcqueue - View pending queue tasks\n` +
        `• /pcresults - View completed task results\n\n` +
        `*Safety features:*\n` +
        `• Command whitelisting\n` +
        `• Rate limiting (1 cmd/5sec)\n` +
        `• Authorized users only`, {
        parse_mode: 'Markdown'
      });
    });

    this.bot.command('help', (ctx) => ctx.reply('Use /start for command list'));

    // PC Control Commands
    this.bot.command('pc', pcCommand);
    this.bot.command('pcstatus', pcStatusCommand);
    this.bot.command('pcstart', pcStartCommand);
    this.bot.command('pcstop', pcStopCommand);
    this.bot.command('pcqueue', pcQueueCommand);
    this.bot.command('pcresults', pcResultsCommand);

    // Catch-all for unknown commands
    this.bot.on('text', (ctx) => {
      if (!ctx.message.text.startsWith('/')) return;
      ctx.reply('❓ Unknown command. Use /start to see available commands.');
    });
  }

  setupErrorHandling() {
    this.bot.catch((err, ctx) => {
      this.logger.error('Bot error', {
        error: err.message,
        stack: err.stack,
        userId: ctx?.state?.userId,
        updateType: ctx?.updateType
      });
      
      ctx?.reply('❌ An error occurred. Please try again later.').catch(() => {});
    });

    process.on('uncaughtException', (err) => {
      this.logger.error('Uncaught exception', { error: err.message, stack: err.stack });
      setTimeout(() => process.exit(1), 1000);
    });

    process.on('unhandledRejection', (reason, promise) => {
      this.logger.error('Unhandled rejection', { reason, promise });
    });
  }

  async start() {
    await this.queue.ensureDirs();
    await this.logger.info('Bot starting...');
    
    // Start bot
    this.bot.launch({
      dropPendingUpdates: true
    });
    
    await this.logger.info('Bot started successfully');
    
    // Graceful shutdown
    process.once('SIGINT', () => this.stop('SIGINT'));
    process.once('SIGTERM', () => this.stop('SIGTERM'));
  }

  async stop(signal) {
    await this.logger.info(`Bot stopping (${signal})...`);
    this.bot.stop(signal);
    process.exit(0);
  }
}

// Start the bot
if (require.main === module) {
  const bot = new TelegramPCBot();
  bot.start().catch(err => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });
}

module.exports = { TelegramPCBot, QueueBridge, Logger, RateLimiter, CONFIG };
