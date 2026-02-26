/**
 * /pcqueue command - View pending queue tasks
 */

async function viewQueue(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  try {
    // Get pending tasks
    const pendingTasks = await queue.getPendingTasks();
    
    await logger.info('Queue status checked', { userId, pendingCount: pendingTasks.length });
    
    if (pendingTasks.length === 0) {
      return ctx.reply(
        '📭 *Queue Status*\n\n' +
        'No pending tasks in the queue.\n' +
        'The PC is ready to receive commands.',
        { parse_mode: 'Markdown' }
      );
    }
    
    // Format task list
    let response = `📋 *Queue Status*\n\n`;
    response += `*${pendingTasks.length} pending task(s)*\n\n`;
    
    pendingTasks.slice(0, 10).forEach((task, index) => {
      const submittedAt = new Date(task.submittedAt);
      const timeAgo = Math.floor((Date.now() - submittedAt.getTime()) / 1000);
      const timeStr = timeAgo < 60 ? `${timeAgo}s ago` : `${Math.floor(timeAgo / 60)}m ago`;
      
      response += `${index + 1}. \`${task.command}\`\n`;
      response += `   └ ${timeStr} by ${task.submittedBy?.substring(0, 8) || 'unknown'}...\n\n`;
    });
    
    if (pendingTasks.length > 10) {
      response += `_... and ${pendingTasks.length - 10} more tasks_`;
    }
    
    await ctx.reply(response, { parse_mode: 'Markdown' });
    
  } catch (err) {
    await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    await logger.error('Queue check error', { userId, error: err.message });
  }
}

module.exports = viewQueue;
