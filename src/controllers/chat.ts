import { Router, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
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

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description:
      'Search the public web for recent factual information and return concise search results with titles, URLs, and snippets.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query to look up on the web.',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of search results to return (1-8).',
          minimum: 1,
          maximum: 8,
        },
      },
      required: ['query'],
    },
  },
};

function mergeTools(tools: any[] | undefined): any[] | undefined {
  if (!isWebSearchEnabled()) return tools;
  const incoming = Array.isArray(tools) ? [...tools] : [];
  const hasWebSearch = incoming.some(
    (tool) => tool?.function?.name === WEB_SEARCH_TOOL.function.name,
  );
  if (!hasWebSearch) incoming.push(WEB_SEARCH_TOOL);
  return incoming;
}

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (!args) return {};
  if (typeof args === 'string') {
    try {
      return JSON.parse(args) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof args === 'object') {
    return args as Record<string, unknown>;
  }
  return {};
}

function extractInlineToolCall(messageContent: unknown): {
  toolCall: any | null;
  cleanedContent: string;
} {
  const content = String(messageContent ?? '');
  const functionMatch = content.match(/<function=([a-zA-Z0-9_-]+)>/);
  if (!functionMatch) {
    return { toolCall: null, cleanedContent: content };
  }

  const name = functionMatch[1];
  const paramRegex = /<parameter=([a-zA-Z0-9_-]+)>([\s\S]*?)<\/parameter>/g;
  const args: Record<string, string> = {};
  for (const match of content.matchAll(paramRegex)) {
    args[match[1]] = match[2].trim();
  }

  const cleanedContent = content
    .replace(/<tool_call>/g, '')
    .replace(/<\/tool_call>/g, '')
    .replace(/<function=[a-zA-Z0-9_-]+>[\s\S]*?<\/function>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    toolCall: {
      function: {
        name,
        arguments: args,
      },
    },
    cleanedContent,
  };
}

function normalizeToolCall(toolCall: any): any {
  return {
    function: {
      name: String(toolCall?.function?.name ?? ''),
      arguments: parseToolArgs(toolCall?.function?.arguments),
    },
  };
}

function buildAssistantToolMessage(message: any): any {
  const normalizedCalls = Array.isArray(message?.tool_calls)
    ? message.tool_calls.map(normalizeToolCall).filter((t: any) => t.function.name)
    : [];

  return {
    role: 'assistant',
    content: '',
    tool_calls: normalizedCalls,
  };
}

async function requestOllamaChat(payload: Record<string, any>, signal: AbortSignal): Promise<any> {
  const upstream = await routedOllamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  if (!upstream.ok) {
    const errBody = await upstream.text().catch(() => '');
    const error: any = new Error(`Ollama responded with ${upstream.status}`);
    error.status = upstream.status;
    error.detail = errBody;
    throw error;
  }

  return (await upstream.json()) as any;
}

function getLastUserMessage(messages: any[]): string {
  const last = [...messages].reverse().find((m: any) => m?.role === 'user');
  return String(last?.content ?? '').trim();
}

function userExplicitlyAsksForSearch(text: string): boolean {
  const t = text.toLowerCase();
  return /(search\s+(the\s+)?(web|internet|online|google|bing|duckduckgo)|look\s*(it)?\s*up\s*(online|on the web|on the internet)?|find\s+(online|on the web|on the internet)|go\s+online|browse\s+the\s+(web|internet)|google\s+(it|this|that|for)|search\s+for\s+it|web\s+search|internet\s+search)/.test(
    t,
  );
}

function looksLikeWebQuery(text: string): boolean {
  const t = text.toLowerCase();
  return (
    /(search|web|internet|latest|recent|current|news|today|lookup|find|release|update|version|weather|forecast|temperature|stock|price|score|live|real-time|what is|who is|when is|where is|how much|how many)/.test(
      t,
    ) || t.includes('?')
  );
}

function indicatesNoInternetAccess(text: string): boolean {
  const t = text.toLowerCase();
  return /(cannot|can't|unable|don't)\s+(access|browse|search).*(internet|web)/.test(t);
}

function indicatesNoFind(text: string): boolean {
  const t = text.toLowerCase();
  return /(unable to find|could not find|couldn't find|can't find|no information|not enough information|information provided|i do not know|i don't know|unknown|i'm not sure|i am not sure|i lack|don't have.*information|do not have.*information|my (training|knowledge).*cut[- ]?off|as of my|my training data|i was trained|not aware of|no knowledge of|beyond my|outside my)/.test(
    t,
  );
}

