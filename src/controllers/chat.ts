import { Router, Request, Response } from 'express';
import { Readable, Transform } from 'stream';
import rateLimit from 'express-rate-limit';
import { OLLAMA_URL } from '../config';
import { log, addTokenUsage, logResponse } from '../startup/dashboard';

const router = Router();

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

router.post('/api/chat', chatLimiter, async (req: Request, res: Response) => {
  const { model, messages } = req.body ?? {};
  if (!model || typeof model !== 'string') {
    res.status(400).json({ error: 'Missing required field: model' });
    return;
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: 'Missing or empty field: messages' });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const body = { ...req.body };

  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!upstream.ok) {
      const errBody = await upstream.text().catch(() => '');
      log(
        `[${new Date().toISOString()}] Ollama /api/chat ${upstream.status}: ${errBody}`,
      );
      res
        .status(upstream.status)
        .json({
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

    const nodeStream = Readable.fromWeb(
      upstream.body as Parameters<typeof Readable.fromWeb>[0],
    );

    // Intercept stream to extract token usage and response text
    let responseText = '';
    let rawChunks: string[] = [];
    let buffer = '';
    const tokenSniffer = new Transform({
      transform(chunk, _encoding, callback) {
        buffer += chunk.toString();
        const parts = buffer.split('\n');
        // Keep the last part as it may be incomplete
        buffer = parts.pop() ?? '';
        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            rawChunks.push(line);
            if (parsed.message?.content) {
              responseText += parsed.message.content;
            }
            if (parsed.done) {
              if (parsed.prompt_eval_count || parsed.eval_count) {
                addTokenUsage(
                  parsed.prompt_eval_count ?? 0,
                  parsed.eval_count ?? 0,
                );
              }
              const lastUserMsg = [...messages]
                .reverse()
                .find((m: any) => m.role === 'user');
              const prompt = lastUserMsg?.content ?? '(no prompt)';
              logResponse(model, prompt, responseText, JSON.stringify(parsed, null, 2));
            }
          } catch {
            // not valid JSON yet
          }
        }
        callback(null, chunk);
      },
      flush(callback) {
        // Process any remaining buffered data
        if (buffer.trim()) {
          try {
            const parsed = JSON.parse(buffer);
            if (parsed.message?.content) {
              responseText += parsed.message.content;
            }
            if (parsed.done) {
              if (parsed.prompt_eval_count || parsed.eval_count) {
                addTokenUsage(
                  parsed.prompt_eval_count ?? 0,
                  parsed.eval_count ?? 0,
                );
              }
              const lastUserMsg = [...messages]
                .reverse()
                .find((m: any) => m.role === 'user');
              const prompt = lastUserMsg?.content ?? '(no prompt)';
              logResponse(model, prompt, responseText, JSON.stringify(parsed, null, 2));
            }
          } catch {
            // ignore
          }
        }
        callback();
      },
    });

    nodeStream.pipe(tokenSniffer).pipe(res);

    nodeStream.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code === 'ABORT_ERR') return;
      log(`Stream error: ${err}`);
      res.end();
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === 'AbortError') return;
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error in /api/chat: ${msg}`);
    if (!res.headersSent) {
      res
        .status(502)
        .json({ error: 'Cannot reach Ollama. Is it running?', detail: msg });
    }
  }
});

export default router;
