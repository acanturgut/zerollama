# API Endpoints

Zerollama middleware exposes a REST API on port **3001** (configurable via `PORT` env var).

## Configuration

| Variable | Env Var | Default |
|---|---|---|
| Port | `PORT` | `3001` |
| Ollama URL | `OLLAMA_URL` | `http://127.0.0.1:11434` |
| API Key | `ZEROLLAMA_API_KEY` | `""` (disabled) |
| Web Search | `WEB_SEARCH_ENABLED` | `1` |
| Max Search Results | `WEB_SEARCH_MAX_RESULTS` | `5` |
| Reasoning | `REASONING_ENABLED` | `1` |
| Rate Limit Window | `RATE_LIMIT_WINDOW_MS` | `60000` |
| Rate Limit per IP | `RATE_LIMIT_PER_IP` | `60` |
| Rate Limit per Key | `RATE_LIMIT_PER_KEY` | `120` |

## Authentication

When `ZEROLLAMA_API_KEY` is set, **all endpoints except `/health`** require:

```
Authorization: Bearer <key>
```
or
```
x-api-key: <key>
```

---

## Health

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Health check (unauthenticated) |

```bash
curl http://localhost:3001/health
```

```json
{ "status": "ok", "ollama": "http://127.0.0.1:11434", "ollamaReachable": true, "webSearchEnabled": true }
```

---

## Models

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/models` | List available models |
| `GET` | `/api/tags` | Alias for `/api/models` |
| `POST` | `/api/pull` | Pull a model from registry |
| `DELETE` | `/api/models/:name` | Delete a model |

### Pull a model

```bash
curl -X POST http://localhost:3001/api/pull \
  -H "Content-Type: application/json" \
  -d '{"name": "llama3.2"}'
```

Response: NDJSON stream of pull progress.

### Delete a model

```bash
curl -X DELETE http://localhost:3001/api/models/llama3.2
```

```json
{ "status": "deleted", "model": "llama3.2" }
```

---

## Chat (Ollama-native)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/chat` | Chat completion (rate limited: 30 req/min) |

### Request

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model name |
| `messages` | array | ✅ | `[{ role, content }]` |
| `stream` | boolean | | Stream response (default `true`) |
| `session_id` | string \| false | | Session ID. Omit to auto-create, `false` to skip sessions |
| `tools` | array | | Tool definitions |
| `options` | object | | Ollama options (`temperature`, `num_ctx`, etc.) |

### Example

```bash
curl -X POST http://localhost:3001/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'
```

**Features:** automatic web search fallback, tool calling, RAG context injection, prompt caching, session history.

---

## OpenAI-Compatible

Drop-in replacement for the OpenAI API. Use with any OpenAI SDK by pointing `base_url` to Zerollama.

| Method | Path | Description |
|---|---|---|
| `POST` | `/v1/chat/completions` | Chat completions |
| `GET` | `/v1/models` | List models |

### Chat Completions

| Field | Type | Required | Description |
|---|---|---|---|
| `model` | string | ✅ | Model name |
| `messages` | array | ✅ | OpenAI-format messages |
| `stream` | boolean | | SSE streaming |
| `temperature` | number | | Sampling temperature |
| `max_tokens` | number | | Max completion tokens |
| `top_p` | number | | Top-p sampling |
| `stop` | string/array | | Stop sequences |
| `tools` | array | | Tool definitions |
| `session_id` | string \| false | | Session ID |

### Example (curl)

```bash
curl -X POST http://localhost:3001/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.2",
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": false
  }'
```

### Example (Python)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3001/v1", api_key="unused")
resp = client.chat.completions.create(
    model="llama3.2",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)
