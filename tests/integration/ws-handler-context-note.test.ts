/**
 * Tool-loop placement and usage note (compaction-tool S4): every model invocation receives a
 * per-invocation placed copy of the steps, with a note only while `compact_context` is enabled,
 * and the transform never leaks into the steps the server emits.
 *
 * The provider client is mocked; `compact_context` is only a tool NAME in the request here, which
 * is all the note gate reads (the tool loop's handling of the call is covered by ws-handler-compact-context).
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
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import type { ConversationStep, ToolDefinition } from "../../server/types.js";
import { buildContextUsageNote, CONTEXT_PLACEMENT } from "../../shared/context-usage.js";
import { toOllamaMessages } from "../../shared/ollama-format.js";
import { buildOpenAIRequestBody, toOpenAIMessages } from "../../shared/openai-format.js";
import { toOllamaFilteredMessages } from "../../src/lib/token-view.js";

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
  const address = httpServer.address();
  port = typeof address === "object" && address ? address.port : 0;
});

afterAll(async () => {
  wss.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

beforeEach(() => {
  mockStream.mockReset();
  vi.restoreAllMocks();
  process.env.BRAVE_API_KEY = "test-brave-key";
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ web: { results: [{ title: "T", url: "https://example.com", description: "D" }] } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
});

interface Msg {
  type?: string;
  steps?: ConversationStep[];
  [key: string]: unknown;
}

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectUntilDone(ws: WebSocket): Promise<Msg[]> {
  return new Promise((resolve, reject) => {
    const msgs: Msg[] = [];
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Msg;
      msgs.push(msg);
      if (msg.type === "chat.done" || msg.type === "chat.error") {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

function step(kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id: `${kind}-${content}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const COMPACT_TOOL: ToolDefinition = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
const SEARCH_TOOL: ToolDefinition = new WebSearchExecutor().getToolDefinitions()[0];

/** Runs one chat.send; returns the steps handed to the provider per invocation and the server's messages. */
async function run(
  request: Record<string, unknown>,
  responses: ConversationStep[][]
): Promise<{ invocations: ConversationStep[][]; messages: Msg[] }> {
  const invocations: ConversationStep[][] = [];
  let call = 0;
  mockStream.mockImplementation(async (args) => {
    // Snapshot: the provider must not be handed anything the server later mutates.
    invocations.push(structuredClone(args.steps));
    const response = responses[Math.min(call++, responses.length - 1)];
    args.onDelta(response);
    return structuredClone(response);
  });
  const ws = await connect();
  try {
    const done = collectUntilDone(ws);
    ws.send(JSON.stringify({ type: "chat.send", conversationId: `c-${Date.now()}`, model: "qwen3:latest", ...request }));
    const messages = await done;
    expect(messages.at(-1)?.type).toBe("chat.done");
    return { invocations, messages };
  } finally {
    ws.close();
  }
}

const searchCall = (usage?: ConversationStep["usage"]) =>
  step("tool_call", "Requested web_search", { toolCall: { id: "call-1", name: "web_search", arguments: { query: "q" } }, ...(usage ? { usage } : {}) });
const answer = (usage?: ConversationStep["usage"]) => step("assistant", "done", usage ? { usage } : {});

const WINDOW = { contextWindow: 8192, contextWindowSource: "runtime" };
const lastUser = (steps: ConversationStep[]) => steps.filter((s) => s.kind === "user").at(-1)!;
const noteFor = (usedTokens: number | undefined) => buildContextUsageNote({ usedTokens, windowTokens: 8192, source: "runtime" });

