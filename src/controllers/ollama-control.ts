import { Router, Request, Response } from 'express';
import { checkConnection, startOllama, stopOllama, restartOllama } from '../services/ollama';
import { log } from '../startup/dashboard';

const router = Router();

router.get('/api/ollama/status', async (_req: Request, res: Response) => {
  try {
    const reachable = await checkConnection();
    res.json({ status: reachable ? 'reachable' : 'unreachable' });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    res.status(500).json({ error: 'Status check failed', detail: msg });
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
    log(`[${new Date().toISOString()}] Ollama ${started ? 'started' : 'failed to start'} via API`);
    res.json({ status: started ? 'started' : 'failed' });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    res.status(500).json({ error: 'Failed to start Ollama', detail: msg });
  }
});

router.post('/api/ollama/stop', async (_req: Request, res: Response) => {
  try {
    const stopped = await stopOllama();
    log(`[${new Date().toISOString()}] Ollama ${stopped ? 'stopped' : 'still running'} via API`);
    res.json({ status: stopped ? 'stopped' : 'still_running' });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    res.status(500).json({ error: 'Failed to stop Ollama', detail: msg });
  }
});

router.post('/api/ollama/restart', async (_req: Request, res: Response) => {
  try {
    const ok = await restartOllama();
    log(`[${new Date().toISOString()}] Ollama ${ok ? 'restarted' : 'failed to restart'} via API`);
    res.json({ status: ok ? 'restarted' : 'failed' });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    res.status(500).json({ error: 'Failed to restart Ollama', detail: msg });
  }
});

export default router;
