# Ollamable

A browser-based chat interface for local LLMs powered by [Ollama](https://ollama.com). Built with Next.js, React, and Material UI.

This project is a **demo for educational purposes** — it exposes the internals of how LLMs actually work under the hood so you can learn by watching.

![Ollamable screenshot](docs/screenshot.png)

## What you can learn

- **Tool/function calling** — see how models request tool invocations, how arguments are structured, and how results flow back into the conversation
- **Reasoning/thinking** — watch the model's chain-of-thought reasoning appear in real time as a separate step, distinct from the final answer
- **Message roles** — understand how system, user, assistant, tool_call, and tool_result steps combine to form the full conversation protocol
- **Streaming** — observe NDJSON streaming from the Ollama API as deltas arrive and assemble into complete responses
- **Request/response inspection** — inspect message history, tool definitions, and model parameters in the labeled OpenAI-compatible JSON preview. This is a protocol view, not the exact Ollama request: Ollama uses fields such as `options.num_predict`, `options.temperature`, and `think`. The separate token/template panel shows Ollama-specific tokenization details.

## Features

- Chat with any model available in your local Ollama instance
- Define custom tools with JSON Schema and toggle them per conversation
- Transcript with authored assistant prose and reasoning; a separate activity section keeps tool calls, results, and execution metadata inspectable
- Real-time streaming with reasoning and tool call visualization
- Request JSON preview panel
- Light and dark mode
- Temperature control
- Conversation history with persistence

The guided tour resumes after refresh and restores the sidebar layout it captured
before starting. Finishing or skipping removes untouched examples; examples with
edited content or added messages remain as regular conversations.

## Prerequisites

- [Node.js](https://nodejs.org/) (v22+)
- [Ollama](https://ollama.com) running locally on the default port (11434)

## Getting Started

```bash
npm install
npm run dev
```

`dev`, `dev:full`, and `dev:auto` all start Next.js on 127.0.0.1:3000 and
its backend on 127.0.0.1:3001, with the frontend WebSocket URL and allowed origin
wired together. `node scripts/run-dev.mjs` is the direct entrypoint. Set
`FRONTEND_PORT` (or `PORT`) and `BACKEND_PORT` to override the ports; they must differ.
Set `OPEN_BROWSER=0` to suppress browser launch. Stop the runner to stop both services.
`dev:frontend` starts only Next.js for frontend-only work.

Ollama defaults to `http://localhost:11434/api`; set `OLLAMA_URL` for another server.
Set `MINIMAX_API_KEY` (and optionally `MINIMAX_BASE_URL`) to enable MiniMax.
Remote development uses the authenticated reverse-proxy setup below; `make dev-remote`
requires its WebSocket URL, allowed origin and token rather than exposing an unauthenticated backend.

For production, build the static export and start the backend that serves it:

```bash
node node_modules/next/dist/bin/next build
node scripts/start.mjs
```

The `start` package script uses the same entrypoint. It requires `out/index.html`
(or `STATIC_DIR/index.html`) and serves assets, model/tool APIs and WebSocket chat
on one port (`PORT`, default 3000). `next start` is not used with the static export.
Keep the installed `tsx` runtime available when starting the TypeScript backend.
Open [http://localhost:3000](http://localhost:3000).

The backend reads `.env`, then `.envrc`, using Node’s dotenv syntax (quoted values,
comments and optional `export` prefixes). Existing process variables, including empty
strings, take precedence; `.env` takes precedence over `.envrc`. `.envrc` is read as
assignments only: shell commands, substitutions, and variable interpolation are not
executed. Node 22 or newer is required for the supported runtime/tooling contract.

## Backend access

The backend binds to `127.0.0.1` by default. HTTP requests and WebSocket upgrades
accept its own loopback origins; `BACKEND_ALLOWED_ORIGINS` adds exact, comma-separated
origins (including ports, without trailing slashes). The combined development runner
sets the frontend origin automatically. Untrusted origins and Host headers are rejected
before model discovery or MCP initialization.

For remote access, set all three server-side variables:

```bash
BACKEND_HOST=0.0.0.0
BACKEND_ALLOWED_ORIGINS=https://chat.example
BACKEND_AUTH_TOKEN=<a-long-random-secret>
```

Every HTTP request and WebSocket handshake then requires
`Authorization: Bearer <secret>`; configuring a token also enables this requirement
on loopback. Native clients can send this header directly. For browser access, use
an HTTPS reverse proxy that authenticates users, injects the server-side header on
both HTTP and WebSocket requests, and forwards the approved Host and Origin.
Keep the backend port private to the proxy. The static frontend contains no backend
secret. For remote development, the proxy can route page/assets to Next.js and
`/models`, `/models/show`, `/tools`, and WebSocket upgrades to the backend; set
`NEXT_PUBLIC_WS_URL` to the proxy's WebSocket URL when starting Next.js.

Without a configured token, loopback access trusts local native processes. Browser
origins remain restricted. Requests without an Origin header still undergo Host
validation and, when configured, token authentication.

The backend limits WebSocket messages to 1 MiB and `/models/show` JSON uploads to
64 KiB with a 10-second upload deadline. Invalid identifiable chat requests receive
a correlated `chat.error`; malformed or uncorrelatable messages receive
`protocol.error` without executing provider work.

Discovery, metadata and shared vocabulary requests have 10-second application
deadlines; web search has a 20-second deadline and honors Stop. Discovery retains
healthy providers and models whose optional capability lookup times out.

MCP tool names must be unique across servers and built-ins. Conflicting definitions
are rejected with an `MCP Tool Rejected` event; the first registered definition keeps
its identity. Saved selections whose tool ID no longer matches fail explicitly and
need to be refreshed, rather than invoking another tool with the same name.

## Browser persistence

Conversation history, settings, selection and tour state are stored in this browser.
If a conversation exceeds storage quota, saving retries once without per-token
boundary metadata. Existing saved conversations are never deleted to make room.
An unresolved storage failure shows a persistent warning; unrelated successful
settings writes do not hide a failed conversation save. Keep the tab open and copy
unsaved content before reloading. If initial storage reads fail, the app does not
overwrite unread saved data with its fallback defaults.

Reloading during generation does not resume or automatically retry the request.
Saved partial assistant/reasoning text is retained and labeled interrupted;
provisional streamed tool calls are discarded.

## Verification

With dependencies already installed, `node scripts/run-checks.mjs` is the release
gate (`check`, `test`, and `make test` use it). It runs unit tests, server integration
tests, frontend/test and backend typechecks, the static production build, then browser
tests. It stops at the first failed stage. Use `test:unit` or `test:integration` for
focused checks; they do not establish a release pass by themselves.

Install the matching Chromium browser with
`node node_modules/@playwright/test/cli.js install chromium` (the download requires
network access and the host must provide Chromium's system libraries). To use an
existing compatible browser, set `PLAYWRIGHT_EXECUTABLE_PATH` to its executable.
`node scripts/run-playwright.mjs` builds and serves the export through the backend
and forwards Playwright filters, for example `tests/e2e/backend.spec.ts` or
`--grep 'tool-only'`. The release gate builds once and uses `--skip-build` internally.

Most browser tests mock HTTP/WebSocket responses for deterministic UI checks.
`tests/e2e/startup.spec.ts` instead launches the actual production/development
entrypoints and uses a local deterministic provider over HTTP. Its production case
executes the real curl tool against a local HTTP target and checks the tool-call
and tool-result wire messages on the next provider request. These tests need local
TCP/WebSocket sockets and child processes; launch/environment failures should be
reported separately from failed application assertions. They do not require a
live model or external tool service. The separate live tokenizer checks remain
gated and report skips when their configured host is unavailable.

## License

[MIT](LICENSE)

<!-- Built with Claude Code - Educational LLM interface explorer -->
