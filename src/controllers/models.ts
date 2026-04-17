import { Router, Request, Response } from 'express';
import { Readable } from 'stream';
import { OLLAMA_URL } from '../config';
import { log } from '../startup/dashboard';

const router = Router();

// List models
router.get(['/api/models', '/api/tags'], async (_req: Request, res: Response) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const upstream = await fetch(`${OLLAMA_URL}/api/tags`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      log(`[${new Date().toISOString()}] Ollama /api/tags ${upstream.status}: ${errBody}`);
      res.status(upstream.status).json({
        error: `Ollama responded with ${upstream.status}`,
        detail: errBody,
      });
      return;
    }
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error fetching models: ${msg}`);
    res.status(502).json({ error: 'Cannot reach Ollama. Is it running?', detail: msg });
  }
});

// Pull a model
router.post('/api/pull', async (req: Request, res: Response) => {
  const { name } = req.body ?? {};
  if (!name || typeof name !== 'string') {
    res.status(400).json({ error: 'Missing required field: name' });
    return;
  }

  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      log(`[${new Date().toISOString()}] Ollama /api/pull ${upstream.status}: ${errBody}`);
      res.status(upstream.status).json({
        error: `Ollama responded with ${upstream.status}`,
        detail: errBody,
      });
      return;
    }

    if (!upstream.body) {
      res.status(502).json({ error: 'No response body from Ollama' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Cache-Control', 'no-cache');

    const nodeStream = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
    nodeStream.pipe(res);
    nodeStream.on('error', (err) => {
      log(`[${new Date().toISOString()}] Pull stream error: ${err}`);
      res.end();
    });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error in /api/pull: ${msg}`);
    res.status(502).json({ error: 'Cannot reach Ollama. Is it running?', detail: msg });
  }
});

// Delete a model
router.delete('/api/models/:name', async (req: Request, res: Response) => {
  const modelName = req.params.name;
  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      log(`[${new Date().toISOString()}] Ollama /api/delete ${upstream.status}: ${errBody}`);
      res.status(upstream.status).json({
        error: `Ollama responded with ${upstream.status}`,
        detail: errBody,
      });
      return;
    }
    res.json({ status: 'deleted', model: modelName });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error deleting model: ${msg}`);
    res.status(502).json({ error: 'Cannot reach Ollama. Is it running?', detail: msg });
  }
});

export default router;
