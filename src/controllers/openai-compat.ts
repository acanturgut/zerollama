import { Router, Request, Response } from 'express';
import {
  OLLAMA_URL,
  WEB_SEARCH_MAX_RESULTS,
  isWebSearchEnabled,
  isReasoningEnabled,
} from '../config';
import { searchWeb } from '../services/web-search';
import { log, addTokenUsage, logResponse } from '../startup/dashboard';
import { fireWebhook } from '../services/webhook';
import { cacheKey, cacheGet, cacheSet, isCacheEnabled } from '../services/prompt-cache';
import { enqueue } from '../services/request-queue';
import { routedOllamaFetch } from '../services/backend-router';
import { buildRagContext, isRagEnabled } from '../services/rag';
import {
  getOrCreateActiveSession,
  getSession,
  appendMessages,
  autoNameSession,
  ChatMessage,
} from '../services/sessions';

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

// ─── Parse reasoning / thinking blocks ───────────────────────────────────────
function splitThinkContent(text: string): { thinking: string; content: string } {
  const openIdx = text.indexOf('<think>');
  if (openIdx === -1) return { thinking: '', content: text };
  const closeIdx = text.indexOf('</think>', openIdx);
  if (closeIdx === -1) {
    return { thinking: text.slice(openIdx + 7).trim(), content: '' };
  }
  const thinking = text.slice(openIdx + 7, closeIdx).trim();
  const content = (text.slice(0, openIdx) + text.slice(closeIdx + 8)).trim();
  return { thinking, content };
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

  const rawContent: string = message.content ?? '';
  const { thinking, content: mainContent } = isReasoningEnabled()
    ? splitThinkContent(rawContent)
    : { thinking: '', content: rawContent.replace(/<think>[\s\S]*?<\/think>/g, '').trim() };

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
          content: toolCalls ? null : mainContent,
          ...(thinking ? { reasoning_content: thinking } : {}),
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

// ─── Detect explicit user search intent ──────────────────────────────────────
function userExplicitlyAsksForSearch(text: string): boolean {
  const t = text.toLowerCase();
  return /(search\s+(the\s+)?(web|internet|online|google|bing|duckduckgo)|look\s*(it)?\s*up\s*(online|on the web|on the internet)?|find\s+(online|on the web|on the internet)|go\s+online|browse\s+the\s+(web|internet)|google\s+(it|this|that|for)|search\s+for\s+it|web\s+search|internet\s+search)/.test(
    t,
  );
}

function looksLikeWebQuery(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(latest|recent|current|news|today|weather|forecast|temperature|stock|price|score|live|real-time|what is|who is|when is|where is|how much|how many)/.test(
      t,
    ) || t.includes('?')
  );
}

function modelIndicatesUncertainty(text: string): boolean {
  const t = text.toLowerCase();
  return /(cannot|can't|unable|don't)\s+(access|browse|search).*(internet|web)|unable to find|could not find|couldn't find|can't find|no information|i do not know|i don't know|my (training|knowledge).*cut[- ]?off|as of my|not aware of|recommend checking|check (a|an|the)?\s*(website|websites)|don't have access.*(real[- ]?time|live|current).*(data|information)/.test(
    t,
  );
}

