import { Request, Response, NextFunction } from 'express';
import { log } from '../startup/dashboard';

const API_KEY = process.env.ZEROLLAMA_API_KEY ?? '';

/**
 * API key auth middleware.
 * Only active when ZEROLLAMA_API_KEY env var is set.
 * Passes through all /health requests unconditionally.
 * Accepts key via:
 *   Authorization: Bearer <key>
 *   x-api-key: <key>
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    next();
    return;
  }

  // Always allow health checks without auth
  if (req.path === '/health') {
    next();
    return;
  }

  const authHeader = req.headers['authorization'] ?? '';
  const xApiKey = req.headers['x-api-key'] ?? '';

  const bearer = typeof authHeader === 'string' ? authHeader.replace(/^Bearer\s+/i, '').trim() : '';
  const headerKey = typeof xApiKey === 'string' ? xApiKey.trim() : '';

  if (bearer === API_KEY || headerKey === API_KEY) {
    next();
    return;
  }

  log(`[${new Date().toISOString()}] Auth rejected: ${req.method} ${req.path} from ${req.ip}`);
  res.status(401).json({ error: 'Unauthorized', detail: 'Invalid or missing API key.' });
}
