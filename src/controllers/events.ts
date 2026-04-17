import { Router, Request, Response } from 'express';
import * as os from 'os';
import { PORT, OLLAMA_URL, isWebSearchEnabled, isReasoningEnabled } from '../config';
import { attachSSE, getLogBuffer } from '../services/log-buffer';
import { checkConnection } from '../services/ollama';
import { cacheStats } from '../services/prompt-cache';
import { queueStats } from '../services/request-queue';
import { getTokenStats } from '../startup/dashboard';

const router = Router();

// ─── SSE: real-time log stream ───────────────────────────────────────────────
router.get('/api/events', (_req: Request, res: Response) => {
  const cleanup = attachSSE(res);
  _req.on('close', cleanup);
});

// ─── Full status snapshot (for attach mode polling) ──────────────────────────
router.get('/api/status', async (_req: Request, res: Response) => {
  const ollamaReachable = await checkConnection();
  const tokens = getTokenStats();
  const cache = cacheStats();
  const queue = queueStats();

  res.json({
    server: {
      port: PORT,
      ollamaUrl: OLLAMA_URL,
      hostname: os.hostname(),
      cpus: os.cpus().length,
      loadAvg: os.loadavg()[0],
      uptime: process.uptime(),
    },
    ollama: {
      reachable: ollamaReachable,
    },
    features: {
      webSearch: isWebSearchEnabled(),
      reasoning: isReasoningEnabled(),
    },
    tokens,
    cache: {
      size: cache.size,
      maxSize: cache.maxSize,
      hits: cache.hits,
      ttlSeconds: cache.ttlSeconds,
    },
    queue: {
      active: queue.active,
      queued: queue.queued,
      maxConcurrent: queue.maxConcurrent,
      totalCompleted: queue.totalCompleted,
      totalDropped: queue.totalDropped,
    },
  });
});

// ─── Log buffer (non-streaming) ──────────────────────────────────────────────
router.get('/api/logs', (_req: Request, res: Response) => {
  res.json({ logs: getLogBuffer() });
});

export default router;
