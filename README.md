# Zerollama

<img width="1412" height="1056" alt="Screenshot 2026-04-17 at 03 13 27" src="https://github.com/user-attachments/assets/6dd8101f-bec7-4d89-8502-0cdd640b0819" />

A terminal-based middleware proxy for [Ollama](https://ollama.com) with a real-time dashboard. Run it on your local network to monitor, manage, and interact with Ollama from a rich TUI.

## Features

- **Proxy** – forwards all Ollama API requests (`/api/chat`, `/api/tags`, `/api/pull`, etc.) with rate limiting, CORS, and Helmet security headers
- **Built-in web search** – `/api/chat` injects a `web_search` tool for tool-capable Ollama models, and `/api/web-search` is available for direct calls
- **Terminal dashboard** – blessed-based TUI with live panels for logs, responses, session stats, and system info
- **Model management** – browse installed models, pull new ones, delete, set a default/favorite, search HuggingFace for GGUF models
- **Config editor** – edit Ollama environment variables (context length, KV cache type, flash attention, GPU layers, etc.) with hardware presets for Apple Silicon and NVIDIA GPUs
- **Persistent settings** – Ollama config and the web search toggle are saved to `~/.zerollama/settings.json` and restored on next launch
- **Debug chat** – built-in chat interface to test models directly from the dashboard
- **Benchmarking** – run predefined prompts against the selected model and view a scored results table
- **API docs viewer** – list all proxy endpoints with one-click curl copy
- **Ollama lifecycle** – start, stop, restart, and update Ollama from keyboard shortcuts
- **RAM monitor** – live memory usage in the top banner

## Requirements

- **Node.js** >= 18
- **Ollama** installed and available on `PATH` ([install guide](https://ollama.com/download))
- macOS, Linux, or WSL (blessed requires a proper terminal)

## Installation

```bash
git clone https://github.com/acanturgut/zerollama && cd zerollama
chmod +x scripts/install-requirements.sh
./scripts/install-requirements.sh
yarn install
```

## Usage

```bash
# Development (ts-node)
yarn dev

# Production
yarn build
yarn start
```

The proxy starts on **http://localhost:3001** by default. Point any Ollama-compatible client at this address instead of the default `localhost:11434`.

### Environment variables

| Variable                 | Default                  | Description                                                        |
| ------------------------ | ------------------------ | ------------------------------------------------------------------ |
| `OLLAMA_URL`             | `http://127.0.0.1:11434` | Upstream Ollama address                                            |
| `PORT`                   | `3001`                   | Proxy listen port                                                  |
| `WEB_SEARCH_ENABLED`     | `1`                      | Enable built-in web search tool                                    |
| `WEB_SEARCH_MAX_RESULTS` | `5`                      | Default max results returned by web search                         |
| `ZEROLLAMA_API_KEY`      | _(unset)_                | Require this key via `Authorization: Bearer` or `x-api-key` header |
| `WEBHOOK_URL`            | _(unset)_                | POST response summaries here after each completion                 |
| `OLLAMA_BACKENDS`        | _(unset)_                | Comma-separated list of Ollama URLs for multi-backend routing      |
| `CACHE_TTL_SECONDS`      | `300`                    | Prompt cache TTL (set to `0` to disable)                           |
| `CACHE_MAX_ENTRIES`      | `200`                    | Maximum cached prompt/response pairs                               |
| `QUEUE_MAX_CONCURRENT`   | `2`                      | Max concurrent requests forwarded to Ollama                        |
| `QUEUE_MAX_SIZE`         | `50`                     | Max waiting requests in queue before rejecting                     |
| `RATE_LIMIT_PER_IP`      | `60`                     | Requests per minute per IP (0 = disabled)                          |
| `RATE_LIMIT_PER_KEY`     | `120`                    | Requests per minute per API key (0 = disabled)                     |
| `RAG_CHUNK_SIZE`         | `1000`                   | Max characters per RAG chunk                                       |
| `RAG_TOP_K`              | `4`                      | Number of RAG chunks injected as context                           |

## OpenAI-compatible API

Zerollama exposes a `/v1/chat/completions` endpoint compatible with the OpenAI client spec. Point any OpenAI SDK at `http://localhost:3001` with any non-empty API key:

```bash
curl http://localhost:3001/v1/chat/completions \
  -H 'Authorization: Bearer any-key' \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3","messages":[{"role":"user","content":"Hello"}]}'
```

A model list is also available at `GET /v1/models`.

## API Reference

Full endpoint documentation with request/response examples: **[docs/API-Endpoints.md](docs/API-Endpoints.md)**

## Docker

```bash
docker compose up -d
```

Ollama must be running on the host. On macOS/Windows it is reachable at `host.docker.internal:11434` (the default). On Linux `extra_hosts: host.docker.internal:host-gateway` is wired automatically in `docker-compose.yml`.

## RAG (Retrieval-Augmented Generation)

Index local directories so the model automatically receives relevant file context with every prompt:

```bash
# Index one or more directories
curl -X POST http://localhost:3001/api/rag/index \
  -H 'Content-Type: application/json' \
  -d '{"directories":["/path/to/your/project"]}'

# Check index stats
curl http://localhost:3001/api/rag/stats

# Manual similarity search
curl -X POST http://localhost:3001/api/rag/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"how does auth work","topK":5}'

# Clear index
curl -X DELETE http://localhost:3001/api/rag/index
```

Supported file types: `.md`, `.txt`, `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`, `.c`, `.cpp`, `.swift`, and more. The index persists at `~/.zerollama/rag/`.

## Prompt caching

Identical prompts return cached responses instantly. Controlled via `CACHE_TTL_SECONDS` (default 300s, set to `0` to disable) and `CACHE_MAX_ENTRIES` (default 200). Only non-streaming requests are cached.

## Request queue

Concurrent requests are queued and dispatched up to `QUEUE_MAX_CONCURRENT` (default 2) at a time. Queue depth, active count, and drop stats are shown in the TUI info pane.

## Multi-backend routing

Set `OLLAMA_BACKENDS=http://host1:11434,http://host2:11434` to load-balance across multiple Ollama instances. Zerollama picks the healthiest backend with the fewest active requests. Backend status is shown in the TUI info pane.

## Web search

Tool-capable models can call a built-in `web_search` tool automatically through `/api/chat`. Zerollama executes the search server-side and feeds the results back to the model as a tool response.

You can also call the search endpoint directly:

```bash
curl 'http://localhost:3001/api/web-search?q=latest%20ollama%20release'
```

## Keyboard shortcuts

| Key       | Action                             |
| --------- | ---------------------------------- | --- | --------- | ---------------------------- |
| `s`       | Start Ollama                       |
| `x`       | Stop Ollama                        |
| `r`       | Restart Ollama                     |
| `c`       | Open config editor                 |
| `d`       | Toggle debug chat                  |
| `m`       | Open model picker                  |
| `e`       | Show API endpoints                 |
| `b`       | Run benchmark                      |
| `i`       | Toggle built-in web search         |
| `H`       | History viewer (navigate with ↑/↓) |     | `[` / `]` | Shrink / grow left info pane |
| `{` / `}` | Shrink / grow middle logs pane     |     | `w`       | Toggle log line wrap         |
| `t`       | Toggle response truncation         |
| `R`       | Toggle raw JSON responses          |
| `u`       | Update Ollama to latest release    |
| `q`       | Quit                               |

## License

MIT