// ─── Simple web-search injection for OpenAI-compat layer ─────────────────────
async function resolveWithWebSearch(body: Record<string, any>, signal: AbortSignal): Promise<any> {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
  const query = String(lastUser?.content ?? '').trim();

  // If user explicitly asks for search, search immediately before calling model
  if (isWebSearchEnabled() && query && userExplicitlyAsksForSearch(query)) {
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

  const upstream = await routedOllamaFetch('/api/chat', {
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

  const data = (await upstream.json()) as any;

  // If model shows uncertainty and query looks web-searchable, retry with context
  const responseText = String(data?.message?.content ?? '');
  if (
    isWebSearchEnabled() &&
    query &&
    !body._webRetried &&
    (looksLikeWebQuery(query) || userExplicitlyAsksForSearch(query)) &&
    modelIndicatesUncertainty(responseText)
  ) {
    log(`[${new Date().toISOString()}] OpenAI-compat: model uncertain, retrying with web context`);
    const results = await searchWeb(query, WEB_SEARCH_MAX_RESULTS);
    if (results.length > 0) {
      const context = results
        .map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}`)
        .join('\n\n');
      const retryBody = {
        ...body,
        _webRetried: true,
        messages: [
          ...messages,
          {
            role: 'system',
            content: 'Use the provided web_search_context to answer. Cite URLs when helpful.',
          },
          {
            role: 'system',
            content: `web_search_context:\n${context}`,
          },
        ],
      };
      const retry = await routedOllamaFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...retryBody, stream: false }),
        signal,
      });
      if (retry.ok) return retry.json();
    }
  }

  return data;
}

// ─── POST /v1/chat/completions ───────────────────────────────────────────────
router.post('/v1/chat/completions', async (req: Request, res: Response) => {
  const { model, messages, stream, tools, temperature, max_tokens, top_p, stop, session_id } =
    req.body ?? {};

  if (!model || !Array.isArray(messages)) {
    res.status(400).json({
      error: { message: 'model and messages are required', type: 'invalid_request_error' },
    });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  // ── Session: resolve & prepend history (safe — never crash) ──────────
  let sessionId: string | undefined;
  let fullMessages = [...messages];

  try {
    if (session_id !== false) {
      const session =
        session_id && typeof session_id === 'string'
          ? getSession(session_id)
          : getOrCreateActiveSession();

      if (session) {
        sessionId = session.id;
        if (session.messages.length > 0) {
          const historyMsgs = session.messages.map((m) => ({
            role: m.role,
            content: m.content,
          }));
          fullMessages = [...historyMsgs, ...messages];
        }
      }
    }
  } catch {
    // Session load failed — continue without session context
  }

  const ollamaMessages = toOllamaMessages(fullMessages);

  // ── Inject RAG context ──────────────────────────────────────────────────
  if (isRagEnabled()) {
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
    const ragCtx = buildRagContext(String(lastUser?.content ?? ''));
    if (ragCtx) {
      ollamaMessages.push({
        role: 'system',
        content: `Relevant context from local files:\n${ragCtx}`,
      });
    }
  }

  const ollamaBody: Record<string, any> = {
    model,
    messages: ollamaMessages,
    stream: !!stream,
    options: {
      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_tokens !== undefined ? { num_predict: max_tokens } : {}),
      ...(top_p !== undefined ? { top_p } : {}),
      ...(stop !== undefined ? { stop } : {}),
    },
  };
  if (toOllamaTools(tools)) ollamaBody.tools = toOllamaTools(tools);

  // ── Check prompt cache (non-streaming only) ─────────────────────────────
  const ck = cacheKey(model, ollamaBody.messages, ollamaBody.options);
  if (isCacheEnabled() && !stream) {
    const cached = cacheGet(ck);
    if (cached) {
      log(`[${new Date().toISOString()}] Cache hit (OpenAI) for ${model}`);
      res.json(cached);
      return;
    }
  }

  try {
    if (stream) {
      // ── Streaming response ──────────────────────────────────────────────
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const upstream = await routedOllamaFetch('/api/chat', {
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
      let inThinkBlock = false;
      let thinkBuf = '';
      const reasoningOn = isReasoningEnabled();

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
            let token: string = chunk.message?.content ?? '';
            if (token) {
              fullContent += token;

              if (reasoningOn) {
                // Handle <think> block boundaries across streaming tokens
                if (!inThinkBlock && token.includes('<think>')) {
                  inThinkBlock = true;
                  const parts = token.split('<think>');
                  const before = parts[0];
                  if (before) res.write(buildStreamChunk(id, model, { content: before }, null));
                  thinkBuf += parts.slice(1).join('');
                  token = '';
                }
                if (inThinkBlock) {
                  if (token) thinkBuf += token;
                  if (thinkBuf.includes('</think>')) {
                    inThinkBlock = false;
                    const parts = thinkBuf.split('</think>');
                    const reasoning = parts[0].trim();
                    const after = parts.slice(1).join('').trim();
                    if (reasoning) {
                      res.write(
                        buildStreamChunk(id, model, { reasoning_content: reasoning } as any, null),
                      );
                    }
                    if (after) res.write(buildStreamChunk(id, model, { content: after }, null));
                    thinkBuf = '';
                  }
                } else if (token) {
                  res.write(buildStreamChunk(id, model, { content: token }, null));
                }
              } else {
                // Reasoning disabled — strip <think> blocks silently
                if (!inThinkBlock && token.includes('<think>')) {
                  inThinkBlock = true;
                  const parts = token.split('<think>');
                  const before = parts[0];
                  if (before) res.write(buildStreamChunk(id, model, { content: before }, null));
                  thinkBuf = parts.slice(1).join('');
                  token = '';
                }
                if (inThinkBlock) {
                  if (token) thinkBuf += token;
                  if (thinkBuf.includes('</think>')) {
                    inThinkBlock = false;
                    const after = thinkBuf.split('</think>').slice(1).join('').trim();
                    if (after) res.write(buildStreamChunk(id, model, { content: after }, null));
                    thinkBuf = '';
                  }
                } else if (token) {
                  res.write(buildStreamChunk(id, model, { content: token }, null));
                }
              }
            }
            if (chunk.done) {
              res.write(buildStreamChunk(id, model, {}, 'stop'));
              res.write('data: [DONE]\n\n');
              addTokenUsage(chunk.prompt_eval_count ?? 0, chunk.eval_count ?? 0);
              const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
              logResponse(model, lastUser?.content ?? '', fullContent);
              void fireWebhook({ model, prompt: lastUser?.content ?? '', response: fullContent });

              // Persist to session (streaming — safe)
              if (sessionId) {
                try {
                  const userMsgs: ChatMessage[] = messages
                    .filter((m: any) => m.role === 'user')
                    .map((m: any) => ({ role: 'user' as const, content: String(m.content ?? '') }));
                  const assistantMsg: ChatMessage = { role: 'assistant', content: fullContent };
                  appendMessages(sessionId, [...userMsgs, assistantMsg]);
                  const sess = getSession(sessionId);
                  if (sess && sess.messages.length <= userMsgs.length + 1) {
                    autoNameSession(sessionId, lastUser?.content ?? '');
                  }
                } catch {
                  /* session persist failed — ok */
                }
              }
            }
          } catch {
            // skip unparseable chunks
          }
        }
      }
      res.end();
      return;
    }

    // ── Non-streaming response (queued) ────────────────────────────────────
    const ollamaData = await enqueue(
      () => resolveWithWebSearch(ollamaBody, controller.signal),
      'normal',
      `openai:${model}`,
    );

    if (ollamaData.prompt_eval_count || ollamaData.eval_count) {
      addTokenUsage(ollamaData.prompt_eval_count ?? 0, ollamaData.eval_count ?? 0);
    }

    const completion = buildCompletion(ollamaData, model);
    const lastUser = [...messages].reverse().find((m: any) => m.role === 'user');
    const responseText = ollamaData.message?.content ?? '';
    logResponse(model, lastUser?.content ?? '', responseText, JSON.stringify(ollamaData, null, 2));
    void fireWebhook({ model, prompt: lastUser?.content ?? '', response: responseText });

    // ── Persist to session (safe — never crash) ──────────────────────────
    if (sessionId) {
      try {
        const userMsgs: ChatMessage[] = messages
          .filter((m: any) => m.role === 'user')
          .map((m: any) => ({ role: 'user' as const, content: String(m.content ?? '') }));
        const assistantMsg: ChatMessage = { role: 'assistant', content: responseText };
        appendMessages(sessionId, [...userMsgs, assistantMsg]);
        const session = getSession(sessionId);
        if (session && session.messages.length <= userMsgs.length + 1) {
          autoNameSession(sessionId, lastUser?.content ?? '');
        }
        completion.session_id = sessionId;
      } catch {
        /* session persist failed — ok */
      }
    }

    // ── Store in prompt cache ─────────────────────────────────────────────
    if (isCacheEnabled()) {
      cacheSet(ck, completion);
    }

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
    const upstream = await routedOllamaFetch('/api/tags', {});
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