```

### Response (non-streaming)

```json
{
  "id": "chatcmpl-xxx",
  "object": "chat.completion",
  "choices": [{
    "message": { "role": "assistant", "content": "...", "reasoning_content": "..." },
    "finish_reason": "stop"
  }],
  "usage": { "prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30 },
  "session_id": "uuid"
}
```

### Response (streaming)

SSE stream of `data: { id, object: "chat.completion.chunk", choices: [{ delta, finish_reason }] }` terminated by `data: [DONE]`.

### Models List

```bash
curl http://localhost:3001/v1/models
```

```json
{ "object": "list", "data": [{ "id": "llama3.2", "object": "model", "created": 1700000000, "owned_by": "ollama" }] }
```

---

## Ollama Control

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/ollama/status` | Check if Ollama is reachable |
| `POST` | `/api/ollama/start` | Start Ollama process |
| `POST` | `/api/ollama/stop` | Stop Ollama process |
| `POST` | `/api/ollama/restart` | Restart Ollama process |

### Example

```bash
curl http://localhost:3001/api/ollama/status
# { "status": "reachable" }

curl -X POST http://localhost:3001/api/ollama/start
# { "status": "started" }
```

**Status values:** `reachable`, `unreachable`, `started`, `failed`, `stopped`, `still_running`, `restarted`, `already_running`

---

## Web Search

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/web-search?q=query` | Search the web |
| `POST` | `/api/web-search` | Search the web |

### Example

```bash
curl "http://localhost:3001/api/web-search?q=rust+programming&max_results=3"
```

```json
{ "query": "rust programming", "results": [{ "title": "...", "url": "...", "snippet": "..." }], "count": 3 }
```

Returns `503` if web search is disabled.

---

## RAG (Retrieval-Augmented Generation)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/rag/index` | Index directories |
| `GET` | `/api/rag/stats` | Index statistics |
| `POST` | `/api/rag/query` | Query the index |
| `DELETE` | `/api/rag/index` | Clear the index |

### Index directories

```bash
curl -X POST http://localhost:3001/api/rag/index \
  -H "Content-Type: application/json" \
  -d '{"directories": ["/path/to/code"]}'
```

### Query

```bash
curl -X POST http://localhost:3001/api/rag/query \
  -H "Content-Type: application/json" \
  -d '{"query": "authentication logic", "topK": 5}'
```

---

## Sessions

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/sessions` | List all sessions |
| `POST` | `/api/sessions` | Create a new session |
| `GET` | `/api/sessions/active` | Get active session |
| `PUT` | `/api/sessions/active` | Set active session |
| `GET` | `/api/sessions/:id` | Get a session |
| `PATCH` | `/api/sessions/:id` | Rename a session |
| `DELETE` | `/api/sessions/:id` | Delete a session |
| `DELETE` | `/api/sessions/:id/messages` | Clear session messages |

### List sessions

```bash
curl http://localhost:3001/api/sessions
```

```json
{ "sessions": [{ "id": "uuid", "name": "...", "createdAt": "...", "updatedAt": "...", "messageCount": 5 }], "activeSessionId": "uuid" }
```

### Create session

```bash
curl -X POST http://localhost:3001/api/sessions \
  -H "Content-Type: application/json" \
  -d '{"name": "My Chat"}'
```

### Set active session

```bash
curl -X PUT http://localhost:3001/api/sessions/active \
  -H "Content-Type: application/json" \
  -d '{"id": "session-uuid"}'
```

### Rename session

```bash
curl -X PATCH http://localhost:3001/api/sessions/SESSION_ID \
  -H "Content-Type: application/json" \
  -d '{"name": "New Name"}'
```

---

## Events & Monitoring

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/events` | SSE real-time log stream |
| `GET` | `/api/status` | Full server status snapshot |
| `GET` | `/api/logs` | Log buffer dump |

### Server status

```bash
curl http://localhost:3001/api/status
```

```json
{
  "server": { "port": 3001, "ollamaUrl": "...", "hostname": "...", "cpus": 10, "loadAvg": 1.5, "uptime": 3600 },
  "ollama": { "reachable": true },
  "features": { "webSearch": true, "reasoning": true },
  "tokens": { "prompt": 1000, "completion": 2000, "total": 3000, "requests": 50 },
  "cache": { "size": 10, "maxSize": 100, "hits": 5, "ttlSeconds": 300 },
  "queue": { "active": 1, "queued": 0, "maxConcurrent": 4, "totalCompleted": 100, "totalDropped": 0 }
}
```

### SSE event stream

```bash
curl -N http://localhost:3001/api/events
```

Receives real-time events:
- `{"type":"log","msg":"..."}` — log line
- `{"type":"response","model":"...","prompt":"...","response":"..."}` — chat response
- `{"type":"tokens","promptTokens":10,"completionTokens":20}` — token usage
- `{"type":"request"}` — new request
- `{"type":"error"}` — request error

### Log buffer

```bash
curl http://localhost:3001/api/logs
```

```json
{ "logs": ["[2026-04-17T10:00:00] Server started", "..."] }
```
