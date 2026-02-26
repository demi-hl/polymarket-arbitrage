/**
 * PC Worker - Executes tasks from the queue bridge
 * This runs on the PC (not the MacBook)
 * 
 * Features:
 * - Polls queue/pending/ for new tasks
 * - Executes commands safely
 * - Writes results to queue/completed/ or queue/failed/
 * - Comprehensive logging
 */

const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
require('dotenv').config();

// Configuration
const CONFIG = {
  queuePath: process.env.QUEUE_BRIDGE_PATH || path.join(require('os').homedir(), 'clawd-local', 'queue'),
  pollInterval: 2000, // Check for new tasks every 2 seconds
  maxConcurrent: 2,   // Max concurrent task executions
};

// Queue directories
const QUEUE_DIRS = {
  pending: path.join(CONFIG.queuePath, 'pending'),
  inProgress: path.join(CONFIG.queuePath, 'in-progress'),
  completed: path.join(CONFIG.queuePath, 'completed'),
  failed: path.join(CONFIG.queuePath, 'failed')
};

// Logger
class Logger {
  async log(level, message, meta = {}) {
    const timestamp = new Date().toISOString();
    const logEntry = { timestamp, level, message, ...meta };
    console.log(`[${timestamp}] [${level}] ${message}`, meta);
  }
  info(message, meta) { return this.log('INFO', message, meta); }
  error(message, meta) { return this.log('ERROR', message, meta); }
  debug(message, meta) { return this.log('DEBUG', message, meta); }
}

const logger = new Logger();

// Ensure queue directories exist
async function ensureDirs() {
  for (const dir of Object.values(QUEUE_DIRS)) {
    await fs.mkdir(dir, { recursive: true });
  }
}

// Execute a command
function executeCommand(command, args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 30000;
    const workingDir = options.workingDir;
    const env = { ...process.env, ...options.env };
    
    const startTime = Date.now();
    const child = spawn(command, args, {
      cwd: workingDir || process.cwd(),
      env,
      shell: true,
      detached: false
    });
    
    let stdout = '';
    let stderr = '';
    let killed = false;
    
    // Collect stdout
    child.stdout.on('data', (data) => {
      stdout += data.toString();
      // Prevent memory issues with huge outputs
      if (stdout.length > 1024 * 1024) { // 1MB limit
        stdout = stdout.substring(0, 1024 * 1024) + '\n... (output truncated)';
        child.kill('SIGTERM');
        killed = true;
      }
    });
    
    // Collect stderr
    child.stderr.on('data', (data) => {
      stderr += data.toString();
      if (stderr.length > 512 * 1024) { // 512KB limit
        stderr = stderr.substring(0, 512 * 1024) + '\n... (stderr truncated)';
      }
    });
    
    // Timeout handler
    const timeoutId = setTimeout(() => {
      if (!killed) {
        killed = true;
        child.kill('SIGTERM');
        // Force kill after 5 seconds
        setTimeout(() => child.kill('SIGKILL'), 5000);
      }
    }, timeout);
    
    // Process completion
    child.on('close', (code, signal) => {
      clearTimeout(timeoutId);
      
      const duration = Date.now() - startTime;
      
      if (killed && signal === 'SIGTERM') {
        resolve({
          success: false,
          error: 'Command timed out or output too large',
          exitCode: -1,
          stdout,
          stderr,
          duration,
          timedOut: true
        });
      } else {
        resolve({
          success: code === 0,
          exitCode: code,
          stdout,
          stderr,
          duration,
          signal
        });
      }
    });
    
    child.on('error', (err) => {
      clearTimeout(timeoutId);
      resolve({
        success: false,
        error: err.message,
        exitCode: -1,
        stdout,
        stderr,
        duration: Date.now() - startTime
      });
    });
  });
}

