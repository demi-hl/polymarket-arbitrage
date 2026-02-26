/**
 * Polymarket Arbitrage Bot - Queue Bridge
 * Distributed Arbitrage Execution System
 */

const fs = require('fs').promises;
const path = require('path');
const EventEmitter = require('events');
const os = require('os');

const TaskStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in-progress',
  COMPLETED: 'completed',
  FAILED: 'failed'
};

const UrgencyLevel = {
  CRITICAL: 'critical',
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low'
};

class QueueBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    
    const isWindows = os.platform() === 'win32';
    const basePath = isWindows
      ? 'C:\\Users\\demig\\clawd-workspace\\queue'
      : path.join(os.homedir(), 'clawd-local', 'queue');
    
    this.config = {
      paths: {
        pending: path.join(basePath, 'pending'),
        inProgress: path.join(basePath, 'in-progress'),
        completed: path.join(basePath, 'completed'),
        failed: path.join(basePath, 'failed')
      },
      nodeId: options.nodeId || 'unknown-node',
      ...options
    };
    
    this.isRunning = false;
    this.metrics = {
      tasksSubmitted: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      avgExecutionTime: 0,
      lastSync: null
    };
    this.activeTasks = new Map();
    this.rateLimiter = new Map();
  }

  async initialize() {
    console.log('[QueueBridge] Initializing queue bridge...');
    for (const dir of Object.values(this.config.paths)) {
      try {
        await fs.mkdir(dir, { recursive: true });
      } catch (err) {}
    }
    return this;
  }

  async submitTask(taskData) {
    const task = {
      id: taskData.id || `arb-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type: taskData.type || 'arbitrage',
      marketId: taskData.marketId,
      marketName: taskData.marketName,
      side: taskData.side,
      size: taskData.size,
      expectedPrice: taskData.expectedPrice,
      edge: taskData.edge,
      urgency: this.calculateUrgency(taskData.edge),
      submittedAt: new Date().toISOString(),
      submittedBy: taskData.submittedBy || this.config.nodeId,
      status: TaskStatus.PENDING,
      attempts: 0,
      maxAttempts: 3,
      metadata: taskData.metadata || {}
    };

    const taskPath = path.join(this.config.paths.pending, `${task.id}.json`);
    await fs.writeFile(taskPath, JSON.stringify(task, null, 2));
    
    this.metrics.tasksSubmitted++;
    this.emit('task:submitted', task);
    console.log(`[QueueBridge] 📤 Task submitted: ${task.id} (${task.urgency}, ${(task.edge * 100).toFixed(2)}% edge)`);
    return task;
  }

  calculateUrgency(edge) {
    if (edge >= 0.15) return UrgencyLevel.CRITICAL;
    if (edge >= 0.10) return UrgencyLevel.HIGH;
    if (edge >= 0.05) return UrgencyLevel.MEDIUM;
    return UrgencyLevel.LOW;
  }

  async pickNextTask() {
    try {
      const pendingFiles = await fs.readdir(this.config.paths.pending);
      const tasks = [];

      for (const file of pendingFiles.filter(f => f.endsWith('.json'))) {
        const taskPath = path.join(this.config.paths.pending, file);
        try {
          const content = await fs.readFile(taskPath, 'utf8');
          const task = JSON.parse(content);
          tasks.push({ task, path: taskPath });
        } catch (err) {}
      }

      if (tasks.length === 0) return null;

      const priorityOrder = { [UrgencyLevel.CRITICAL]: 0, [UrgencyLevel.HIGH]: 1, [UrgencyLevel.MEDIUM]: 2, [UrgencyLevel.LOW]: 3 };
      tasks.sort((a, b) => {
        const pDiff = priorityOrder[a.task.urgency] - priorityOrder[b.task.urgency];
        if (pDiff !== 0) return pDiff;
        return new Date(a.task.submittedAt) - new Date(b.task.submittedAt);
      });

      const selected = tasks[0];
      const inProgressPath = path.join(this.config.paths.inProgress, path.basename(selected.path));
      
      await fs.rename(selected.path, inProgressPath);
      selected.task.status = TaskStatus.IN_PROGRESS;
      selected.task.startedAt = new Date().toISOString();
      await fs.writeFile(inProgressPath, JSON.stringify(selected.task, null, 2));

      this.activeTasks.set(selected.task.id, { ...selected.task, _filePath: inProgressPath });
      return selected.task;
    } catch (err) {
      return null;
    }
  }

  async completeTask(taskId, result) {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;

    const completedTask = {
      ...task,
      status: TaskStatus.COMPLETED,
      completedAt: new Date().toISOString(),
      result: {
        success: true,
        txHash: result.txHash,
        actualPrice: result.actualPrice,
        profit: result.profit,
        executionTime: Date.now() - new Date(task.startedAt).getTime(),
        ...result
      }
    };

    delete completedTask._filePath;
    const completedPath = path.join(this.config.paths.completed, `${taskId}.json`);
    await fs.writeFile(completedPath, JSON.stringify(completedTask, null, 2));
    
    try { await fs.unlink(path.join(this.config.paths.inProgress, `${taskId}.json`)); } catch (e) {}

    this.activeTasks.delete(taskId);
    this.metrics.tasksCompleted++;
    this.emit('task:completed', completedTask);
    console.log(`[QueueBridge] ✅ Task completed: ${taskId}`);
    return true;
  }

  async failTask(taskId, error) {
    const task = this.activeTasks.get(taskId);
    if (!task) return false;

    task.attempts++;
    
    if (task.attempts < task.maxAttempts) {
      const backoffMs = Math.pow(2, task.attempts) * 1000;
      task.nextAttemptAt = new Date(Date.now() + backoffMs).toISOString();
      task.status = TaskStatus.PENDING;
      task.lastError = error.message || error;
      
      delete task._filePath;
      delete task.startedAt;

      const pendingPath = path.join(this.config.paths.pending, `${taskId}.json`);
      await fs.writeFile(pendingPath, JSON.stringify(task, null, 2));
      try { await fs.unlink(path.join(this.config.paths.inProgress, `${taskId}.json`)); } catch (e) {}

      this.activeTasks.delete(taskId);
      console.log(`[QueueBridge] 🔄 Task retry scheduled: ${taskId}`);
      return 'retry';
    } else {
      const failedTask = {
        ...task,
        status: TaskStatus.FAILED,
        failedAt: new Date().toISOString(),
        error: error.message || error
      };

      delete failedTask._filePath;
      const failedPath = path.join(this.config.paths.failed, `${taskId}.json`);
      await fs.writeFile(failedPath, JSON.stringify(failedTask, null, 2));
      try { await fs.unlink(path.join(this.config.paths.inProgress, `${taskId}.json`)); } catch (e) {}

      this.activeTasks.delete(taskId);
      this.metrics.tasksFailed++;
      this.emit('task:failed', failedTask);
      console.error(`[QueueBridge] ❌ Task failed: ${taskId}`);
      return 'failed';
    }
  }

  async getQueueStatus() {
    try {
      const [pending, inProgress, completed, failed] = await Promise.all([
        fs.readdir(this.config.paths.pending).then(f => f.filter(x => x.endsWith('.json')).length),
        fs.readdir(this.config.paths.inProgress).then(f => f.filter(x => x.endsWith('.json')).length),
        fs.readdir(this.config.paths.completed).then(f => f.filter(x => x.endsWith('.json')).length),
        fs.readdir(this.config.paths.failed).then(f => f.filter(x => x.endsWith('.json')).length)
      ]);
      return { pending, inProgress, completed, failed, activeTasks: this.activeTasks.size, metrics: { ...this.metrics } };
    } catch (err) {
      return { pending: 0, inProgress: 0, completed: 0, failed: 0, activeTasks: 0, metrics: this.metrics };
    }
  }

  async start() {
    if (this.isRunning) return;
    await this.initialize();
    this.isRunning = true;
    console.log('[QueueBridge] 🚀 Bridge started');
    return this;
  }

  async stop() {
    this.isRunning = false;
    console.log('[QueueBridge] 🛑 Bridge stopped');
    return this;
  }
}

module.exports = { QueueBridge, TaskStatus, UrgencyLevel };
