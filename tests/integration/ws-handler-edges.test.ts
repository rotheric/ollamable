/**
 * Edge-case tests for `ws-handler`, closing specific mutation-gate residuals
 * in the tool loop, budget arithmetic, tokenize cap, and protocol-error
 * validation. The main `ws-handler.test.ts` and the AC-STRUCT-4/5 property
 * suite drive the happy paths; this file pins the boundary values
 * (`N == maxToolCalls`, `text.length == MAX_TOKENIZE_TEXT_LENGTH`,
 * `BACKEND_MAX_MODEL_INVOCATIONS == "1"`), the compact-context sole-call
 * remaining-work shape, and a few invariants a mutator could silently
 * swap without changing the exposed message count.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn(),
  buildOllamaChatBody: vi.fn(),
}));

import { ConnectionHandler, loadExecutionLimits } from "../../server/ws-handler.js";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { CompactContextExecutor } from "../../server/tools/compact-context.js";
import type { ConversationStep } from "../../server/types.js";

const mockStream = vi.mocked(streamOllamaResponse);

let httpServer: Server;
let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    new ConnectionHandler(ws, undefined, loadExecutionLimits({}));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  port = (httpServer.address() as { port: number }).port;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  mockStream.mockReset();
});

async function connect(): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

function waitFor<T = Record<string, unknown>>(ws: WebSocket, match: (m: T) => boolean): Promise<T> {
  return new Promise((resolve) => {
    const handler = (buf: Buffer) => {
      const m = JSON.parse(buf.toString()) as T;
      if (match(m)) { ws.off("message", handler); resolve(m); }
    };
    ws.on("message", handler);
  });
}

const USER_STEP: ConversationStep = {
  id: "u1", kind: "user", title: "User", content: "hi", createdAt: "2026-01-01T00:00:00.000Z",
};
const compactTool = new CompactContextExecutor().getToolDefinitions()[0];

describe("loadExecutionLimits boundary", () => {
  it("accepts '1' as a positive integer and returns 1", () => {
    // The original `Number(value) < 1` boundary; the mutant `<=` would throw on "1".
    expect(loadExecutionLimits({ BACKEND_MAX_MODEL_INVOCATIONS: "1" })).toEqual({ maxModelInvocations: 1, maxToolCalls: 256 });
    expect(loadExecutionLimits({ BACKEND_MAX_TOOL_CALLS: "1" })).toEqual({ maxModelInvocations: 64, maxToolCalls: 1 });
  });
});

describe("handleTokenize MAX_TOKENIZE_TEXT_LENGTH boundary", () => {
  it("accepts text at exactly 200,000 chars and rejects at 200,001", async () => {
    const ws = await connect();
    try {
      // At the limit: original `>` is false → routes to the tokenizer (which will fail for
      // the unknown model with its own reason — not `too_large`).
      const atLimit = waitFor(ws, (m) => (m as { type: string }).type === "tokenize.error");
      send(ws, { type: "tokenize", requestId: "r1", model: "no-such-model", text: "x".repeat(200_000) });
      const atLimitMsg = (await atLimit) as { reason: string };
      expect(atLimitMsg.reason).not.toBe("too_large");

      const over = waitFor(ws, (m) => (m as { type: string; requestId?: string }).type === "tokenize.error" && (m as { requestId?: string }).requestId === "r2");
      send(ws, { type: "tokenize", requestId: "r2", model: "no-such-model", text: "x".repeat(200_001) });
      const overMsg = (await over) as { reason: string };
      expect(overMsg.reason).toBe("too_large");
    } finally { ws.close(); }
  });

  it("rejects a tokenize whose text is missing with reason internal", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "tokenize.error");
      send(ws, { type: "tokenize", requestId: "r3", model: "m" }); // no text
      expect((await err as { reason: string }).reason).toBe("internal");
    } finally { ws.close(); }
  });

  it("rejects a tokenize whose model is missing with reason internal", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "tokenize.error");
      send(ws, { type: "tokenize", requestId: "r4", text: "hi" }); // no model
      expect((await err as { reason: string }).reason).toBe("internal");
    } finally { ws.close(); }
  });
});

describe("handleMessage protocol-error paths", () => {
  it("rejects a message object with a missing type", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "protocol.error");
      send(ws, { foo: 1 }); // no type
      expect((await err as { message: string }).message.toLowerCase()).toContain("type");
    } finally { ws.close(); }
  });

  it("rejects an unknown message type with a Unknown-message protocol error", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "protocol.error");
      send(ws, { type: "chat.weird" });
      expect((await err as { message: string }).message.toLowerCase()).toContain("unknown");
    } finally { ws.close(); }
  });

  it("rejects a chat.stop with a non-string conversationId", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "protocol.error");
      send(ws, { type: "chat.stop", conversationId: 42 });
      expect((await err as { message: string }).message.toLowerCase()).toContain("invalid stop");
    } finally { ws.close(); }
  });

  it("rejects a chat.stop with a non-string requestId when present", async () => {
    const ws = await connect();
    try {
      const err = waitFor(ws, (m) => (m as { type: string }).type === "protocol.error");
      send(ws, { type: "chat.stop", conversationId: "c", requestId: 7 });
      expect((await err as { message: string }).message.toLowerCase()).toContain("invalid stop");
    } finally { ws.close(); }
  });
});

describe("compact_context sole-call: remainingWork presence shape", () => {
  it("omits remainingWork from chat.done.compaction when the model did not provide one", async () => {
    mockStream.mockResolvedValue([
      {
        id: "tc", kind: "tool_call", title: "Call", content: "", createdAt: "2026-01-01T00:00:00Z",
        toolCall: { name: "compact_context", id: "x", arguments: { summary: "sum-only" } },
      },
    ]);
    const ws = await connect();
    try {
      const done = waitFor(ws, (m) => (m as { type: string }).type === "chat.done");
      send(ws, {
        type: "chat.send", conversationId: "c", requestId: "r", model: "m",
        steps: [USER_STEP], tools: [compactTool],
      });
      const msg = await done as { compaction?: { summary: string; remainingWork?: string } };
      expect(msg.compaction).toBeDefined();
      expect(msg.compaction!.summary).toBe("sum-only");
      // Absence, not an empty-string placeholder — `?? ...{} ` spread, not `remainingWork: ""`.
      expect("remainingWork" in msg.compaction!).toBe(false);
    } finally { ws.close(); }
  });

  it("carries remainingWork through to chat.done.compaction when the model provides one", async () => {
    mockStream.mockResolvedValue([
      {
        id: "tc", kind: "tool_call", title: "Call", content: "", createdAt: "2026-01-01T00:00:00Z",
        toolCall: { name: "compact_context", id: "x", arguments: { summary: "S", remaining_work: "RW" } },
      },
    ]);
    const ws = await connect();
    try {
      const done = waitFor(ws, (m) => (m as { type: string }).type === "chat.done");
      send(ws, {
        type: "chat.send", conversationId: "c", requestId: "r", model: "m",
        steps: [USER_STEP], tools: [compactTool],
      });
      const msg = await done as { compaction?: { summary: string; remainingWork?: string } };
      expect(msg.compaction).toEqual({ toolCallStepId: "tc", summary: "S", remainingWork: "RW" });
    } finally { ws.close(); }
  });
});