// Process a single task
async function processTask(taskFile) {
  const taskPath = path.join(QUEUE_DIRS.pending, taskFile);
  const inProgressPath = path.join(QUEUE_DIRS.inProgress, taskFile);
  
  let task;
  
  try {
    // Read task
    const content = await fs.readFile(taskPath, 'utf8');
    task = JSON.parse(content);
    
    // Move to in-progress
    await fs.rename(taskPath, inProgressPath);
    
    await logger.info('Processing task', { taskId: task.id, command: task.command });
    
    let result;
    
    // Handle different task types
    switch (task.command) {
      case 'exec':
        // Execute arbitrary command
        const execCmd = task.args[0];
        result = await executeCommand(execCmd, [], {
          timeout: task.options?.timeout || 30000,
          workingDir: task.options?.workingDir,
          env: task.options?.env
        });
        break;
        
      case 'status':
        // System status check
        result = await executeCommand('bash', ['-c', task.options?.script || 'echo "No status script"'], {
          timeout: 30000
        });
        break;
        
      case 'start-service':
      case 'stop-service':
        // Service management
        const serviceCmd = task.args[0];
        result = await executeCommand(serviceCmd, [], {
          timeout: task.options?.timeout || 15000,
          workingDir: task.options?.workingDir
        });
        break;
        
      default:
        result = {
          success: false,
          error: `Unknown command type: ${task.command}`,
          exitCode: -1,
          stdout: '',
          stderr: '',
          duration: 0
        };
    }
    
    // Add metadata to result
    result.taskId = task.id;
    result.originalCommand = task.command;
    result.processedAt = new Date().toISOString();
    
    // Write result
    if (result.success) {
      result.completedAt = new Date().toISOString();
      await fs.writeFile(
        path.join(QUEUE_DIRS.completed, `${task.id}.json`),
        JSON.stringify(result, null, 2)
      );
      await logger.info('Task completed', { taskId: task.id, duration: result.duration });
    } else {
      result.failedAt = new Date().toISOString();
      await fs.writeFile(
        path.join(QUEUE_DIRS.failed, `${task.id}.json`),
        JSON.stringify(result, null, 2)
      );
      await logger.info('Task failed', { taskId: task.id, error: result.error, duration: result.duration });
    }
    
    // Clean up in-progress file
    await fs.unlink(inProgressPath).catch(() => {});
    
  } catch (err) {
    await logger.error('Task processing error', { taskFile, error: err.message });
    
    // Write error result
    const errorResult = {
      taskId: task?.id || 'unknown',
      success: false,
      error: err.message,
      failedAt: new Date().toISOString()
    };
    
    try {
      await fs.writeFile(
        path.join(QUEUE_DIRS.failed, `${task?.id || 'unknown'}.json`),
        JSON.stringify(errorResult, null, 2)
      );
      await fs.unlink(inProgressPath).catch(() => {});
      await fs.unlink(taskPath).catch(() => {});
    } catch (cleanupErr) {
      // Ignore cleanup errors
    }
  }
}

// Poll for new tasks
async function pollTasks() {
  try {
    const files = await fs.readdir(QUEUE_DIRS.pending);
    const taskFiles = files.filter(f => f.endsWith('.json'));
    
    if (taskFiles.length > 0) {
      await logger.info('Found pending tasks', { count: taskFiles.length });
      
      // Process tasks sequentially (for safety)
      for (const taskFile of taskFiles.slice(0, CONFIG.maxConcurrent)) {
        await processTask(taskFile);
      }
    }
  } catch (err) {
    await logger.error('Poll error', { error: err.message });
  }
  
  // Schedule next poll
  setTimeout(pollTasks, CONFIG.pollInterval);
}

// Main
async function main() {
  await logger.info('PC Worker starting...');
  await logger.info(`Queue path: ${CONFIG.queuePath}`);
  
  await ensureDirs();
  await logger.info('Queue directories ready');
  
  // Start polling
  pollTasks();
  
  await logger.info('Worker started, polling for tasks...');
}

// Graceful shutdown
process.on('SIGINT', async () => {
  await logger.info('Worker shutting down (SIGINT)...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await logger.info('Worker shutting down (SIGTERM)...');
  process.exit(0);
});

main().catch(err => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
