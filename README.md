# Ollamable

A browser-based chat interface for local LLMs powered by [Ollama](https://ollama.com). Built with Next.js, React, and Material UI.

This project is a **demo for educational purposes** — it exposes the internals of how LLMs actually work under the hood so you can learn by watching.

![Ollamable screenshot](docs/screenshot.png)

## What you can learn

- **Tool/function calling** — see how models request tool invocations, how arguments are structured, and how results flow back into the conversation
- **Reasoning/thinking** — watch the model's chain-of-thought reasoning appear in real time as a separate step, distinct from the final answer
- **Message roles** — understand how system, user, assistant, tool_call, and tool_result steps combine to form the full conversation protocol
- **Streaming** — observe NDJSON streaming from the Ollama API as deltas arrive and assemble into complete responses
- **Request/response inspection** — preview the exact JSON payload sent to Ollama before each request, including message history, tool definitions, and model parameters

## Features

- Chat with any model available in your local Ollama instance
- Define custom tools with JSON Schema and toggle them per conversation
- Step-level transcript showing every role in the conversation
- Real-time streaming with reasoning and tool call visualization
- Request JSON preview panel
- Light and dark mode
- Temperature control
- Conversation history with persistence

## Prerequisites

- [Node.js](https://nodejs.org/) (v22+)
- [Ollama](https://ollama.com) running locally on the default port (11434)

## Getting Started

```bash
npm install
npm run dev
```

Then open [http://localhost:3000](http://localhost:3000).

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

## License

[MIT](LICENSE)

<!-- Built with Claude Code - Educational LLM interface explorer -->