function indicatesPrivacyRefusal(text: string): boolean {
  const t = text.toLowerCase();
  return /(privacy|security|cannot help with|can't help with|unable to help with|identify (a|an|this) person)/.test(
    t,
  );
}

function indicatesNoRealtimeDataAccess(text: string): boolean {
  const t = text.toLowerCase();
  return /(don't have access|do not have access|cannot access|can't access|unable to access).*(real[- ]?time|live|up[- ]to[- ]date|current).*(data|information)/.test(
    t,
  );
}

function indicatesWebDeflection(text: string): boolean {
  const t = text.toLowerCase();
  return /(recommend checking|check (a|an|the)?\s*(website|websites|app|apps)|weather\.com|accuweather|wunderground|official website)/.test(
    t,
  );
}

async function executeToolCall(toolCall: any): Promise<string> {
  const name = toolCall?.function?.name;
  const args = parseToolArgs(toolCall?.function?.arguments);

  if (name !== 'web_search') {
    return JSON.stringify({ error: `Unsupported tool: ${name}` });
  }

  const query = String(args.query ?? '').trim();
  const maxResults = Number(args.max_results ?? WEB_SEARCH_MAX_RESULTS);
  if (!query) {
    return JSON.stringify({ error: 'Missing required argument: query' });
  }

  const results = await searchWeb(query, maxResults);
  return JSON.stringify({ query, results, count: results.length });
}

