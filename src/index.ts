import express from 'express';
import * as http from 'http';
import { OLLAMA_URL, PORT } from './config';
import { applyMiddleware } from './middleware';
import { apiKeyAuth } from './middleware/auth';
import { granularRateLimit } from './middleware/rate-limit';
import healthController from './controllers/health';
import modelsController from './controllers/models';
import chatController from './controllers/chat';
import ollamaControlController from './controllers/ollama-control';
import webSearchController from './controllers/web-search';
import openaiCompatController from './controllers/openai-compat';
import ragController from './controllers/rag';
import sessionsController from './controllers/sessions';
import eventsController from './controllers/events';
import { createDashboard, startStatusMonitor, log, getScreen } from './startup/dashboard';
import { setupKeyboardShortcuts } from './startup/keyboard';
import { checkConnection } from './services/ollama';
import { initBackends } from './services/backend-router';
import { loadIndex } from './services/rag';
import { pushLog } from './services/log-buffer';

// ─── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const withUI = args.includes('--ui');
const attachMode = args.includes('--attach');
// Default is headless (server only). Use --ui for embedded TUI.
const headless = !withUI;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  zerollama — Ollama middleware proxy

  Usage:
    yarn start              Start middleware server (headless)
    zlm                     Attach TUI dashboard to running server
    yarn start --ui         Start server with embedded TUI

  Options:
    --ui              Start with TUI dashboard embedded in server
    --attach          Attach TUI to running server (same as zlm)
    -h, --help        Show this help
`);
  process.exit(0);
}

// ─── Attach mode: TUI client connecting to existing server ───────────────────
if (attachMode) {
  import('./startup/attach')
    .then((mod) => mod.startAttachMode(PORT))
    .catch((err) => {
      console.error('Failed to start attach mode:', err.message);
      process.exit(1);
    });
} else {
  // ─── Server mode (default or --headless) ─────────────────────────────────
  const app = express();

  applyMiddleware(app);
  app.use(apiKeyAuth);
  app.use(granularRateLimit);

  initBackends(OLLAMA_URL);
  loadIndex();

  app.use(healthController);
  app.use(modelsController);
  app.use(chatController);
  app.use(ollamaControlController);
  app.use(webSearchController);
  app.use(openaiCompatController);
  app.use(ragController);
  app.use(sessionsController);
  app.use(eventsController);

  app.use((_req: express.Request, res: express.Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const msg = err.stack ?? err.message ?? String(err);
      const logFn = headless ? pushLog : log;
      logFn(`[${new Date().toISOString()}] Unhandled error: ${msg}`);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error', detail: msg });
      }
    },
  );

  const server: http.Server = app.listen(PORT, '0.0.0.0', async () => {
    if (!headless) {
      createDashboard(() => shutdown('keyboard'));
      setupKeyboardShortcuts(() => shutdown('keyboard'));
      log(`Server listening on 0.0.0.0:${PORT}`);
    } else {
      pushLog(`[${new Date().toISOString()}] Server listening on 0.0.0.0:${PORT}`);
      console.log(`Zerollama server listening on 0.0.0.0:${PORT}`);
      console.log(`  Attach TUI:  zlm`);
      console.log(`  Events SSE:  curl -N http://localhost:${PORT}/api/events`);
      console.log(`  Status:      curl http://localhost:${PORT}/api/status`);
    }

    const ollamaOk = await checkConnection();
    if (!ollamaOk) {
      const msg = `⚠ Ollama not reachable at ${OLLAMA_URL} — press s to start or check it is running`;
      headless ? pushLog(msg) : log(msg);
    }
    statusInterval = startStatusMonitor(ollamaOk);
  });
  let statusInterval: NodeJS.Timeout;

  function shutdown(_signal = 'signal') {
    clearInterval(statusInterval);
    if (!headless) {
      const s = getScreen();
      if (s) s.destroy();
    }
    server.close(() => {
      process.exit(0);
    });
    setTimeout(() => {
      process.exit(1);
    }, 5000).unref();
  }

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
