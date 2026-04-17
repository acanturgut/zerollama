import express from 'express';
import * as http from 'http';
import { PORT } from './config';
import { applyMiddleware } from './middleware';
import healthController from './controllers/health';
import modelsController from './controllers/models';
import chatController from './controllers/chat';
import ollamaControlController from './controllers/ollama-control';
import webSearchController from './controllers/web-search';
import { createDashboard, startStatusMonitor, log, getScreen } from './startup/dashboard';
import { setupKeyboardShortcuts } from './startup/keyboard';
import { checkConnection, stopOllama, startOllama } from './services/ollama';

const app = express();

applyMiddleware(app);

app.use(healthController);
app.use(modelsController);
app.use(chatController);
app.use(ollamaControlController);
app.use(webSearchController);

// ─── 404 handler ─────────────────────────────────────────────────────────────
app.use((_req: express.Request, res: express.Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── Global error handler ────────────────────────────────────────────────────
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err.stack ?? err.message ?? String(err);
  log(`[${new Date().toISOString()}] Unhandled error: ${msg}`);
  if (!res.headersSent) {
    res.status(500).json({ error: 'Internal server error', detail: msg });
  }
});

// ─── Graceful shutdown ───────────────────────────────────────────────────────
const server: http.Server = app.listen(PORT, '0.0.0.0', async () => {
  createDashboard(() => shutdown('keyboard'));
  setupKeyboardShortcuts(() => shutdown('keyboard'));
  log(`Server listening on 0.0.0.0:${PORT}`);

  // Check Ollama in the background — don't block the UI
  let ollamaOk = await checkConnection();
  if (!ollamaOk) {
    log(`Ollama not running — starting automatically…`);
    ollamaOk = await startOllama();
    log(ollamaOk ? 'Ollama started' : 'Ollama failed to start');
  }
  statusInterval = startStatusMonitor(ollamaOk);
});
let statusInterval: NodeJS.Timeout;

function shutdown(_signal = 'signal') {
  clearInterval(statusInterval);
  stopOllama().catch(() => {});
  const s = getScreen();
  if (s) {
    s.destroy();
  }
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => {
    process.exit(1);
  }, 5000).unref();
}

// ─── Start ───────────────────────────────────────────────────────────────────
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
