import { Response } from 'express';

// ─── Circular log buffer ─────────────────────────────────────────────────────
const MAX_LINES = 2000;
const buffer: string[] = [];
const subscribers = new Set<(msg: string) => void>();

export function pushLog(msg: string): void {
  buffer.push(msg);
  if (buffer.length > MAX_LINES) buffer.shift();
  for (const cb of subscribers) {
    try { cb(msg); } catch { /* subscriber error — ignore */ }
  }
}

export function getLogBuffer(): string[] {
  return [...buffer];
}

export function subscribe(cb: (msg: string) => void): void {
  subscribers.add(cb);
}

export function unsubscribe(cb: (msg: string) => void): void {
  subscribers.delete(cb);
}

// ─── Structured event channel (for attach-mode TUI state sync) ──────────────
export interface StructuredEvent {
  type: 'response' | 'tokens' | 'request' | 'error' | 'track_response';
  [key: string]: any;
}

const eventSubscribers = new Set<(evt: StructuredEvent) => void>();

export function pushEvent(evt: StructuredEvent): void {
  for (const cb of eventSubscribers) {
    try { cb(evt); } catch { /* ignore */ }
  }
}

export function subscribeEvents(cb: (evt: StructuredEvent) => void): void {
  eventSubscribers.add(cb);
}

export function unsubscribeEvents(cb: (evt: StructuredEvent) => void): void {
  eventSubscribers.delete(cb);
}

// ─── SSE helper ──────────────────────────────────────────────────────────────
export function attachSSE(res: Response): () => void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current buffer as initial data
  for (const line of buffer) {
    res.write(`data: ${JSON.stringify({ type: 'log', msg: line })}\n\n`);
  }

  const onLog = (msg: string) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'log', msg })}\n\n`);
    } catch {
      unsubscribe(onLog);
    }
  };

  const onEvent = (evt: StructuredEvent) => {
    try {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    } catch {
      unsubscribeEvents(onEvent);
    }
  };

  subscribe(onLog);
  subscribeEvents(onEvent);

  // Heartbeat to detect dead connections
  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
  }, 15000);

  return () => {
    unsubscribe(onLog);
    unsubscribeEvents(onEvent);
    clearInterval(heartbeat);
  };
}
