/**
 * compact_context tool loop (compaction-tool S5): a valid sole call ends the turn with
 * `chat.done.compaction`; multi-call and invalid calls return error tool_results and re-invoke the
 * model; every call counts against `maxToolCalls`; a disabled tool still ends in `chat.error`.
 * Both providers are mocked (Ollama without call ids, OpenAI-compatible with call ids).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn(),
  buildOllamaChatBody: vi.fn(),
}));
vi.mock("../../server/openai-client.js", () => ({
  streamOpenAIResponse: vi.fn(),
  fetchOpenAIModels: vi.fn().mockResolvedValue([]),
}));

import { ConnectionHandler, loadExecutionLimits } from "../../server/ws-handler.js";
import { LlmRouter } from "../../server/llm-router.js";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import { streamOpenAIResponse } from "../../server/openai-client.js";
import { CompactContextExecutor, parseCompactContextArgs } from "../../server/tools/compact-context.js";
import { McpBridge } from "../../server/tools/mcp-bridge.js";
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import type { ConversationStep, ToolDefinition } from "../../server/types.js";

const mockOllama = vi.mocked(streamOllamaResponse);
const mockOpenAI = vi.mocked(streamOpenAIResponse);

let httpServer: Server;
let wss: WebSocketServer;
let port = 0;

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  const router = new LlmRouter([
    { id: "ollama", type: "ollama", name: "Ollama", baseUrl: "http://unused/api" },
    { id: "compat", type: "openai-compat", name: "Compat", baseUrl: "http://unused/v1", apiKey: "k" },
  ]);
  wss.on("connection", (ws) => {
    new ConnectionHandler(ws, router, loadExecutionLimits({}));
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
  message?: string;
  compaction?: Record<string, unknown>;
  [key: string]: unknown;
}

function step(kind: ConversationStep["kind"], content: string, extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id: `${kind}-${Math.random().toString(36).slice(2)}`, kind, title: kind, content, createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

const COMPACT_TOOL: ToolDefinition = new CompactContextExecutor().getToolDefinitions()[0];
const SEARCH_TOOL: ToolDefinition = new WebSearchExecutor().getToolDefinitions()[0];

const compactCall = (args: Record<string, unknown>, id?: string, usage?: ConversationStep["usage"]) =>
  step("tool_call", "Requested compact_context", { toolCall: { ...(id ? { id } : {}), name: "compact_context", arguments: args }, ...(usage ? { usage } : {}) });
const searchCall = (id?: string) =>
  step("tool_call", "Requested web_search", { toolCall: { ...(id ? { id } : {}), name: "web_search", arguments: { query: "q" } } });
const answer = (content = "done") => step("assistant", content);

interface Run { invocations: ConversationStep[][]; messages: Msg[]; terminal: Msg }

async function run(
  responses: ConversationStep[][],
  request: Record<string, unknown> = {},
  provider: "ollama" | "compat" = "ollama"
): Promise<Run> {
  const invocations: ConversationStep[][] = [];
  let call = 0;
  const impl = async (args: { steps: ConversationStep[]; onDelta: (s: ConversationStep[]) => void }) => {
    invocations.push(structuredClone(args.steps));
    const response = responses[Math.min(call++, responses.length - 1)];
    args.onDelta(response);
    return structuredClone(response);
  };
  mockOllama.mockImplementation(impl as never);
  mockOpenAI.mockImplementation(impl as never);
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${port}`);
    socket.on("open", () => resolve(socket));
    socket.on("error", reject);
  });
  try {
    const messages = await new Promise<Msg[]>((resolve, reject) => {
      const msgs: Msg[] = [];
      const timer = setTimeout(() => reject(new Error(`timeout: ${msgs.map((m) => m.type).join(",")}`)), 5000);
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString()) as Msg;
        msgs.push(msg);
        if (msg.type === "chat.done" || msg.type === "chat.error") { clearTimeout(timer); resolve(msgs); }
      });
      ws.send(JSON.stringify({
        type: "chat.send", conversationId: `c-${Date.now()}-${Math.random()}`, model: "qwen3:latest", provider,
        steps: [step("system", "s"), step("user", "hello")], tools: [COMPACT_TOOL, SEARCH_TOOL],
        ...request,
      }));
    });
    return { invocations, messages, terminal: messages.at(-1)! };
  } finally {
    ws.close();
  }
}

const results = (steps: ConversationStep[] | undefined) => (steps ?? []).filter((s) => s.kind === "tool_result");
const allSteps = (messages: Msg[]) => messages.flatMap((m) => m.steps ?? []);
/** The model-facing tool_results handed to invocation `n` (everything after the incoming two steps). */
const fed = (invocation: ConversationStep[]) => results(invocation);

