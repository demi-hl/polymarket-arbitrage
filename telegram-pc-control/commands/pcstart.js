/**
 * /pcstart command - Start services on PC
 * Supported services: trading, scanner, dashboard, etc.
 */

// Service definitions
const SERVICES = {
  trading: {
    name: 'Trading Bot',
    cmd: 'npm run trading',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'Main trading bot with strategies'
  },
  scanner: {
    name: 'Market Scanner',
    cmd: 'node scanner.js',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'Market opportunity scanner'
  },
  dashboard: {
    name: 'Web Dashboard',
    cmd: 'npm run dashboard',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'Web-based monitoring dashboard'
  },
  server: {
    name: 'API Server',
    cmd: 'npm run server',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'REST API server'
  },
  pm2: {
    name: 'PM2 Process Manager',
    cmd: 'pm2 start ecosystem.config.js',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'Start all PM2 managed services'
  },
  discord: {
    name: 'Discord Bot',
    cmd: 'node discord/bot.js',
    workingDir: '~/clawd-local/agents/polymarket-arbitrage-bot',
    description: 'Discord integration bot'
  }
};

async function startService(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  // Parse service name
  const messageText = ctx.message.text;
  const match = messageText.match(/^\/pcstart(?:@\w+)?\s+(\w+)$/);
  
  if (!match) {
    // Show available services
    const serviceList = Object.entries(SERVICES)
      .map(([key, svc]) => `• \`${key}\` - ${svc.name}\n  ${svc.description}`)
      .join('\n');
    
    return ctx.reply(
      '⚙️ *Start a Service*\n\n' +
      '*Usage:* `/pcstart <service>`\n\n' +
      '*Available services:*\n' + serviceList,
      { parse_mode: 'Markdown' }
    );
  }
  
  const serviceKey = match[1].toLowerCase();
  const service = SERVICES[serviceKey];
  
  if (!service) {
    const available = Object.keys(SERVICES).join(', ');
    return ctx.reply(
      `❌ *Unknown service:* \`${serviceKey}\`\n\n` +
      `Available: ${available}`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Send processing message
  const processingMsg = await ctx.reply(
    `🚀 *Starting ${service.name}...*`,
    { parse_mode: 'Markdown' }
  );
  
  try {
    // Submit start command to queue
    const { taskId } = await queue.submitTask('start-service', [service.cmd], {
      userId,
      timeout: 30000,
      workingDir: service.workingDir,
      serviceName: service.name,
      serviceKey: serviceKey
    });
    
    await logger.info('Service start submitted', { userId, service: serviceKey, taskId });
    
    // Wait for result
    const result = await queue.getTaskResult(taskId, 60000);
    
    // Delete processing message
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    
    if (result.success) {
      await ctx.reply(
        `✅ *${service.name} Started*\n\n` +
        `Command: \`${service.cmd}\`\n` +
        `Working Dir: \`${service.workingDir}\`\n\n` +
        `${'```'}\n${result.stdout || 'Service started successfully'}${'```'}`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(
        `❌ *Failed to start ${service.name}*\n\n` +
        `*Error:* ${result.error || 'Unknown error'}\n\n` +
        `${'```'}\n${result.stderr || 'No error details'}${'```'}`,
        { parse_mode: 'Markdown' }
      );
    }
    
    await logger.info('Service start completed', { 
      userId, 
      service: serviceKey, 
      taskId, 
      success: result.success 
    });
    
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    await logger.error('Service start error', { userId, service: serviceKey, error: err.message });
  }
}

module.exports = startService;
