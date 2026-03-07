/**
 * Shared GPU Client Singleton
 *
 * All strategies share a single GPUClient instance to:
 *   1. Avoid redundant health checks
 *   2. Track unified stats (total calls, errors, latency)
 *   3. Circuit-break once instead of per-strategy
 *
 * Usage:
 *   const gpu = require('../lib/gpu-singleton');
 *   const predictions = await gpu.predictEdge(opportunities);
 */
const GPUClient = require('./gpu-client');

const gpu = new GPUClient();

module.exports = gpu;
