/**
 * /pcstop command - Stop services on PC
 * Confirmation required for destructive operations
 */

const SERVICES = {
  trading: {
    name: 'Trading Bot',
    patterns: ['trading', 'polymarket.js', 'npm run trading'],
    stopCmd: 'pkill -f "npm run trading" || pkill -f "node.*trading"',
    description: 'Main trading bot'
  },
  scanner: {
    name: 'Market Scanner',
    patterns: ['scanner', 'scanner.js'],
    stopCmd: 'pkill -f "scanner.js"',
    description: 'Market opportunity scanner'
  },
  dashboard: {
    name: 'Web Dashboard',
    patterns: ['dashboard'],
    stopCmd: 'pkill -f "npm run dashboard"',
    description: 'Web monitoring dashboard'
  },
  server: {
    name: 'API Server',
    patterns: ['server', 'npm run server'],
    stopCmd: 'pkill -f "npm run server"',
    description: 'REST API server'
  },
  pm2: {
    name: 'PM2 Process Manager',
    patterns: ['pm2'],
    stopCmd: 'pm2 stop all && pm2 delete all',
    description: 'All PM2 managed services'
  },
  discord: {
    name: 'Discord Bot',
    patterns: ['discord'],
    stopCmd: 'pkill -f "discord/bot.js"',
    description: 'Discord integration bot'
  },
  all: {
    name: 'All Bot Services',
    patterns: ['all'],
    stopCmd: 'pkill -f "node.*polymarket" && pkill -f "scanner" && pkill -f "discord"',
    description: 'Stop all trading-related services',
    confirmRequired: true
  }
};

// Pending confirmations
const pendingConfirmations = new Map();
const CONFIRM_TIMEOUT = 30000; // 30 seconds

async function stopService(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  // Parse service name
  const messageText = ctx.message.text;
  const match = messageText.match(/^\/pcstop(?:@\w+)?\s+(\w+)(?:\s+--confirm)?$/);
  
  if (!match) {
    const serviceList = Object.entries(SERVICES)
      .map(([key, svc]) => `• \`${key}\` - ${svc.name}\n  ${svc.description}`)
      .join('\n');
    
    return ctx.reply(
      '🛑 *Stop a Service*\n\n' +
      '*Usage:* `/pcstop <service>`\n\n' +
      '*Available services:*\n' + serviceList + '\n\n' +
      '⚠️ *Warning:* Stopping services may interrupt trading.',
      { parse_mode: 'Markdown' }
    );
  }
  
  const serviceKey = match[1].toLowerCase();
  const isConfirmed = messageText.includes('--confirm');
  const service = SERVICES[serviceKey];
  
  if (!service) {
    const available = Object.keys(SERVICES).join(', ');
    return ctx.reply(
      `❌ *Unknown service:* \`${serviceKey}\`\n\n` +
      `Available: ${available}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Check for confirmation requirement
  const confirmationKey = `${userId}:stop:${serviceKey}`;
  
  if (service.confirmRequired && !isConfirmed && !pendingConfirmations.has(confirmationKey)) {
    pendingConfirmations.set(confirmationKey, true);
    
    // Auto-expire confirmation
    setTimeout(() => {
      pendingConfirmations.delete(confirmationKey);
    }, CONFIRM_TIMEOUT);
    
    return ctx.reply(
      `⚠️ *Confirm Stop ${service.name}*\n\n` +
      `This will stop: *${service.name}*\n` +
      `Command: \`${service.stopCmd}\`\n\n` +
      `Reply with:\n` +
      `\`/pcstop ${serviceKey} --confirm\`\n\n` +
      `⏱️ Confirmation expires in 30 seconds`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Clear confirmation
  pendingConfirmations.delete(confirmationKey);
  
  // Send processing message
  const processingMsg = await ctx.reply(
    `🛑 *Stopping ${service.name}...*`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Submit stop command to queue
    const { taskId } = await queue.submitTask('stop-service', [service.stopCmd], {
      userId,
      timeout: 15000,
      serviceName: service.name,
      serviceKey: serviceKey
    });
    
    await logger.info('Service stop submitted', { userId, service: serviceKey, taskId });
    
    // Wait for result
    const result = await queue.getTaskResult(taskId, 30000);
    
    // Delete processing message
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    
    if (result.success) {
      const output = result.stdout || 'Service stopped successfully';
      await ctx.reply(
        `✅ *${service.name} Stopped*\n\n` +
        `${'```'}\n${output}${'\n```'}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      // Check if it's already stopped
      if (result.stderr?.includes('no process found') || result.exitCode === 1) {
        await ctx.reply(
          `ℹ️ *${service.name}* is not running or already stopped.`,
          { parse_mode: 'Markdown' }
        );
      } else {
        await ctx.reply(
          `⚠️ *${service.name} Stop Result*\n\n` +
          `May have stopped with warnings:\n` +
          `${'```'}\n${result.stderr || result.error || 'Unknown issue'}${'```'}`,
          { parse_mode: 'Markdown' }
        );
      }
    }
    
    await logger.info('Service stop completed', { 
      userId, 
      service: serviceKey, 
      taskId, 
      success: result.success 
    });
    
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    await logger.error('Service stop error', { userId, service: serviceKey, error: err.message });
  }
}

module.exports = stopService;
