import { log } from '../startup/dashboard';

// ─── Configuration ──────────────────────────────────────────────────────────
// Comma-separated list of Ollama URLs: OLLAMA_BACKENDS=http://host1:11434,http://host2:11434
const BACKENDS_ENV = process.env.OLLAMA_BACKENDS ?? '';

export interface Backend {
  url: string;
  healthy: boolean;
  activeRequests: number;
  totalRequests: number;
  lastChecked: number;
  lastLatencyMs: number;
}

const backends: Backend[] = [];

// Initialize from env — fall back to primary OLLAMA_URL if OLLAMA_BACKENDS is unset
export function initBackends(primaryUrl: string): void {
  backends.length = 0;
  const urls = BACKENDS_ENV
    ? BACKENDS_ENV.split(',')
        .map((u) => u.trim())
        .filter(Boolean)
    : [primaryUrl];

  for (const url of urls) {
    backends.push({
      url: url.replace(/\/+$/, ''),
      healthy: true,
      activeRequests: 0,
      totalRequests: 0,
      lastChecked: 0,
      lastLatencyMs: 0,
    });
  }

  if (backends.length > 1) {
    log(
      `[${new Date().toISOString()}] Multi-backend routing: ${backends.length} backends configured`,
    );
  }
}

// ─── Health check all backends ──────────────────────────────────────────────
export async function healthCheckAll(): Promise<void> {
  await Promise.allSettled(
    backends.map(async (b) => {
      const start = Date.now();
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 5000);
        const resp = await fetch(`${b.url}/api/tags`, { signal: ctrl.signal });
        clearTimeout(timeout);
        b.healthy = resp.ok;
        b.lastLatencyMs = Date.now() - start;
      } catch {
        b.healthy = false;
        b.lastLatencyMs = Date.now() - start;
      }
      b.lastChecked = Date.now();
    }),
  );
}

// ─── Pick the best (healthy + least loaded) backend ─────────────────────────
export function pickBackend(): Backend | null {
  const healthy = backends.filter((b) => b.healthy);
  if (healthy.length === 0) return null;
  // Least active requests → then lowest latency
  healthy.sort((a, b) => {
    if (a.activeRequests !== b.activeRequests) return a.activeRequests - b.activeRequests;
    return a.lastLatencyMs - b.lastLatencyMs;
  });
  return healthy[0];
}

// ─── Wrap a fetch to Ollama through the router ──────────────────────────────
export async function routedFetch(
  path: string,
  init: RequestInit,
): Promise<{ resp: globalThis.Response; backend: Backend }> {
  const backend = pickBackend();
  if (!backend) throw new Error('All Ollama backends are unreachable');

  backend.activeRequests++;
  backend.totalRequests++;
  try {
    const resp = await fetch(`${backend.url}${path}`, init);
    return { resp, backend };
  } catch (err) {
    backend.healthy = false;
    throw err;
  } finally {
    backend.activeRequests--;
  }
}

// ─── Simple proxy fetch (same signature as raw fetch but routed) ────────────
export async function routedOllamaFetch(
  path: string,
  init: RequestInit,
): Promise<globalThis.Response> {
  const { resp } = await routedFetch(path, init);
  return resp;
}

// ─── Stats for TUI ──────────────────────────────────────────────────────────
export function backendStats(): Backend[] {
  return backends.map((b) => ({ ...b }));
}

export function isMultiBackend(): boolean {
  return backends.length > 1;
}
