/**
 * /pcstatus command - Check PC system status
 * Returns: GPU, CPU, memory, disk, and running processes
 */

const path = require('path');

// Status check script that runs on the PC
const STATUS_SCRIPT = `
#!/bin/bash

echo "=== SYSTEM STATUS ==="
echo "Timestamp: $(date)"
echo "Hostname: $(hostname)"
echo "Uptime: $(uptime -p 2>/dev/null || uptime)"
echo ""

echo "=== CPU ==="
if command -v top &> /dev/null; then
  top -bn1 | grep "Cpu(s)" | awk '{print $2}' | sed 's/%us,//' | xargs -I {} echo "Usage: {}%"
elif [ -f /proc/stat ]; then
  awk '/cpu / {printf "Usage: %.1f%%\\n", ($2+$4)*100/($2+$4+$5)}' /proc/stat
fi
echo "Load: $(cat /proc/loadavg 2>/dev/null | awk '{print $1, $2, $3}')"
echo ""

echo "=== MEMORY ==="
free -h 2>/dev/null || vm_stat 2>/dev/null
echo ""

echo "=== DISK ==="
df -h / 2>/dev/null | tail -1
echo ""

echo "=== GPU ==="
if command -v nvidia-smi &> /dev/null; then
  nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | while read line; do
    echo "GPU: $line"
  done
else
  echo "No NVIDIA GPU detected"
fi
echo ""

echo "=== PROCESSES ==="
echo "Top processes by CPU:"
ps aux --sort=-%cpu 2>/dev/null | head -6 || ps aux 2>/dev/null | head -6
echo ""

echo "=== BOT PROCESSES ==="
ps aux | grep -E "(node|npm|pm2)" | grep -v grep | head -10
echo ""

echo "=== NETWORK ==="
ip addr show 2>/dev/null | grep "inet " | head -2 || ifconfig 2>/dev/null | grep "inet " | head -2
echo ""

echo "=== DISK IO ==="
iostat -x 1 1 2>/dev/null | tail -n +4 | head -5 || echo "iostat not available"
`;

async function getStatus(ctx) {
  const logger = ctx.state.logger;
  const queue = ctx.state.queue;
  const userId = ctx.state.userId;
  
  // Send processing message
  const processingMsg = await ctx.reply('🔄 *Checking system status...*', { parse_mode: 'Markdown' });
  
  try {
    // Submit status check to queue
    const { taskId } = await queue.submitTask('status', [], {
      userId,
      timeout: 30000,
      script: STATUS_SCRIPT
    });
    
    await logger.info('Status check submitted', { userId, taskId });
    
    // Wait for result
    const result = await queue.getTaskResult(taskId, 60000);
    
    // Delete processing message
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    
    if (result.success) {
      // Parse and format the output
      const output = result.stdout || 'No output received';
      
      // Extract key metrics for summary
      const gpuMatch = output.match(/GPU: ([^,]+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+)/);
      const cpuMatch = output.match(/Usage: ([\d.]+)%/);
      const memMatch = output.match(/Mem:\s+(\S+)\s+(\S+)\s+(\S+)/);
      
      let summary = '🖥️ *PC Status Report*\n\n';
      
      if (gpuMatch) {
        const [_, name, temp, util, memUsed, memTotal] = gpuMatch;
        summary += `*GPU:* ${name.trim()}\n`;
        summary += `├ Temp: ${temp}°C\n`;
        summary += `├ Util: ${util}%\n`;
        summary += `└ Memory: ${memUsed}/${memTotal} MB\n\n`;
      }
      
      if (cpuMatch) {
        summary += `*CPU:* ${cpuMatch[1]}% usage\n`;
      }
      
      if (memMatch) {
        const total = memMatch[2];
        const used = memMatch[3];
        summary += `*RAM:* ${used} / ${total} used\n`;
      }
      
      summary += '\n📋 *Full Details:*\n';
      
      // Truncate output if too long
      const maxLen = 3000;
      const fullOutput = output.length > maxLen 
        ? output.substring(0, maxLen) + '\n\n... (truncated)' 
        : output;
      
      await ctx.reply(summary + '```\n' + fullOutput + '\n```', { 
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      });
    } else {
      await ctx.reply(
        `❌ *Status check failed*\n\n${result.error || 'Unknown error'}`,
        { parse_mode: 'Markdown' }
      );
    }
    
    await logger.info('Status check completed', { userId, taskId, success: result.success });
    
  } catch (err) {
    await ctx.deleteMessage(processingMsg.message_id).catch(() => {});
    await ctx.reply(`❌ *Error:* ${err.message}`, { parse_mode: 'Markdown' });
    await logger.error('Status check error', { userId, error: err.message });
  }
}

module.exports = getStatus;
