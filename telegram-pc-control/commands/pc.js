/**
 * /pc command - Execute arbitrary commands on PC
 * Safety: Whitelist-based command filtering
 */

const path = require('path');

// Command whitelist - only these commands/prefixes are allowed
const ALLOWED_COMMANDS = [
  // System info
  'nvidia-smi',
  'top',
  'htop',
  'ps',
  'df',
  'free',
  'uptime',
  'whoami',
  'pwd',
  'ls',
  'cat',
  'echo',
  'grep',
  'head',
  'tail',
  'wc',
  
  // Node/npm
  'node',
  'npm',
  'npx',
  
  // Git
  'git',
  
  // Process management
  'pm2',
  'systemctl',
  'service',
  
  // Network
  'ping',
  'curl',
  'wget',
  'netstat',
  'ss',
  
  // File operations (safe ones only)
  'find',
  'du',
  'stat',
  'file',
  
  // Custom scripts
  'python',
  'python3',
];

// Blocked patterns (dangerous commands)
const BLOCKED_PATTERNS = [
  /rm\s+-rf/i,
  />\s*\/dev\/null/i,
  /mkfs/i,
  /dd\s+if/i,
  /:\(\)\s*\{\s*:\|:\s*\&\s*\}\s*;/i, // Fork bomb
  /wget.*\|.*sh/i,
  /curl.*\|.*sh/i,
  /\{\s*rm/i,
  /format\s+/i,
  /fdisk/i,
  /dd\s+of/i,
];

// Destructive commands requiring confirmation
const DESTRUCTIVE_COMMANDS = [
  'kill',
  'pkill',
  'killall',
  'reboot',
  'shutdown',
  'poweroff',
  'halt',
];

// Pending confirmations storage
const pendingConfirmations = new Map();

function validateCommand(commandStr) {
  const parts = commandStr.trim().split(/\s+/);
  const baseCmd = parts[0];
  
  // Check blocked patterns
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(commandStr)) {
      return { valid: false, reason: 'Command matches dangerous pattern' };
    }
  }
  
  // Check if base command is allowed
  const isAllowed = ALLOWED_COMMANDS.some(cmd => 
    baseCmd === cmd || baseCmd.startsWith(cmd + '-') || commandStr.startsWith(cmd + ' ')
  );
  
  if (!isAllowed) {
    return { valid: false, reason: `Command '${baseCmd}' is not in whitelist` };
  }
  
  // Check if destructive
  const isDestructive = DESTRUCTIVE_COMMANDS.includes(baseCmd);
  
  return { valid: true, isDestructive };
}

async function executeCommand(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  // Extract command from message
  const messageText = ctx.message.text;
  const commandMatch = messageText.match(/^\/pc(?:@\w+)?\s+(.+)$/);
  
  if (!commandMatch) {
    return ctx.reply(
      '❌ *Usage:* `/pc <command>`\n\n' +
      'Example: `/pc nvidia-smi`\n' +
      'Example: `/pc node polymarket.js scan`',
      { parse_mode: 'Markdown' }
    );
  }
  
  const commandStr = commandMatch[1].trim();
  
  // Validate command
  const validation = validateCommand(commandStr);
  
  if (!validation.valid) {
    await logger.warn('Blocked command attempt', {
      userId,
      command: commandStr,
      reason: validation.reason
    });
    return ctx.reply(`⛔ *Command Blocked*\n\n${validation.reason}`, { parse_mode: 'Markdown' });
  }
  
  // Check for pending confirmation
  const confirmationKey = `${userId}:${commandStr}`;
  const hasConfirmed = pendingConfirmations.get(confirmationKey);
  
  if (validation.isDestructive && !hasConfirmed) {
    pendingConfirmations.set(confirmationKey, true);
    // Auto-expire confirmation after 30 seconds
    setTimeout(() => pendingConfirmations.delete(confirmationKey), 30000);
    
    return ctx.reply(
      `⚠️ *Destructive Command*\n\n` +
      `Command: \`${commandStr}\`\n\n` +
      `This command may affect running processes.\n` +
      `Send the same command again within 30 seconds to confirm.`,
      { parse_mode: 'Markdown' }
    );
  }
  
  // Clear confirmation
  pendingConfirmations.delete(confirmationKey);
  
  // Send processing message
  const processingMsg = await ctx.reply('🔄 *Executing...*', { parse_mode: 'Markdown' });
  
  try {
    // Submit to queue
    const { taskId } = await queue.submitTask('exec', [commandStr], {
      userId,
      timeout: 60000, // 60 second timeout for commands
      workingDir: process.env.PC_WORKING_DIR || null
    });
    
    await logger.info('Command submitted to queue', { userId, command: commandStr, taskId });
    
    // Wait for result
    const result = await queue.getTaskResult(taskId);
    
    // Delete processing message
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    
    // Format response
    let response;
    if (result.success) {
      const output = result.stdout || 'Command executed successfully (no output)';
      const truncated = output.length > 3500 ? output.substring(0, 3500) + '\n\n... (truncated)' : output;
      
      response = `✅ *Command Completed*\n\n` +
        `\`${commandStr}\`\n\n` +
        `${'```'}\n${truncated}${'```'}`;
      
      if (result.stderr) {
        response += `\n\n⚠️ *Stderr:*\n${'```'}\n${result.stderr.substring(0, 500)}${'```'}`;
      }
    } else {
      response = `❌ *Command Failed*\n\n` +
        `\`${commandStr}\`\n\n` +
        `*Error:* ${result.error || 'Unknown error'}\n` +
        `*Exit code:* ${result.exitCode || 'N/A'}`;
      
      if (result.stderr) {
        response += `\n\n${'```'}\n${result.stderr.substring(0, 1000)}${'```'}`;
      }
    }
    
    await ctx.reply(response, { parse_mode: 'Markdown' });
    
    await logger.info('Command completed', {
      userId,
      command: commandStr,
      taskId,
      success: result.success,
      duration: result.duration
    });
    
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    
    if (err.message === 'Timeout waiting for task result') {
      await ctx.reply(
        `⏱️ *Timeout*\n\n` +
        `Command took too long to complete.\n` +
        `Check /pcresults for the result later.`,
        { parse_mode: 'Markdown' }
      );
    } else {
      await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    }
    
    await logger.error('Command execution error', {
      userId,
      command: commandStr,
      error: err.message
    });
  }
}

module.exports = executeCommand;
