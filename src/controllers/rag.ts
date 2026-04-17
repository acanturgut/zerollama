import { Router, Request, Response } from 'express';
import { indexDirectories, ragStats, clearIndex, query } from '../services/rag';
import { log } from '../startup/dashboard';

const router = Router();

/**
 * POST /api/rag/index
 * Body: { directories: string[] }
 * Indexes the given directories for RAG context injection.
 */
router.post('/api/rag/index', (req: Request, res: Response) => {
  const { directories } = req.body ?? {};
  if (!Array.isArray(directories) || directories.length === 0) {
    res.status(400).json({ error: 'Missing required field: directories (string[])' });
    return;
  }

  // Validate all entries are strings
  for (const d of directories) {
    if (typeof d !== 'string' || d.trim().length === 0) {
      res.status(400).json({ error: 'Each directory must be a non-empty string' });
      return;
    }
  }

  try {
    const result = indexDirectories(directories.map((d: string) => d.trim()));
    res.json({ ok: true, ...result });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[${new Date().toISOString()}] RAG index error: ${msg}`);
    res.status(500).json({ error: 'Failed to index directories', detail: msg });
  }
});

/**
 * GET /api/rag/stats
 * Returns current RAG index statistics.
 */
router.get('/api/rag/stats', (_req: Request, res: Response) => {
  res.json(ragStats());
});

/**
 * POST /api/rag/query
 * Body: { query: string, topK?: number }
 * Returns matching chunks without going through a model.
 */
router.post('/api/rag/query', (req: Request, res: Response) => {
  const { query: q, topK } = req.body ?? {};
  if (!q || typeof q !== 'string') {
    res.status(400).json({ error: 'Missing required field: query (string)' });
    return;
  }
  const chunks = query(q.trim(), typeof topK === 'number' ? topK : undefined);
  res.json({ query: q, results: chunks, count: chunks.length });
});

/**
 * DELETE /api/rag/index
 * Clears the RAG index.
 */
router.delete('/api/rag/index', (_req: Request, res: Response) => {
  clearIndex();
  res.json({ ok: true });
});

export default router;
