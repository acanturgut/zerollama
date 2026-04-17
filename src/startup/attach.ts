/**
 * Attach-mode TUI: connects to a running Zerollama server and opens the
 * same full dashboard used in --ui mode.  Logs from the server are streamed
 * in via SSE so the dashboard stays in sync.
 */
import * as http from 'http';
import {
  createDashboard,
  startStatusMonitor,
  log,
  getScreen,
  logResponse,
  addTokenUsage,
  trackRequest,
  trackError,
  trackResponse,
} from './dashboard';
import { setupKeyboardShortcuts } from './keyboard';
import { checkConnection } from '../services/ollama';
import { OLLAMA_URL } from '../config';

export async function startAttachMode(port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;

  // ── Verify the server is running ────────────────────────────────────────
  try {
    const res = await fetch(`${baseUrl}/api/status`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch {
    console.error(`Cannot connect to Zerollama server at ${baseUrl}`);
    console.error(`  Make sure the server is running:  yarn start`);
    process.exit(1);
  }

  // ── Build the real dashboard ────────────────────────────────────────────
  createDashboard(() => shutdown());
  setupKeyboardShortcuts(() => shutdown());

  log(`Attached to server at ${baseUrl}`);

  const ollamaOk = await checkConnection();
  if (!ollamaOk) {
    log(`⚠ Ollama not reachable at ${OLLAMA_URL} — press s to start`);
  }
  const statusInterval = startStatusMonitor(ollamaOk);

  // ── Stream server events via SSE into the dashboard ─────────────────────
  function handleSSEEvent(evt: any): void {
    switch (evt.type) {
      case 'log':
        if (typeof evt.msg === 'string') log(evt.msg);
        break;
      case 'response':
        logResponse(evt.model, evt.prompt, evt.response, evt.rawJson);
        break;
      case 'tokens':
        addTokenUsage(evt.promptTokens ?? 0, evt.completionTokens ?? 0);
        break;
      case 'request':
        trackRequest();
        break;
      case 'error':
        trackError();
        break;
      case 'track_response':
        trackResponse();
        break;
    }
  }

  function connectSSE() {
    const url = new URL(`${baseUrl}/api/events`);
    http
      .get(url, (res) => {
        let buf = '';
        res.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          const lines = buf.split('\n');
          buf = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                handleSSEEvent(JSON.parse(line.slice(6)));
              } catch {
                /* ignore */
              }
            }
          }
        });
        res.on('end', () => {
          log('SSE disconnected — reconnecting…');
          setTimeout(connectSSE, 3000);
        });
        res.on('error', () => {
          setTimeout(connectSSE, 3000);
        });
      })
      .on('error', () => {
        setTimeout(connectSSE, 3000);
      });
  }
  connectSSE();

  // ── Shutdown ────────────────────────────────────────────────────────────
  function shutdown() {
    clearInterval(statusInterval);
    const s = getScreen();
    if (s) s.destroy();
    process.exit(0);
  }

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