describe("compact_context: sole valid call (AC-TOOL-2/3)", () => {
  it.each([
    ["ollama", undefined],
    ["compat", "call_abc"],
  ] as const)("%s: ends the turn with compaction and never invokes the model again", async (provider, id) => {
    const call = compactCall({ summary: "We decided X.", remaining_work: "Do Y." }, id);
    const { invocations, terminal } = await run([[step("assistant", "wrapping up"), call], [answer()]], {}, provider);
    expect(invocations).toHaveLength(1);
    expect(terminal.type).toBe("chat.done");
    expect(terminal.compaction).toEqual({ toolCallStepId: call.id, summary: "We decided X.", remainingWork: "Do Y." });
    const steps = terminal.steps!;
    // AC-TOOL-3: the authentic call only; nothing is sent back to the model, so no tool_result is made.
    expect(steps.map((s) => s.kind)).toEqual(["assistant", "tool_call"]);
    expect(steps.find((s) => s.kind === "tool_call")!.id).toBe(terminal.compaction!.toolCallStepId);
    expect(steps.find((s) => s.kind === "tool_call")!.toolCall?.id).toBe(id);
    expect(results(steps)).toEqual([]);
  });

  it("includes steps from earlier loop iterations and omits remainingWork when absent or blank", async () => {
    const call = compactCall({ summary: "S", remaining_work: "   " });
    const { terminal } = await run([[searchCall()], [call]]);
    expect(terminal.compaction).toStrictEqual({ toolCallStepId: call.id, summary: "S" });
    expect(Object.keys(terminal.compaction!).sort()).toEqual(["summary", "toolCallStepId"]);
    expect(terminal.steps!.map((s) => s.kind)).toEqual(["tool_call", "tool_result", "tool_call"]);
  });

  it("never fabricates a tool_result for the compaction call (not in chat.delta either)", async () => {
    const { messages } = await run([[compactCall({ summary: "S" })]]);
    expect(messages.filter((m) => m.type === "chat.delta").flatMap((m) => m.steps ?? []).some((s) => s.kind === "tool_result")).toBe(false);
  });
});

