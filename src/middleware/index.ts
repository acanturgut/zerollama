import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import express, { Request, Response, NextFunction } from 'express';
import type { Express } from 'express';
import {
  log,
  trackRequest,
  trackError,
  trackResponse,
} from '../startup/dashboard';

export function applyMiddleware(app: Express): void {
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
    }),
  );
  app.disable('x-powered-by');

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));

  app.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Too many requests, please slow down.' },
    }),
  );

  // Request logger with response timing and headers
  app.use((req: Request, res: Response, next: NextFunction) => {
    trackRequest();
    const start = Date.now();
    const { method, path, headers } = req;
    const headerSummary = JSON.stringify({
      'content-type': headers['content-type'],
      'user-agent': headers['user-agent'],
      authorization: headers['authorization'] ? '[redacted]' : undefined,
      'x-forwarded-for': headers['x-forwarded-for'],
    });
    const bodySnippet =
      method === 'POST' || method === 'PUT' || method === 'PATCH'
        ? ` body=${JSON.stringify(req.body ?? {}).slice(0, 500)}`
        : '';
    log(
      `[${new Date().toISOString()}] → ${method} ${path} ${headerSummary}${bodySnippet}`,
    );
    res.on('finish', () => {
      const ms = Date.now() - start;
      if (res.statusCode >= 400) trackError();
      else trackResponse();
      log(
        `[${new Date().toISOString()}] ← ${method} ${path} ${res.statusCode} (${ms}ms)`,
      );
    });
    next();
  });
}
