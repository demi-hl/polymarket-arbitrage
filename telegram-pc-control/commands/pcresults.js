/**
 * /pcresults command - View completed task results
 */

async function viewResults(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  // Parse limit from command
  const messageText = ctx.message.text;
  const match = messageText.match(/^\/pcresults(?:@\w+)?(?:\s+(\d+))?$/);
  const limit = Math.min(parseInt(match?.[1]) || 5, 20); // Max 20 results
  
  try {
    // Get recent results
    const results = await queue.getRecentResults(limit);
    
    await logger.info('Results checked', { userId, resultCount: results.length, limit });
    
    if (results.length === 0) {
      return ctx.reply(
        '📭 *Recent Results*\n\n' +
        'No completed tasks found.\n' +
        'Results are cleaned up after being viewed.',
        { parse_mode: 'Markdown' }
      );
    }
    
    // Format results
    let response = `📊 *Recent Results* (last ${results.length})\n\n`;
    
    results.forEach((result, index) => {
      const status = result.status === 'completed' ? '✅' : '❌';
      const command = result.command || 'unknown';
      const completedAt = result.completedAt || result.failedAt;
      const timeStr = completedAt 
        ? new Date(completedAt).toLocaleTimeString()
        : 'unknown time';
      
      // Truncate command if too long
      const cmdDisplay = command.length > 30 
        ? command.substring(0, 27) + '...' 
        : command;
      
      response += `${status} \`${cmdDisplay}\`\n`;
      response += `   └ ${timeStr}`;
      
      if (result.duration) {
        response += ` (${Math.round(result.duration / 1000)}s)`;
      }
      
      response += '\n';
      
      // Show preview of output for first 3 results
      if (index < 3 && result.stdout) {
        const preview = result.stdout.split('\n')[0].substring(0, 40);
        if (preview) {
          response += `   └ \`${preview}${preview.length >= 40 ? '...' : ''}\`\n`;
        }
      }
      
      response += '\n';
    });
    
    response += `_Use /pcresults 10 to see more results_`;
    
    await ctx.reply(response, { parse_mode: 'Markdown' });
    
  } catch (err) {
    await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    await logger.error('Results check error', { userId, error: err.message });
  }
}

module.exports = viewResults;
