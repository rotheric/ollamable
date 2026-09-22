/**
 * tests/integration/ws-handler-tokenize.test.ts — AC-ERR-2 conformance
 * for the `tokenize` WS request/response pair (epic-token-view story S3).
 *
 * A separate file from tests/integration/ws-handler.test.ts (which mocks
 * server/ollama-client.js's streaming client at module load — unrelated
 * to and unnecessary for these tests) so this suite can freely mock
 * global `fetch` for server/tokenizer.ts's `/show` calls instead.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { ConnectionHandler } from "../../server/ws-handler.js";
import { LlmRouter } from "../../server/llm-router.js";
import type { ProviderConfig } from "../../server/provider-config.js";
import { __resetVocabCacheForTests } from "../../server/tokenizer.js";

const VOCAB_JSON = gunzipSync(readFileSync("tests/fixtures/qwen3-1.7b-vocab.json.gz")).toString("utf-8");
const GOLDENS = JSON.parse(readFileSync("tests/fixtures/qwen3-1.7b-goldens.json", "utf-8")) as Record<string, number[]>;

let httpServer: Server;
let wss: WebSocketServer;
let wsPort: number;
let router: LlmRouter;

function setRouterConfigs(configs: ProviderConfig[]) {
  router = new LlmRouter(configs);
}

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    new ConnectionHandler(ws, router);
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  wsPort = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  __resetVocabCacheForTests();
  vi.restoreAllMocks();
  setRouterConfigs([{ id: "ollama", type: "ollama", name: "Ollama", baseUrl: "http://fake-ollama/api" }]);
});

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

interface ParsedMessage {
  type?: string;
  requestId?: string;
  tokens?: string[];
  tokenIds?: number[];
  reason?: string;
  [key: string]: unknown;
}

function waitForMessage(ws: WebSocket, predicate: (msg: ParsedMessage) => boolean, timeoutMs = 5_000): Promise<ParsedMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("waitForMessage timeout")), timeoutMs);
    function onMessage(raw: Buffer | ArrayBuffer | Buffer[]) {
      const msg = JSON.parse(raw.toString()) as ParsedMessage;
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msg);
      }
    }
    ws.on("message", onMessage);
  });
}

describe("ConnectionHandler tokenize routing (AC-ERR-2)", () => {
  it("returns tokenize.result for an ollama-type provider", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(VOCAB_JSON, { status: 200 }));
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.type?.startsWith("tokenize") === true);
      ws.send(JSON.stringify({ type: "tokenize", requestId: "req-1", model: "qwen3:1.7b", text: "Hello world" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.result");
      expect(response.requestId).toBe("req-1");
      expect(response.tokenIds).toEqual(GOLDENS["Hello world"]);
    } finally {
      ws.close();
    }
  });

  it("routes on ProviderConfig.type, not provider name — a provider named 'Ollama Clone' with type openai-compat is rejected", async () => {
    setRouterConfigs([
      { id: "clone", type: "openai-compat", name: "Ollama Clone", baseUrl: "http://fake-openai/v1" },
    ]);
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.type?.startsWith("tokenize") === true);
      ws.send(JSON.stringify({ type: "tokenize", requestId: "req-2", model: "some-model", text: "hi" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("unsupported_provider");
    } finally {
      ws.close();
    }
  });

  it("returns tokenize.result for a provider literally named 'ollama' only when its type is also ollama (not fooled by name alone)", async () => {
    setRouterConfigs([{ id: "ollama", type: "ollama", name: "Anything", baseUrl: "http://fake-ollama/api" }]);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(VOCAB_JSON, { status: 200 }));
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.type?.startsWith("tokenize") === true);
      ws.send(JSON.stringify({ type: "tokenize", requestId: "req-3", model: "qwen3:1.7b", text: "strawberry" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.result");
      expect(response.tokenIds).toEqual(GOLDENS["strawberry"]);
    } finally {
      ws.close();
    }
  });

  it("returns tokenize.error{reason: vocab_unavailable} for an unsupported tokenizer.ggml.pre — never a result from a different vocabulary", async () => {
    const bad = JSON.parse(VOCAB_JSON);
    bad.model_info["tokenizer.ggml.pre"] = "llama3";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(bad), { status: 200 }));
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.type?.startsWith("tokenize") === true);
      ws.send(JSON.stringify({ type: "tokenize", requestId: "req-4", model: "weird-model", text: "hi" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("vocab_unavailable");
      expect(response.tokens).toBeUndefined();
      expect(response.tokenIds).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it("returns tokenize.error{reason: internal} for an unexpected error, never crashing the connection", async () => {
    // VocabUnavailableError wraps fetch failures, so force a different
    // unexpected error by making /show return ok but non-JSON.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not json", { status: 200 }));
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.type?.startsWith("tokenize") === true);
      ws.send(JSON.stringify({ type: "tokenize", requestId: "req-5", model: "qwen3:1.7b", text: "hi" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("internal");

      // Connection must still be alive afterward.
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      ws.send(JSON.stringify({ type: "ping" }));
      await pongPromise;
    } finally {
      ws.close();
    }
  });

  it("correlates concurrent tokenize requests by requestId, not arrival order", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(VOCAB_JSON, { status: 200 }));
    const ws = await connectClient();
    try {
      const p1 = waitForMessage(ws, (m) => m.requestId === "a");
      const p2 = waitForMessage(ws, (m) => m.requestId === "b");
      ws.send(JSON.stringify({ type: "tokenize", requestId: "a", model: "qwen3:1.7b", text: "Hello world" }));
      ws.send(JSON.stringify({ type: "tokenize", requestId: "b", model: "qwen3:1.7b", text: "strawberry" }));
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.tokenIds).toEqual(GOLDENS["Hello world"]);
      expect(r2.tokenIds).toEqual(GOLDENS["strawberry"]);
    } finally {
      ws.close();
    }
  });

  // ── S3-F1: malformed input must never crash the connection (or process) ──

  it("replies tokenize.error{reason: internal} for a malformed message missing `text`, and never crashes the connection", async () => {
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.requestId === "malformed-1");
      // No `text` field at all — the pre-fix code read `.length` off this
      // directly, throwing a TypeError ahead of any try/catch and, absent
      // the ws.on("message") dispatch's own .catch, crashing the process
      // via an unhandled promise rejection.
      ws.send(JSON.stringify({ type: "tokenize", requestId: "malformed-1", model: "qwen3:1.7b" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("internal");

      // The connection (and the whole process) must still be alive.
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      ws.send(JSON.stringify({ type: "ping" }));
      await pongPromise;
    } finally {
      ws.close();
    }
  });

  it("replies tokenize.error{reason: too_large} for text over MAX_TOKENIZE_TEXT_LENGTH, and never crashes the connection (S3-D1)", async () => {
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.requestId === "too-large-1");
      ws.send(
        JSON.stringify({
          type: "tokenize",
          requestId: "too-large-1",
          model: "qwen3:1.7b",
          text: "a".repeat(200_001),
        })
      );
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("too_large");

      // The connection must still be alive afterward.
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      ws.send(JSON.stringify({ type: "ping" }));
      await pongPromise;
    } finally {
      ws.close();
    }
  });

  it("replies tokenize.error{reason: internal} instead of crashing when zero providers are configured", async () => {
    setRouterConfigs([]);
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.requestId === "no-providers");
      ws.send(JSON.stringify({ type: "tokenize", requestId: "no-providers", model: "qwen3:1.7b", text: "hi" }));
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.error");
      expect(response.reason).toBe("internal");
    } finally {
      ws.close();
    }
  });

  // ── S3-F4: explicit provider must win over the model-name-only map ──────

  it("routes by the explicit provider field, not the first configured provider, when two providers are configured", async () => {
    setRouterConfigs([
      { id: "primary", type: "ollama", name: "Primary", baseUrl: "http://primary-ollama/api" },
      { id: "secondary", type: "ollama", name: "Secondary", baseUrl: "http://secondary-ollama/api" },
    ]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(VOCAB_JSON, { status: 200 }));
    const ws = await connectClient();
    try {
      const responsePromise = waitForMessage(ws, (m) => m.requestId === "req-provider");
      // Explicit provider "secondary" — before S3-F4's fix this field
      // didn't exist on the wire at all, and resolution always fell
      // through to the first configured provider ("primary").
      ws.send(
        JSON.stringify({
          type: "tokenize",
          requestId: "req-provider",
          model: "shared-model",
          provider: "secondary",
          text: "hi",
        })
      );
      const response = await responsePromise;
      expect(response.type).toBe("tokenize.result");
      expect(fetchSpy).toHaveBeenCalledWith(
        "http://secondary-ollama/api/show",
        expect.objectContaining({ method: "POST" })
      );
    } finally {
      ws.close();
    }
  });
});