describe("tool loop: usage note and placement", () => {
  const baseSteps = () => [step("system", "be terse"), step("user", "hello")];

  it("AC-NOTE-2/3: the first invocation without usage in the incoming steps gets the number-free note on the last user message", async () => {
    const { invocations } = await run({ steps: baseSteps(), tools: [COMPACT_TOOL], ...WINDOW }, [[answer()]]);
    expect(invocations).toHaveLength(1);
    const user = lastUser(invocations[0]);
    expect(user.content).toBe(`hello\n\n${noteFor(undefined)}`);
    expect(user.content).not.toMatch(/\d/);
    expect(invocations[0]).toHaveLength(2); // collated, no extra message
  });

  it("AC-NOTE-3: the first invocation uses the last usage in the incoming steps, for the default family and for a named one", async () => {
    const steps = [step("system", "s"), step("user", "q1"), step("assistant", "a1", { usage: { inputTokens: 6000, outputTokens: 120 } }), step("user", "q2")];
    for (const modelFamily of [undefined, "qwen3", "llama"]) {
      const { invocations } = await run({ steps, tools: [COMPACT_TOOL], modelFamily, ...WINDOW }, [[answer()]]);
      const expectedIndex = CONTEXT_PLACEMENT.note === "trailing-user" ? 3 : -1;
      expect(invocations[0][expectedIndex].content).toBe(`q2\n\n${noteFor(6120)}`);
      expect(invocations[0]).toHaveLength(4);
    }
  });

  it("AC-NOTE-3/5: every invocation of a tool loop gets a note built from the previous invocation's usage", async () => {
    const { invocations } = await run(
      { steps: baseSteps(), tools: [COMPACT_TOOL, SEARCH_TOOL], ...WINDOW },
      [
        [searchCall({ inputTokens: 1000, outputTokens: 50 })],
        [searchCall({ inputTokens: 2000, outputTokens: 75 })],
        [answer({ inputTokens: 3000, outputTokens: 10 })],
      ]
    );
    expect(invocations).toHaveLength(3);
    // Invocation 1: user last. Later ones: tool result last, so the note is its own user message after it.
    expect(lastUser(invocations[0]).content).toBe(`hello\n\n${noteFor(undefined)}`);
    for (const [index, used] of [[1, 1050], [2, 2075]] as const) {
      const invocation = invocations[index];
      const final = invocation.at(-1)!;
      expect(final.kind).toBe("user");
      expect(final.content).toBe(noteFor(used));
      expect(invocation.at(-2)!.kind).toBe("tool_result");
      // Exactly one note per invocation: earlier notes never accumulate.
      expect(invocation.filter((s) => s.content.includes("Automatic note from the app"))).toHaveLength(1);
    }
  });

  it("AC-NOTE-5: a previous invocation that reported no usage yields a number-free note, not a stale figure", async () => {
    const steps = [step("user", "q1"), step("assistant", "a1", { usage: { inputTokens: 5000, outputTokens: 1 } }), step("user", "q2")];
    const { invocations } = await run({ steps, tools: [COMPACT_TOOL, SEARCH_TOOL], ...WINDOW }, [[searchCall()], [answer()]]);
    expect(lastUser(invocations[0]).content).toBe(`q2\n\n${noteFor(5001)}`);
    expect(invocations[1].at(-1)!.content).toBe(noteFor(undefined));
  });

  it("AC-NOTE-2/5: the first invocation gets a number-free note when the latest assistant step reported no usage, though an older one did", async () => {
    const steps = [
      step("user", "q1"),
      step("assistant", "a1", { usage: { inputTokens: 5000, outputTokens: 1 } }),
      step("user", "q2"),
      step("assistant", "a2"),
      step("user", "q3"),
    ];
    const { invocations } = await run({ steps, tools: [COMPACT_TOOL], ...WINDOW }, [[answer()]]);
    const content = lastUser(invocations[0]).content;
    expect(content).toBe(`q3\n\n${noteFor(undefined)}`);
    expect(content.replace("q3", "")).not.toMatch(/\d/);
  });

  it("states used tokens only when the window source is assumed, and with no window at all", async () => {
    const steps = [step("user", "q"), step("assistant", "a", { usage: { inputTokens: 6000, outputTokens: 120 } }), step("user", "q2")];
    for (const extra of [{ contextWindow: 8192, contextWindowSource: "assumed" }, {}]) {
      const { invocations } = await run({ steps, tools: [COMPACT_TOOL], ...extra }, [[answer()]]);
      const content = lastUser(invocations[0]).content;
      expect(content).toContain("6,120");
      expect(content).not.toContain("%");
      expect(content).not.toContain("8,192");
    }
  });

  it("AC-NOTE-4: no invocation receives a note when compact_context is not enabled", async () => {
    const { invocations } = await run(
      { steps: baseSteps(), tools: [SEARCH_TOOL], ...WINDOW },
      [[searchCall({ inputTokens: 1000, outputTokens: 50 })], [answer()]]
    );
    expect(invocations).toHaveLength(2);
    for (const invocation of invocations) {
      expect(JSON.stringify(invocation)).not.toContain("compact_context");
      expect(invocation.some((s) => s.content.includes("Automatic note"))).toBe(false);
    }
    expect(invocations[0]).toEqual(baseSteps());
  });

  it("AC-NOTE-9: chat.delta, chat.steps and chat.done never contain the note or a placement-produced step", async () => {
    const steps = [step("system", "s"), step("user", "continue")];
    const { messages } = await run(
      { steps, tools: [COMPACT_TOOL, SEARCH_TOOL], ...WINDOW },
      [[searchCall({ inputTokens: 1000, outputTokens: 50 })], [answer({ inputTokens: 1200, outputTokens: 5 })]]
    );
    const emitted = messages.filter((m) => ["chat.delta", "chat.steps", "chat.done"].includes(m.type ?? "")).flatMap((m) => m.steps ?? []);
    expect(emitted.length).toBeGreaterThan(0);
    for (const emittedStep of emitted) {
      expect(JSON.stringify(emittedStep)).not.toContain("Automatic note");
      expect(emittedStep.id).not.toBe("context-usage-note");
    }
    const done = messages.find((m) => m.type === "chat.done")!;
    // chat.done carries only new steps: none of the incoming ones, and no user step at all.
    expect(done.steps!.some((s) => s.kind === "user")).toBe(false);
  });

  it("AC-NOTE-6/8: the provider's messages equal the preview's for the same steps (Ollama list and OpenAI body)", async () => {
    const steps = [
      step("system", "s"),
      step("user", "q1"),
      step("assistant", "a1", { usage: { inputTokens: 6000, outputTokens: 120 } }),
      step("user", "q2"),
    ];
    const { invocations } = await run({ steps, tools: [COMPACT_TOOL], modelFamily: "qwen3", ...WINDOW }, [[answer()]]);
    const placement = { activeTools: [COMPACT_TOOL], contextWindow: { tokens: 8192, source: "runtime" as const }, family: "qwen3" };

    const ollamaPreview = toOllamaFilteredMessages(steps, placement);
    const ollamaWire = toOllamaMessages(invocations[0]).map(({ role, content }) => ({ role, content }));
    expect(ollamaPreview).toEqual(ollamaWire);

    const { placeStepsForModel } = await import("../../shared/context-usage.js");
    const preview = buildOpenAIRequestBody({
      model: "qwen3:latest",
      steps: placeStepsForModel(steps, { compactEnabled: true, usedTokens: 6120, window: placement.contextWindow, family: "qwen3" }),
      tools: [],
    }).messages;
    expect(preview).toEqual(toOpenAIMessages(invocations[0]));
    const messages = preview as Array<{ role: string; content: string }>;
    expect(messages.at(-1)!.content).toBe(`q2\n\n${noteFor(6120)}`);
    expect(messages).toHaveLength(4);
  });
});
