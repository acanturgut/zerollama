import { Request, Response, NextFunction } from 'express';
import { log } from '../startup/dashboard';

// ─── Configuration ──────────────────────────────────────────────────────────
const WINDOW_MS = parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000', 10);
const MAX_PER_IP = parseInt(process.env.RATE_LIMIT_PER_IP ?? '60', 10);
const MAX_PER_KEY = parseInt(process.env.RATE_LIMIT_PER_KEY ?? '120', 10);

interface Bucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, Bucket>();
const keyBuckets = new Map<string, Bucket>();

// ─── Periodic cleanup to prevent unbounded growth ───────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of ipBuckets) if (now > b.resetAt) ipBuckets.delete(k);
  for (const [k, b] of keyBuckets) if (now > b.resetAt) keyBuckets.delete(k);
}, 60_000).unref();

function getBucket(map: Map<string, Bucket>, key: string): Bucket {
  const now = Date.now();
  let bucket = map.get(key);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    map.set(key, bucket);
  }
  return bucket;
}

function extractApiKey(req: Request): string | null {
  const authHeader = req.headers['authorization'] ?? '';
  const xApiKey = req.headers['x-api-key'] ?? '';
  const bearer = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  const headerKey = typeof xApiKey === 'string' ? xApiKey.trim() : '';
  return bearer || headerKey || null;
}

/**
 * Per-IP and per-API-key rate limiter.
 * Uses simple sliding-window counters in memory.
 * Configure via RATE_LIMIT_WINDOW_MS, RATE_LIMIT_PER_IP, RATE_LIMIT_PER_KEY.
 * Set RATE_LIMIT_PER_IP=0 to disable per-IP limiting.
 * Set RATE_LIMIT_PER_KEY=0 to disable per-key limiting.
 */
export function granularRateLimit(req: Request, res: Response, next: NextFunction): void {
  // Always pass health checks
  if (req.path === '/health') {
    next();
    return;
  }

  const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';

  // ── Per-IP check ──────────────────────────────────────────────────────────
  if (MAX_PER_IP > 0) {
    const bucket = getBucket(ipBuckets, ip);
    bucket.count++;
    const remaining = Math.max(0, MAX_PER_IP - bucket.count);
    res.setHeader('X-RateLimit-Limit', MAX_PER_IP);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > MAX_PER_IP) {
      log(`[${new Date().toISOString()}] Rate limit (IP): ${req.method} ${req.path} from ${ip}`);
      res.status(429).json({ error: 'Too many requests (per-IP limit)' });
      return;
    }
  }

  // ── Per-key check ─────────────────────────────────────────────────────────
  const apiKey = extractApiKey(req);
  if (MAX_PER_KEY > 0 && apiKey) {
    const bucket = getBucket(keyBuckets, apiKey);
    bucket.count++;
    if (bucket.count > MAX_PER_KEY) {
      log(
        `[${new Date().toISOString()}] Rate limit (key): ${req.method} ${req.path} key=${apiKey.slice(0, 8)}…`,
      );
      res.status(429).json({ error: 'Too many requests (per-key limit)' });
      return;
    }
  }

  next();
}

// ─── Stats for TUI ──────────────────────────────────────────────────────────
export function rateLimitStats(): { trackedIPs: number; trackedKeys: number } {
  return { trackedIPs: ipBuckets.size, trackedKeys: keyBuckets.size };
}
