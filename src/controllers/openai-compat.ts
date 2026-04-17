import { Router, Request, Response } from 'express';
import { OLLAMA_URL, WEB_SEARCH_MAX_RESULTS, isWebSearchEnabled } from '../config';
import { searchWeb } from '../services/web-search';
import { log, addTokenUsage, logResponse } from '../startup/dashboard';
import { fireWebhook } from '../services/webhook';

const router = Router();

// ─── Map OpenAI finish_reason from Ollama done_reason ────────────────────────
function mapFinishReason(doneReason?: string): string {
  if (doneReason === 'stop') return 'stop';
  if (doneReason === 'length') return 'length';
  if (doneReason === 'tool_calls') return 'tool_calls';
  return 'stop';
}

// ─── Convert OpenAI-style messages to Ollama format ──────────────────────────
function toOllamaMessages(messages: any[]): any[] {
  return messages.map((m) => {
    // tool_calls: convert from OpenAI format to Ollama format
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      return {
        role: 'assistant',
        content: m.content ?? '',
        tool_calls: m.tool_calls.map((tc: any) => ({
          function: {
            name: tc.function?.name,
            arguments:
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments,
          },
        })),
      };
    }
    // tool result
    if (m.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: m.tool_call_id,
        content: m.content,
      };
    }
    return m;
  });
}

// ─── Convert Ollama tools to OpenAI format (pass-through, they're compatible) ─
function toOllamaTools(tools?: any[]): any[] | undefined {
  return tools;
}

// ─── Build an OpenAI-compatible chat completion response ─────────────────────
function buildCompletion(ollamaData: any, model: string): any {
  const message = ollamaData.message ?? {};
  const toolCalls =
    Array.isArray(message.tool_calls) && message.tool_calls.length > 0
      ? message.tool_calls.map((tc: any, idx: number) => ({
          id: `call_${Date.now()}_${idx}`,
          type: 'function',
          function: {
            name: tc.function?.name ?? '',
            arguments:
              typeof tc.function?.arguments === 'object'
                ? JSON.stringify(tc.function.arguments)
                : (tc.function?.arguments ?? '{}'),
          },
        }))
      : undefined;

  return {
    id: `chatcmpl-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: toolCalls ? null : (message.content ?? ''),
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: mapFinishReason(ollamaData.done_reason),
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: ollamaData.prompt_eval_count ?? 0,
      completion_tokens: ollamaData.eval_count ?? 0,
      total_tokens: (ollamaData.prompt_eval_count ?? 0) + (ollamaData.eval_count ?? 0),
    },
    system_fingerprint: null,
  };
}

// ─── Build an OpenAI-compatible streaming chunk ──────────────────────────────
function buildStreamChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): string {
  return (
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    }) +
    '\n\n'
  );
}

// ─── Simple web-search injection for OpenAI-compat layer ─────────────────────
async function resolveWithWebSearch(body: Record<string, any>, signal: AbortSignal): Promise<any> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
  const query = String(lastUser?.content ?? '').trim();

  if (isWebSearchEnabled() && query) {
    const results = await searchWeb(query, WEB_SEARCH_MAX_RESULTS);
    if (results.length > 0) {
      const context = results
        .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
        .join('\n\n');
      body.messages = [
        ...messages,
        {
          role: 'system',
          content: `web_search_context:\n${context}`,
        },
      ];
    }
  }

  const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: false }),
    signal,
  });

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    const err: any = new Error(`Ollama ${upstream.status}`);
    err.status = upstream.status;
    err.detail = text;
    throw err;
  }

  return upstream.json();
}

// ─── POST /v1/chat/completions ───────────────────────────────────────────────
router.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const { model, messages, stream, tools, temperature, max_tokens, top_p, stop } = req.body ?? {};

  if (!model || !Array.isArray(messages)) {
    res.status(400).json({
      error: { message: 'model and messages are required', type: 'invalid_request_error' },
    });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  const ollamaBody: Record<string, any> = {
    model,
    messages: toOllamaMessages(messages),
    stream: !!stream,
    options: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_tokens !== undefined ? { num_predict: max_tokens } : {}),
      ...(top_p !== undefined ? { top_p } : {}),
      ...(stop !== undefined ? { stop } : {}),
    },
  };
  if (toOllamaTools(tools)) ollamaBody.tools = toOllamaTools(tools);

  try {
    if (stream) {
      // ── Streaming response ──────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(ollamaBody),
        signal: controller.signal,
      });

      if (!upstream.ok || !upstream.body) {
        res.status(upstream.status).json({
          error: { message: `Ollama responded with ${upstream.status}`, type: 'upstream_error' },
        });
        return;
      }

      const id = `chatcmpl-${Date.now()}`;
      res.write(buildStreamChunk(id, model, { role: 'assistant', content: '' }, null));

      const reader = (upstream.body as any).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let fullContent = '';

      let done = false;
      while (!done) {
        const { done: d, value } = await reader.read();
        done = d;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line);
            const token: string = chunk.message?.content ?? '';
            if (token) {
              fullContent += token;
              res.write(buildStreamChunk(id, model, { content: token }, null));
            }
            if (chunk.done) {
              res.write(buildStreamChunk(id, model, {}, 'stop'));
              res.write('data: [DONE]\n\n');
              addTokenUsage(chunk.prompt_eval_count ?? 0, chunk.eval_count ?? 0);
              const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
              logResponse(model, lastUser?.content ?? '', fullContent);
              void fireWebhook({ model, prompt: lastUser?.content ?? '', response: fullContent });
            }
          } catch {
            // skip unparseable chunks
          }
        }
      }
      res.end();
      return;
    }

    // ── Non-streaming response ──────────────────────────────────────────────
    const ollamaData = await resolveWithWebSearch(ollamaBody, controller.signal);

    if (ollamaData.prompt_eval_count || ollamaData.eval_count) {
      addTokenUsage(ollamaData.prompt_eval_count ?? 0, ollamaData.eval_count ?? 0);
    }

    const completion = buildCompletion(ollamaData, model);
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
    const responseText = ollamaData.message?.content ?? '';
    logResponse(model, lastUser?.content ?? '', responseText, JSON.stringify(ollamaData, null, 2));
    void fireWebhook({ model, prompt: lastUser?.content ?? '', response: responseText });

    res.json(completion);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === 'AbortError') return;
    const status = (err as any)?.status ?? 502;
    const detail = (err as any)?.detail ?? String(err);
    log(`[${new Date().toISOString()}] Error in /v1/chat/completions: ${detail}`);
    if (!res.headersSent) {
      res.status(status).json({ error: { message: detail, type: 'upstream_error' } });
    }
  }
});

// ─── GET /v1/models (OpenAI-compatible model list) ────────────────────────────
router.get('/v1/models', async (_req: Request, res: Response) => {
  try {
    const upstream = await fetch(`${OLLAMA_URL}/api/tags`);
    const data = (await upstream.json()) as any;
    const models = (data.models ?? []).map((m: any) => ({
      id: m.name,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'ollama',
    }));
    res.json({ object: 'list', data: models });
  } catch {
    res.status(502).json({ error: { message: 'Cannot reach Ollama', type: 'upstream_error' } });
  }
});

export default router;
