/**
 * A fork's first request over the wire (compaction-tool S6, AC-FORK-9/11): a `chat.send` whose
 * steps contain a `compaction` step and whose tools do not include `compact_context` reaches
 * the provider (Ollama and OpenAI-compatible, both clients mocked) with the summary text.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn(),
  buildOllamaChatBody: vi.fn(),
  fetchOllamaModelMeta: vi.fn(),
  fetchOllamaRuntime: vi.fn(),
}));
vi.mock("../../server/openai-client.js", () => ({ streamOpenAIResponse: vi.fn(), fetchOpenAIModels: vi.fn().mockResolvedValue([]) }));

import { ConnectionHandler, loadExecutionLimits } from "../../server/ws-handler.js";
import { LlmRouter } from "../../server/llm-router.js";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { streamOpenAIResponse } from "../../server/openai-client.js";
import type { ConversationStep } from "../../server/types.js";
import { toOllamaMessages } from "../../shared/ollama-format.js";
import { toOpenAIMessages } from "../../shared/openai-format.js";
import { CONTEXT_PLACEMENT } from "../../shared/context-usage.js";

const mockOllama = vi.mocked(streamOllamaResponse);
const mockOpenAI = vi.mocked(streamOpenAIResponse);

const providers = [
  { id: "ollama", type: "ollama" as const, name: "Ollama", baseUrl: "http://ollama.test/api" },
  { id: "compat", type: "openai-compat" as const, name: "Compat", baseUrl: "http://compat.test/v1" },
];

let httpServer: Server;
let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    new ConnectionHandler(ws, new LlmRouter(providers), loadExecutionLimits({}));
  });
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const address = httpServer.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  mockOllama.mockReset();
  mockOpenAI.mockReset();
});

interface Msg {
  type?: string;
  [key: string]: unknown;
}

function step(kind: ConversationStep["kind"], content: string): ConversationStep {
  return { id: `${kind}-${content}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z" };
}

const answer = step("assistant", "continuing");
const forkSteps = () => [step("system", "be terse"), step("compaction", "THE SUMMARY\n\nRemaining work:\nTHE REMAINING WORK")];

/** Sends one chat.send and resolves with the first terminal message. */
async function send(request: Record<string, unknown>): Promise<Msg> {
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
  try {
    return await new Promise<Msg>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        if (msg.type === "chat.done" || msg.type === "chat.error") {
          clearTimeout(timer);
          resolve(msg);
        }
      });
      ws.send(JSON.stringify({ type: "chat.send", conversationId: "fork-1", tools: [], ...request }));
    });
  } finally {
    ws.close();
  }
}

const text = (messages: Array<{ content?: unknown }>) => messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");

