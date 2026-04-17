import { log } from '../startup/dashboard';

export interface WebhookPayload {
  model: string;
  prompt: string;
  response: string;
  ts?: string;
}

const WEBHOOK_URL = process.env.WEBHOOK_URL ?? '';

export async function fireWebhook(payload: WebhookPayload): Promise<void> {
  if (!WEBHOOK_URL) return;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    await fetch(WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, ts: new Date().toISOString() }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
  } catch (err) {
    log(`[${new Date().toISOString()}] Webhook failed: ${(err as Error).message}`);
  }
}
