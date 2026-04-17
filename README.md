# Zerollama

<img width="1412" height="1056" alt="Screenshot 2026-04-17 at 03 13 27" src="https://github.com/user-attachments/assets/6dd8101f-bec7-4d89-8502-0cdd640b0819" />

A middleware proxy for [Ollama](https://ollama.com) that sits between your apps and the Ollama server. It adds rate limiting, caching, request queuing, web search, RAG, session management, and an OpenAI-compatible API — all accessible over your local network. It also ships with an optional terminal UI (`zlm`) that can attach to the running server from any terminal window.

## Architecture

```
┌──────────────┐      ┌──────────────────────┐      ┌────────────┐
│  Your Apps   │─────▶│  Zerollama (middleware) │─────▶│   Ollama   │
│  curl, SDKs  │ HTTP │  :3001                 │ HTTP │  :11434    │
└──────────────┘      └──────────────────────┘      └────────────┘
                              ▲
                              │ attach (SSE + REST)
                       ┌──────┴───────┐
                       │   zlm (TUI)  │
                       │  any terminal │
                       └──────────────┘
```

**Middleware** (`yarn start`) — headless Express server on port 3001. Always runs. Handles all API traffic, caching, queuing, rate limiting, web search, RAG, sessions.

**Terminal UI** (`zlm`) — optional blessed-based TUI that attaches to the running server. Open and close it from any terminal, any time, without affecting the middleware.

## Middleware Features

- **Proxy** – forwards Ollama API requests with CORS, Helmet security headers, and rate limiting
- **OpenAI-compatible** – `/v1/chat/completions` and `/v1/models` work with any OpenAI SDK
- **Web search** – automatic `web_search` tool injection for tool-capable models + direct `/api/web-search` endpoint
- **RAG** – index local directories, auto-inject relevant file context into prompts
- **Prompt caching** – identical prompts return cached responses instantly (configurable TTL)
- **Request queue** – concurrent request dispatching with configurable concurrency
- **Session management** – persistent chat sessions with history, auto-naming, REST API
- **Multi-backend** – load-balance across multiple Ollama instances
- **Ollama lifecycle** – start/stop/restart Ollama via REST API
- **SSE events** – real-time log streaming via `/api/events` for monitoring
- **Auth** – optional API key authentication via `Authorization: Bearer` or `x-api-key`
- **Webhooks** – POST response summaries to external URLs

## Terminal UI Features

- **Live dashboard** – panels for logs, responses, session stats, system info, running models
- **Model management** – browse, pull, delete models; search HuggingFace for GGUF models
- **Debug chat** – built-in chat with session support (`:q` quit, `:s` sessions, `:n` new session)
- **Config editor** – edit Ollama env vars with hardware presets (Apple Silicon, NVIDIA)
- **Benchmarking** – run predefined prompts and view scored results
- **Ollama control** – start/stop/restart/update with confirmation dialogs showing running models

## Requirements

- **Node.js** >= 18
- **Ollama** installed and available on `PATH` ([install guide](https://ollama.com/download))
- macOS, Linux, or WSL (TUI requires a proper terminal)

## Installation

```bash
git clone https://github.com/acanturgut/zerollama && cd zerollama
chmod +x scripts/install-requirements.sh
./scripts/install-requirements.sh
yarn install
yarn build
npm link   # registers the `zlm` command globally
```

## Usage

```bash
# Start the middleware server (headless)
yarn start

# Attach the terminal UI from any terminal window
zlm
```

`yarn start` runs the middleware only — no TUI, just the API server. Open as many `zlm` sessions as you want; closing them doesn't affect the server.

```bash
# Other modes
yarn start --ui         # Start server with embedded TUI (all-in-one)
yarn dev                # Development mode (ts-node)
```

The middleware listens on **http://localhost:3001** by default. Point any Ollama-compatible client at this address.

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

## API Reference

Full endpoint documentation with request/response examples: **[docs/API-Endpoints.md](docs/API-Endpoints.md)**

### Quick examples

```bash
# Chat (Ollama-native format)
curl -X POST http://localhost:3001/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Hello"}],"stream":false}'

# Chat (OpenAI-compatible)
curl http://localhost:3001/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"llama3.2","messages":[{"role":"user","content":"Hello"}]}'

# Web search
curl 'http://localhost:3001/api/web-search?q=latest+ollama+release'

# Server status
curl http://localhost:3001/api/status

# Ollama control
curl -X POST http://localhost:3001/api/ollama/start
```

## Docker

```bash
docker compose up -d
```

Ollama must be running on the host. On macOS/Windows it is reachable at `host.docker.internal:11434` (the default). On Linux `extra_hosts: host.docker.internal:host-gateway` is wired automatically in `docker-compose.yml`.

## Terminal UI Keyboard Shortcuts

These shortcuts are available in the `zlm` TUI (or `yarn start --ui`):

| Key       | Action                          |
| --------- | ------------------------------- |
| `s`       | Start Ollama                    |
| `x`       | Stop Ollama                     |
| `r`       | Restart Ollama                  |
| `l`       | View running/loaded models      |
| `m`       | Open model picker               |
| `d`       | Toggle debug chat               |
| `c`       | Open config editor              |
| `p`       | Preset picker                   |
| `e`       | Show API endpoints              |
| `b`       | Run benchmark                   |
| `i`       | Toggle web search               |
| `n`       | Toggle reasoning                |
| `S`       | Session picker                  |
| `N`       | New chat session                |
| `H`       | History viewer                  |
| `w`       | Toggle log wrap                 |
| `t`       | Toggle response truncation      |
| `R`       | Toggle raw JSON responses       |
| `u`       | Update Ollama                   |
| `h`       | Help                            |
| `[` / `]` | Resize left info pane           |
| `{` / `}` | Resize middle logs pane         |
| `q`       | Quit TUI (server keeps running) |

### Debug chat commands

| Command | Action              |
| ------- | ------------------- |
| `:q`    | Quit debug chat     |
| `:s`    | Open session picker |
| `:n`    | New chat session    |

## License

MIT