async function runChatWithTools(body: Record<string, any>, signal: AbortSignal): Promise<any> {
  let messages = Array.isArray(body.messages) ? [...body.messages] : [];
  const originalMessages = Array.isArray(body.messages) ? [...body.messages] : [];
  const lastUserMessage = getLastUserMessage(originalMessages);

  // ── Step 1: Ask AI directly ──────────────────────────────────────────
  let firstData: any | null = null;
  const tools = mergeTools(body.tools);

  for (let round = 0; round < 4; round++) {
    let data: any;
    try {
      data = await requestOllamaChat({ ...body, stream: false, messages, tools }, signal);
    } catch (err) {
      if ((err as any)?.status === 400) {
        log(`[${new Date().toISOString()}] Chat: Ollama 400, retrying without tools`);
        data = await requestOllamaChat({ ...body, stream: false, messages }, signal);
      } else {
        throw err;
      }
    }

    // Handle inline tool calls (e.g. <function=web_search>)
    const inlineTool = extractInlineToolCall(data.message?.content);
    if (inlineTool.toolCall) {
      data.message = {
        ...data.message,
        content: inlineTool.cleanedContent,
        tool_calls: [inlineTool.toolCall],
      };
    }

    const toolCalls = data.message?.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      firstData = data;
      break;
    }

    messages = [...messages, buildAssistantToolMessage(data.message)];
    for (const toolCall of toolCalls) {
      const toolResult = await executeToolCall(toolCall);
      messages.push({ role: 'tool', tool_name: toolCall?.function?.name, content: toolResult });
    }
  }

  if (!firstData) {
    throw new Error('Tool execution exceeded maximum rounds');
  }

  // ── Step 2: Check if AI failed to answer ─────────────────────────────
  if (!isWebSearchEnabled()) return firstData;

  const answer = String(firstData?.message?.content ?? '');
  const aiFailed =
    userExplicitlyAsksForSearch(lastUserMessage) ||
    indicatesNoInternetAccess(answer) ||
    indicatesNoFind(answer) ||
    indicatesNoRealtimeDataAccess(answer) ||
    indicatesWebDeflection(answer) ||
    indicatesPrivacyRefusal(answer);

  if (!aiFailed) return firstData;

  // ── Step 3: Web search ───────────────────────────────────────────────
  log(
    `[${new Date().toISOString()}] AI failed → searching web for "${lastUserMessage.slice(0, 100)}"`,
  );
  const results = await searchWeb(lastUserMessage, WEB_SEARCH_MAX_RESULTS);
  if (results.length === 0) {
    log(`[${new Date().toISOString()}] Web search returned 0 results, returning original answer`);
    return firstData;
  }

  const context = [
    `Web search results for: ${lastUserMessage}`,
    ...results.map(
      (r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet || '(no snippet)'}`,
    ),
  ].join('\n\n');

  // ── Step 4: Re-ask AI with search results ────────────────────────────
  log(`[${new Date().toISOString()}] Re-asking AI with ${results.length} web results`);
  return await requestOllamaChat(
    {
      ...body,
      stream: false,
      messages: [
        ...originalMessages,
        {
          role: 'system',
          content:
            "The user's question requires up-to-date information. Use the following web search results to answer accurately. Cite URLs when helpful.",
        },
        { role: 'system', content: `web_search_context:\n${context}` },
      ],
    },
    signal,
  );
}

router.post('/api/chat', chatLimiter, async (req: Request, res: Response) => {
  const { model, messages, session_id } = req.body ?? {};
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

  // ── Session: resolve & prepend history (safe — never crash) ──────────────
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
          fullMessages = [...session.messages, ...messages];
        }
      }
    }
  } catch {
    // Session load failed — continue without session context
  }

  const body = { ...req.body, messages: fullMessages };
  const wantsStream = body.stream !== false;

  // ── Inject RAG context if index is loaded ────────────────────────────────
  if (isRagEnabled()) {
    const lastUser = [...fullMessages].reverse().find((m: any) => m.role === 'user');
    const ragCtx = buildRagContext(String(lastUser?.content ?? ''));
    if (ragCtx) {
      body.messages = [
        ...fullMessages,
        { role: 'system', content: `Relevant context from local files:\n${ragCtx}` },
      ];
    }
  }

  // ── Check prompt cache ───────────────────────────────────────────────────
  const ck = cacheKey(model, body.messages, body.options);
  if (isCacheEnabled() && !wantsStream) {
    const cached = cacheGet(ck);
    if (cached) {
      log(`[${new Date().toISOString()}] Cache hit for ${model}`);
      res.json(cached);
      return;
    }
  }

  try {
    // ── Wrap in request queue ──────────────────────────────────────────────
    const data = await enqueue(
      () => runChatWithTools(body, controller.signal),
      'normal',
      `chat:${model}`,
    );

    if (data.prompt_eval_count || data.eval_count) {
      addTokenUsage(data.prompt_eval_count ?? 0, data.eval_count ?? 0);
    }

    const lastUserMsg = [...messages].reverse().find((m: any) => m.role === 'user');
    const prompt = lastUserMsg?.content ?? '(no prompt)';
    const responseText = data.message?.content ?? '';

    // Strip <think> blocks when reasoning is disabled
    if (!isReasoningEnabled() && data.message?.content) {
      data.message.content = data.message.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    }

    logResponse(model, prompt, responseText, JSON.stringify(data, null, 2));
    void fireWebhook({ model, prompt, response: responseText });

    // ── Persist to session (safe — never crash) ─────────────────────────
    if (sessionId) {
      try {
        const userMsgs: ChatMessage[] = messages
          .filter((m: any) => m.role === 'user')
          .map((m: any) => ({ role: 'user' as const, content: String(m.content ?? '') }));
        const assistantMsg: ChatMessage = { role: 'assistant', content: responseText };
        appendMessages(sessionId, [...userMsgs, assistantMsg]);

        const session = getSession(sessionId);
        if (session && session.messages.length <= userMsgs.length + 1) {
          autoNameSession(sessionId, prompt);
        }
        data.session_id = sessionId;
      } catch {
        // Session persistence failed — continue normally
      }
    }

    // ── Store in cache ─────────────────────────────────────────────────────
    if (isCacheEnabled() && !wantsStream) {
      cacheSet(ck, data);
    }

    if (wantsStream) {
      res.setHeader('Content-Type', 'application/x-ndjson');
      res.setHeader('Transfer-Encoding', 'chunked');
      res.setHeader('Cache-Control', 'no-cache');
      res.write(JSON.stringify(data) + '\n');
      res.end();
      return;
    }

    res.json(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).name === 'AbortError') return;
    const status = (err as any)?.status;
    const detail = (err as any)?.detail;
    const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log(`[${new Date().toISOString()}] Error in /api/chat: ${msg}${detail ? ` -- ${detail}` : ''}`);
    if (!res.headersSent) {
      res.status(status ?? 502).json({
        error: status ? `Ollama responded with ${status}` : 'Cannot reach Ollama. Is it running?',
        detail: detail ?? msg,
      });
    }
  }
});

export default router;
