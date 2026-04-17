import { Router, Request, Response } from 'express';
import {
  checkConnection,
  startOllama,
  stopOllama,
  restartOllama,
} from '../services/ollama';
import { log } from '../startup/dashboard';

const router = Router();

router.post('/api/ollama/stop', async (_req: Request, res: Response) => {
  try {
    const stopped = await stopOllama();
    if (stopped) {
      log(`[${new Date().toISOString()}] Ollama stopped via API`);
      res.json({ status: 'stopped' });
    } else {
      res.json({
        status: 'warning',
        message: 'Stop signal sent but Ollama still responding',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error stopping Ollama: ${msg}`);
    res.status(500).json({ error: 'Failed to stop Ollama', detail: msg });
  }
});

router.post('/api/ollama/start', async (_req: Request, res: Response) => {
  const alreadyRunning = await checkConnection();
  if (alreadyRunning) {
    res.json({ status: 'already_running' });
    return;
  }

  try {
    const started = await startOllama();
    if (started) {
      log(`[${new Date().toISOString()}] Ollama started via API`);
      res.json({ status: 'started' });
    } else {
      res.status(504).json({
        status: 'timeout',
        message: 'Ollama started but not responding yet',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error starting Ollama: ${msg}`);
    res.status(500).json({ error: 'Failed to start Ollama', detail: msg });
  }
});

router.post('/api/ollama/restart', async (_req: Request, res: Response) => {
  try {
    const restarted = await restartOllama();
    if (restarted) {
      log(`[${new Date().toISOString()}] Ollama restarted via API`);
      res.json({ status: 'restarted' });
    } else {
      res.status(504).json({
        status: 'timeout',
        message: 'Ollama killed but not responding after restart',
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error restarting Ollama: ${msg}`);
    res.status(500).json({ error: 'Failed to restart Ollama', detail: msg });
  }
});

export default router;
