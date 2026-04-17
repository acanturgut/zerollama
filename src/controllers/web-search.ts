import { Router, Request, Response } from 'express';
import { WEB_SEARCH_MAX_RESULTS, isWebSearchEnabled } from '../config';
import { searchWeb } from '../services/web-search';
import { log } from '../startup/dashboard';

const router = Router();

async function handleSearch(req: Request, res: Response) {
  if (!isWebSearchEnabled()) {
    res.status(503).json({ error: 'Web search is disabled' });
    return;
  }

  const query = String(req.query.q ?? req.body?.query ?? '').trim();
  const maxResults = Number(
    req.query.max_results ?? req.body?.max_results ?? WEB_SEARCH_MAX_RESULTS,
  );

  if (!query) {
    res.status(400).json({ error: 'Missing required query: q or query' });
    return;
  }

  try {
    const results = await searchWeb(query, maxResults);
    res.json({ query, results, count: results.length });
  } catch (err) {
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Web search error: ${msg}`);
    res.status(502).json({ error: 'Web search failed', detail: msg });
  }
}

router.get('/api/web-search', handleSearch);
router.post('/api/web-search', handleSearch);

export default router;
