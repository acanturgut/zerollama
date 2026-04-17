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
git clone <repo-url> && cd zerollama
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

| Variable                 | Default                  | Description                                |
| ------------------------ | ------------------------ | ------------------------------------------ |
| `OLLAMA_URL`             | `http://127.0.0.1:11434` | Upstream Ollama address                    |
| `PORT`                   | `3001`                   | Proxy listen port                          |
| `WEB_SEARCH_ENABLED`     | `1`                      | Enable built-in web search tool            |
| `WEB_SEARCH_MAX_RESULTS` | `5`                      | Default max results returned by web search |

## Web search

Tool-capable models can call a built-in `web_search` tool automatically through `/api/chat`. Zerollama executes the search server-side and feeds the results back to the model as a tool response.

You can also call the search endpoint directly:

```bash
curl 'http://localhost:3001/api/web-search?q=latest%20ollama%20release'
```

## Keyboard shortcuts

| Key | Action                          |
| --- | ------------------------------- |
| `s` | Start Ollama                    |
| `x` | Stop Ollama                     |
| `r` | Restart Ollama                  |
| `c` | Open config editor              |
| `d` | Toggle debug chat               |
| `m` | Open model picker               |
| `e` | Show API endpoints              |
| `b` | Run benchmark                   |
| `i` | Toggle built-in web search      |
| `w` | Toggle log line wrap            |
| `t` | Toggle response truncation      |
| `R` | Toggle raw JSON responses       |
| `u` | Update Ollama to latest release |
| `q` | Quit                            |

## License

MIT