describe("a chat.send with a compaction step and without compact_context", () => {
  it("AC-FORK-9: is accepted by validation rather than rejected as an invalid step", async () => {
    mockOllama.mockResolvedValue([answer]);
    const done = await send({ model: "m", provider: "ollama", steps: forkSteps() });
    expect(done.type).toBe("chat.done");
  });

  it("AC-FORK-11: reaches the Ollama provider with the summary and remaining work as one user turn", async () => {
    mockOllama.mockResolvedValue([answer]);
    await send({ model: "m", provider: "ollama", steps: forkSteps() });
    expect(mockOllama).toHaveBeenCalledTimes(1);
    const messages = toOllamaMessages(mockOllama.mock.calls[0][0].steps);
    expect(text(messages)).toContain("THE SUMMARY");
    expect(text(messages)).toContain("THE REMAINING WORK");
    expect(messages.map((m) => m.role)).toEqual(["system", CONTEXT_PLACEMENT.summary]);
    // No usage note without the tool.
    expect(text(messages)).not.toMatch(/context/i);
  });

  it("AC-FORK-11: reaches the OpenAI-compatible provider with the summary", async () => {
    mockOpenAI.mockResolvedValue([answer]);
    await send({ model: "m", provider: "compat", steps: forkSteps() });
    expect(mockOpenAI).toHaveBeenCalledTimes(1);
    const messages = toOpenAIMessages(mockOpenAI.mock.calls[0][0].steps);
    expect(text(messages)).toContain("THE SUMMARY");
    expect(text(messages)).toContain("THE REMAINING WORK");
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("collates a following user message onto the summary so no two user messages are adjacent", async () => {
    mockOpenAI.mockResolvedValue([answer]);
    await send({ model: "m", provider: "compat", steps: [...forkSteps(), step("user", "next question")] });
    const messages = toOpenAIMessages(mockOpenAI.mock.calls[0][0].steps);
    expect(messages.map((m) => m.role)).toEqual(["system", "user"]);
    expect(text(messages)).toContain("THE SUMMARY");
    expect(text(messages)).toContain("next question");
  });

  it.each([
    ["ollama", mockOllama, toOllamaMessages],
    ["compat", mockOpenAI, toOpenAIMessages],
  ] as const)("AC-FORK-7 (%s): the user's first message in the fork, with compact_context active, is one user turn holding summary and text", async (provider, mock, format) => {
    mock.mockResolvedValue([answer]);
    const compact = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
    const done = await send({ model: "m", provider, steps: [...forkSteps(), step("user", "next question")], tools: [compact] });
    expect(done.type).toBe("chat.done");
    const messages = format(mock.mock.calls[0][0].steps as never) as Array<{ role: string; content?: unknown }>;
    const users = messages.filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect(String(users[0].content)).toContain("THE SUMMARY");
    expect(String(users[0].content)).toContain("next question");
  });

  it("AC-STRUCT-1: malformed compaction steps are still rejected", async () => {
    const bad = { ...step("compaction", "x"), content: undefined };
    const done = await send({ model: "m", provider: "ollama", steps: [bad] });
    expect(done.type).toBe("chat.error");
    const miscased = await send({ model: "m", provider: "ollama", steps: [{ ...step("compaction", "x"), kind: "Compaction" }] });
    expect(miscased.type).toBe("chat.error");
    expect(mockOllama).not.toHaveBeenCalled();
  });
});

/** The original after compaction: its turn, the authentic compact_context call (no result), then the app's harness step. */
function compactedOriginal(extra: ConversationStep[] = []): ConversationStep[] {
  const call = (id: string | undefined, content: string): ConversationStep => ({
    ...step("tool_call", content),
    toolCall: { ...(id ? { id } : {}), name: "compact_context", arguments: { summary: "SECRET-SUMMARY" } },
  });
  return [
    step("system", "be terse"),
    step("user", "first question"),
    step("assistant", "first answer"),
    call("call_1", "c1"),
    {
      ...step("meta", "HARNESS-TEXT context compacted"),
      metaEvent: { kind: "compaction", title: "t", detail: "HARNESS-TEXT", data: { forkConversationId: "fork-9" } },
    } as ConversationStep,
    ...extra,
    step("user", "continue here"),
  ];
}

describe("continuing the original after compaction (AC-FORK-14)", () => {
  const COMPACT = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };

  it("Ollama: no compact_context call and no harness text reach the provider", async () => {
    mockOllama.mockResolvedValue([answer]);
    const done = await send({ model: "m", provider: "ollama", steps: compactedOriginal(), tools: [COMPACT] });
    expect(done.type).toBe("chat.done");
    const messages = toOllamaMessages(mockOllama.mock.calls[0][0].steps);
    expect(messages.some((m) => m.tool_calls !== undefined)).toBe(false);
    expect(text(messages)).not.toContain("HARNESS-TEXT");
    expect(text(messages)).not.toContain("SECRET-SUMMARY");
    expect(messages.filter((m) => m.role === "user").map((m) => m.content.split("\n")[0])).toEqual(["first question", "continue here"]);
  });

  it("OpenAI-compatible: the dangling tool_call is dropped, so every sent call has a result", async () => {
    mockOpenAI.mockResolvedValue([answer]);
    await send({ model: "m", provider: "compat", steps: compactedOriginal(), tools: [COMPACT] });
    const messages = toOpenAIMessages(mockOpenAI.mock.calls[0][0].steps);
    expect(JSON.stringify(messages)).not.toContain("tool_calls");
    expect(JSON.stringify(messages)).not.toContain("call_1");
    expect(text(messages)).not.toContain("HARNESS-TEXT");
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("a rejected compact_context call with its error tool_result is still sent", async () => {
    mockOpenAI.mockResolvedValue([answer]);
    const rejected: ConversationStep[] = [
      { ...step("tool_call", "c0"), toolCall: { id: "call_0", name: "compact_context", arguments: {} } },
      { ...step("tool_result", JSON.stringify({ error: "needs a summary" })), toolResult: { id: "call_0", name: "compact_context" } },
    ];
    await send({ model: "m", provider: "compat", steps: compactedOriginal(rejected), tools: [COMPACT] });
    const serialised = JSON.stringify(toOpenAIMessages(mockOpenAI.mock.calls[0][0].steps));
    expect(serialised).toContain("call_0");
    expect(serialised).toContain("needs a summary");
    expect(serialised).not.toContain("call_1");
  });
});