describe("compact_context: rejected calls (AC-TOOL-5/6/8)", () => {
  it("mixed calls: executes nothing, errors every call, no compaction, re-invokes the model", async () => {
    const compact = compactCall({ summary: "S" }, "c1");
    const search = searchCall("s1");
    const { invocations, terminal, messages } = await run([[compact, search], [answer()]], {}, "compat");
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(terminal.type).toBe("chat.done");
    expect(terminal.compaction).toBeUndefined();
    expect(invocations).toHaveLength(2);
    const errors = fed(invocations[1]);
    expect(errors.map((r) => r.toolResult)).toEqual([{ id: "c1", name: "compact_context" }, { id: "s1", name: "web_search" }]);
    for (const r of errors) expect(JSON.parse(r.content).error).toEqual(expect.any(String));
    expect(allSteps(messages).filter((s) => s.kind === "tool_result" && s.title.startsWith("Executing")).length).toBe(0);
    expect(terminal.steps!.map((s) => s.kind)).toEqual(["tool_call", "tool_call", "tool_result", "tool_result", "assistant"]);
  });

  it("two compact_context calls are both rejected", async () => {
    const { invocations, terminal } = await run([[compactCall({ summary: "A" }, "a"), compactCall({ summary: "B" }, "b")], [answer()]], {}, "compat");
    expect(terminal.compaction).toBeUndefined();
    expect(fed(invocations[1]).map((r) => r.toolResult?.id)).toEqual(["a", "b"]);
  });

  it.each([
    ["empty", { summary: "" }],
    ["whitespace", { summary: " \n\t " }],
    ["missing", {}],
    ["non-string", { summary: 5 }],
    ["non-string remaining_work", { summary: "ok", remaining_work: 3 }],
    ["extra property", { summary: "ok", extra: true }],
  ])("%s arguments: error tool_result, no compaction, model re-invoked", async (_name, args) => {
    const { invocations, terminal } = await run([[compactCall(args, "c1")], [answer()]], {}, "compat");
    expect(terminal.type).toBe("chat.done");
    expect(terminal.compaction).toBeUndefined();
    expect(invocations).toHaveLength(2);
    const [error] = fed(invocations[1]);
    expect(error.toolResult).toEqual({ id: "c1", name: "compact_context" });
    expect(JSON.parse(error.content).error).toMatch(/compact_context/);
  });

  it("a rejected call can be followed by a valid one in the next response", async () => {
    const good = compactCall({ summary: "real" });
    const { invocations, terminal } = await run([[compactCall({ summary: "" })], [good]]);
    expect(invocations).toHaveLength(2);
    expect(terminal.compaction).toMatchObject({ summary: "real", toolCallStepId: good.id });
  });

  it("stops with a budget error when the rejecting response would exceed maxToolCalls (AC-TOOL-8)", async () => {
    const { terminal, invocations } = await run([[compactCall({ summary: "A" }), searchCall()]], { maxToolCalls: 1 });
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("at most 1 tool calls per request");
    expect(invocations).toHaveLength(1);
  });

  it("rejected compact_context calls consume maxToolCalls across responses (AC-TOOL-8)", async () => {
    // Each rejected response spends 2 calls; the second would exceed a budget of 3.
    const mixed = [compactCall({ summary: "A" }), searchCall()];
    const { terminal, invocations } = await run([mixed], { maxToolCalls: 3 });
    expect(invocations).toHaveLength(2);
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("at most 3 tool calls per request");
  });

  it("a single rejected call exhausts a budget of one so the next tool call ends the request", async () => {
    const { terminal, invocations } = await run([[compactCall({ summary: " " })], [compactCall({ summary: " " })]], { maxToolCalls: 1 });
    expect(invocations).toHaveLength(2);
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("tool calls");
  });

  it("stops re-invoking at maxModelInvocations", async () => {
    const { terminal, invocations } = await run([[compactCall({ summary: "" })]], { maxModelInvocations: 2 });
    expect(invocations).toHaveLength(2);
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("model invocations");
  });

  it("rejection paths feed the response usage into the next invocation's note (S4 guarantee)", async () => {
    const usage = { inputTokens: 4000, outputTokens: 96 };
    const { invocations } = await run(
      [[compactCall({ summary: "" }, undefined, usage)], [answer()]],
      { contextWindow: 8192, contextWindowSource: "runtime" }
    );
    expect(invocations[1].at(-1)!.content).toContain("4,096");
  });
});

describe("compact_context: not enabled (AC-TOOL-7)", () => {
  it.each([[[SEARCH_TOOL]], [[]]])("ends with chat.error and no compaction when tools=%j", async (tools) => {
    const { terminal, invocations } = await run([[compactCall({ summary: "S" })], [answer()]], { tools });
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("Tool is not enabled for this request");
    expect(terminal.compaction).toBeUndefined();
    expect(invocations).toHaveLength(1);
  });

  it("a disabled compact_context among other calls also ends with chat.error", async () => {
    const { terminal } = await run([[searchCall(), compactCall({ summary: "S" })]], { tools: [SEARCH_TOOL] });
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("Tool is not enabled for this request");
  });

  it("a stale tool id is refused before interception", async () => {
    const { terminal } = await run([[compactCall({ summary: "S" })]], { tools: [{ ...COMPACT_TOOL, id: "other" }] });
    expect(terminal.type).toBe("chat.error");
    expect(terminal.message).toContain("no longer available");
  });
});

