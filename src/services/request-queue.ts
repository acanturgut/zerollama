import { log } from '../startup/dashboard';

// ─── Configuration ──────────────────────────────────────────────────────────
const MAX_CONCURRENT = parseInt(process.env.QUEUE_MAX_CONCURRENT ?? '2', 10);
const MAX_QUEUE_SIZE = parseInt(process.env.QUEUE_MAX_SIZE ?? '50', 10);

export type Priority = 'high' | 'normal' | 'low';

interface QueueItem<T> {
  id: string;
  priority: Priority;
  enqueuedAt: number;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
  execute: () => Promise<T>;
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, normal: 1, low: 2 };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const queue: QueueItem<any>[] = [];
let activeCount = 0;
let totalEnqueued = 0;
let totalCompleted = 0;
let totalDropped = 0;

// ─── Enqueue a task ─────────────────────────────────────────────────────────
export function enqueue<T>(
  execute: () => Promise<T>,
  priority: Priority = 'normal',
  label?: string,
): Promise<T> {
  // Try immediate execution if below concurrency cap
  if (activeCount < MAX_CONCURRENT && queue.length === 0) {
    totalEnqueued++;
    return runTask(execute, label);
  }

  if (queue.length >= MAX_QUEUE_SIZE) {
    totalDropped++;
    log(`[${new Date().toISOString()}] Queue full (${MAX_QUEUE_SIZE}), rejecting request`);
    return Promise.reject(new Error('Request queue full'));
  }

  totalEnqueued++;
  const id = `q-${Date.now()}-${totalEnqueued}`;

  return new Promise<T>((resolve, reject) => {
    const item: QueueItem<T> = {
      id,
      priority,
      enqueuedAt: Date.now(),
      resolve,
      reject,
      execute,
    };
    queue.push(item);
    // Sort by priority (high first), then by arrival time
    queue.sort((a, b) => {
      const pDiff = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
      if (pDiff !== 0) return pDiff;
      return a.enqueuedAt - b.enqueuedAt;
    });

    if (label) {
      log(`[${new Date().toISOString()}] Queued ${label} pos=${positionOf(id)} pri=${priority}`);
    }
  });
}

function positionOf(id: string): number {
  const idx = queue.findIndex((item) => item.id === id);
  return idx >= 0 ? idx + 1 : -1;
}

// ─── Execute a task (counts against concurrency) ────────────────────────────
async function runTask<T>(execute: () => Promise<T>, _label?: string): Promise<T> {
  activeCount++;
  try {
    const result = await execute();
    totalCompleted++;
    return result;
  } finally {
    activeCount--;
    drain();
  }
}

// ─── Drain the queue ────────────────────────────────────────────────────────
function drain(): void {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const item = queue.shift()!;
    activeCount++;
    item
      .execute()
      .then((result) => {
        totalCompleted++;
        item.resolve(result);
      })
      .catch((err) => {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        activeCount--;
        drain();
      });
  }
}

// ─── Stats for TUI ──────────────────────────────────────────────────────────
export function queueStats(): {
  queued: number;
  active: number;
  maxConcurrent: number;
  maxSize: number;
  totalEnqueued: number;
  totalCompleted: number;
  totalDropped: number;
} {
  return {
    queued: queue.length,
    active: activeCount,
    maxConcurrent: MAX_CONCURRENT,
    maxSize: MAX_QUEUE_SIZE,
    totalEnqueued,
    totalCompleted,
    totalDropped,
  };
}

// ─── Position lookup (for per-request waiting-position responses) ───────────
export function queuePosition(id: string): number {
  return positionOf(id);
}
