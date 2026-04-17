import * as crypto from 'crypto';
import { log } from '../startup/dashboard';

// ─── Configuration ──────────────────────────────────────────────────────────
const DEFAULT_TTL_MS = parseInt(process.env.CACHE_TTL_SECONDS ?? '300', 10) * 1000;
const MAX_ENTRIES = parseInt(process.env.CACHE_MAX_ENTRIES ?? '200', 10);

interface CacheEntry {
  response: any;
  createdAt: number;
  ttlMs: number;
  hits: number;
}

const cache = new Map<string, CacheEntry>();

// ─── Hash a prompt + model into a stable key ─────────────────────────────────
export function cacheKey(model: string, messages: any[], options?: Record<string, any>): string {
  const payload = JSON.stringify({ model, messages, options: options ?? {} });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

// ─── Lookup ─────────────────────────────────────────────────────────────────
export function cacheGet(key: string): any | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > entry.ttlMs) {
    cache.delete(key);
    return null;
  }
  entry.hits++;
  return entry.response;
}

// ─── Store ──────────────────────────────────────────────────────────────────
export function cacheSet(key: string, response: any, ttlMs?: number): void {
  // Evict oldest entries if at capacity
  if (cache.size >= MAX_ENTRIES) {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;
    for (const [k, v] of cache) {
      if (v.createdAt < oldestTime) {
        oldestTime = v.createdAt;
        oldestKey = k;
      }
    }
    if (oldestKey) cache.delete(oldestKey);
  }

  cache.set(key, {
    response,
    createdAt: Date.now(),
    ttlMs: ttlMs ?? DEFAULT_TTL_MS,
    hits: 0,
  });
}

// ─── Stats (for TUI info pane) ──────────────────────────────────────────────
export function cacheStats(): { size: number; maxSize: number; hits: number; ttlSeconds: number } {
  let totalHits = 0;
  for (const entry of cache.values()) totalHits += entry.hits;
  return {
    size: cache.size,
    maxSize: MAX_ENTRIES,
    hits: totalHits,
    ttlSeconds: DEFAULT_TTL_MS / 1000,
  };
}

// ─── Clear ──────────────────────────────────────────────────────────────────
export function cacheClear(): number {
  const removed = cache.size;
  cache.clear();
  log(`[${new Date().toISOString()}] Prompt cache cleared (${removed} entries)`);
  return removed;
}

// ─── Enabled check (off when TTL=0) ─────────────────────────────────────────
export function isCacheEnabled(): boolean {
  return DEFAULT_TTL_MS > 0;
}