describe("compact_context registration (AC-TOOL-1)", () => {
  const definition = COMPACT_TOOL;
  const schema = JSON.parse(definition.inputSchema) as { required: string[]; properties: Record<string, { type: string; pattern?: string }> };

  it("has a stable id, a continue-in-fresh-context description and the specified schema", () => {
    expect(definition).toMatchObject({ id: "compact-context", name: "compact_context" });
    expect(definition.description).toMatch(/fresh context/);
    expect(schema.required).toEqual(["summary"]);
    expect(schema.properties.summary).toMatchObject({ type: "string", pattern: "\\S" });
    expect(schema.properties.remaining_work.type).toBe("string");
    expect(new RegExp(schema.properties.summary.pattern!).test("  ")).toBe(false);
    expect(new RegExp(schema.properties.summary.pattern!).test(" x ")).toBe(true);
  });

  it("the connection dispatcher accepts a selection carrying the listed id (a valid call succeeds)", async () => {
    const { terminal } = await run([[compactCall({ summary: "S" })]], { tools: [definition] });
    expect(terminal.compaction).toBeDefined();
  });

  it("reserves the name against MCP tools", async () => {
    const bridge = new McpBridge(["web_search", "curl", "compact_context"]);
    expect(bridge.canHandle("compact_context")).toBe(false);
  });

  it("executor validates when called directly and never handles other names", async () => {
    const executor = new CompactContextExecutor();
    expect(executor.canHandle("compact_context")).toBe(true);
    expect(executor.canHandle("curl")).toBe(false);
    await expect(executor.execute("compact_context", { summary: " " })).rejects.toThrow();
    await expect(executor.execute("compact_context", { summary: "x" })).resolves.toEqual(expect.any(String));
  });
});

describe("parseCompactContextArgs", () => {
  it.each([null, [], "s", 1])("rejects non-object arguments %j", (value) => {
    expect(parseCompactContextArgs(value).ok).toBe(false);
  });
  it("keeps the summary verbatim", () => {
    expect(parseCompactContextArgs({ summary: "  keep  " })).toEqual({ ok: true, summary: "  keep  " });
  });
});

describe("compact_context: what the model and the client are told (mutation audit)", () => {
  it("a mixed response tells each call why it was not executed, naming the call's own tool", async () => {
    const { invocations } = await run([[compactCall({ summary: "S" }, "c1"), searchCall("s1")], [answer()]], {}, "compat");
    const [compactError, searchError] = fed(invocations[1]).map((r) => JSON.parse(r.content).error as string);
    expect(compactError).toMatch(/^compact_context was not executed: it must be the only tool call/);
    expect(searchError).toMatch(/^web_search was not executed because the same response contained compact_context/);
    expect(fed(invocations[1]).map((r) => r.title)).toEqual(["Result: compact_context", "Result: web_search"]);
  });

  it("two compact_context calls each get the only-tool-call explanation", async () => {
    const { invocations } = await run([[compactCall({ summary: "A" }, "a"), compactCall({ summary: "B" }, "b")], [answer()]], {}, "compat");
    for (const r of fed(invocations[1])) expect(JSON.parse(r.content).error).toMatch(/must be the only tool call/);
  });

  it("a rejected response is streamed to the client as chat.steps before its error results", async () => {
    const compact = compactCall({ summary: "" }, "c1");
    const { messages } = await run([[compact], [answer()]], {}, "compat");
    const stepMessages = messages.filter((m) => m.type === "chat.steps");
    expect(stepMessages.map((m) => m.steps!.map((s) => s.kind))).toEqual([["tool_call"], ["tool_result"]]);
    expect(stepMessages[0].steps![0].id).toBe(compact.id);
  });

  it.each([
    ["a window without its source", { contextWindow: 8192 }],
    ["a source without its window", { contextWindowSource: "runtime" }],
  ])("%s is treated as no resolved window: the note states the used tokens only", async (_name, request) => {
    const usage = { inputTokens: 4000, outputTokens: 96 };
    const { invocations } = await run([[compactCall({ summary: "" }, undefined, usage)], [answer()]], request);
    const note = invocations[1].at(-1)!.content;
    expect(note).toContain("4,096 tokens");
    expect(note).not.toContain("%");
    expect(note).not.toContain("8,192");
  });
});

describe("parseCompactContextArgs error text (mutation audit)", () => {
  it.each([null, [], "s", 1, true])("explains to the model that %j is not an argument object", (value) => {
    expect(parseCompactContextArgs(value)).toEqual({ ok: false, error: "compact_context expects an object with a summary string." });
  });
});
