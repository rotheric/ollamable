/**
 * Protocol-contract tests for `ConnectionHandler` driven through an in-memory
 * socket and a stub router, so every message the handler emits can be
 * inspected in order. Covers what the socket-level suites leave unasserted:
 * exact protocol-error texts, the tool-execution message sequence (protocol
 * call, in-progress result, final result), stop semantics during a tool
 * call, generation bookkeeping after completion, non-Error failures, and
 * MCP initialisation (reserved names, tools.update, dispatchability).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type WebSocket from "ws";

const mcp = vi.hoisted(() => ({
  listTools: vi.fn(),
  callTool: vi.fn(),
}));
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined);
    listTools = mcp.listTools;
    callTool = mcp.callTool;
    close = vi.fn().mockResolvedValue(undefined);
  },
}));
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: class {
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

import { ConnectionHandler, loadExecutionLimits, type ExecutionLimits } from "../../server/ws-handler.js";
import { ToolDispatcher } from "../../server/tool-executor.js";
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import { CompactContextExecutor } from "../../server/tools/compact-context.js";
import type { LlmRouter } from "../../server/llm-router.js";
import type { ConversationStep, MetaEvent } from "../../server/types.js";

type Sent = Record<string, unknown> & { type: string };

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Sent[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Sent);
  }
  deliver(msg: unknown): void {
    this.emit("message", Buffer.from(typeof msg === "string" ? msg : JSON.stringify(msg)));
  }
  ofType(type: string): Sent[] {
    return this.sent.filter((m) => m.type === type);
  }
}

interface StubRouter {
  streamResponse: ReturnType<typeof vi.fn>;
  tokenizeText: ReturnType<typeof vi.fn>;
}

function setup(limits: ExecutionLimits = loadExecutionLimits({})) {
  const ws = new FakeSocket();
  const router: StubRouter = { streamResponse: vi.fn(), tokenizeText: vi.fn() };
  const handler = new ConnectionHandler(ws as unknown as WebSocket, router as unknown as LlmRouter, limits);
  return { ws, router, handler };
}

const USER: ConversationStep = { id: "u1", kind: "user", title: "User", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" };
const webSearch = new WebSearchExecutor().getToolDefinitions()[0];
const compactTool = new CompactContextExecutor().getToolDefinitions()[0];

function step(kind: ConversationStep["kind"], extra: Partial<ConversationStep> = {}): ConversationStep {
  return { id: `${kind}-${Math.random().toString(36).slice(2)}`, kind, title: kind, content: "", createdAt: "2026-01-01T00:00:00.000Z", ...extra };
}

function chatSend(extra: Record<string, unknown> = {}) {
  return { type: "chat.send", conversationId: "c", requestId: "r1", model: "m", steps: [USER], ...extra };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("protocol errors carry their specific message", () => {
  it("answers unparseable JSON with 'Invalid JSON message'", async () => {
    const { ws } = setup();
    ws.deliver("{not json");
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "protocol.error", message: "Invalid JSON message" });
  });

  it.each([[{ foo: 1 }], [{ type: 5 }], [[1, 2]]])("answers %j with the missing-type error, not the unknown-type error", async (msg) => {
    const { ws } = setup();
    ws.deliver(msg);
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "protocol.error", message: "Expected a message object with a type" });
  });

  it("answers a whitespace-only conversationId with a protocol error (no conversation to address)", async () => {
    const { ws } = setup();
    ws.deliver(chatSend({ conversationId: "   " }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "protocol.error", message: "Invalid conversationId or requestId" });
  });

  it("drops a non-string requestId from the chat.error it echoes", async () => {
    const { ws } = setup();
    ws.deliver(chatSend({ requestId: 5 }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "chat.error", conversationId: "c", message: "Invalid conversationId or requestId" });
    expect("requestId" in ws.sent[0]).toBe(false);
  });

  it("echoes a valid requestId on a chat.error for an otherwise invalid request", async () => {
    const { ws } = setup();
    ws.deliver(chatSend({ model: "" }));
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "chat.error", conversationId: "c", requestId: "r1", message: "Invalid model or provider" });
  });
});

describe("socket state", () => {
  it("writes nothing to a socket that is no longer open", async () => {
    const { ws } = setup();
    ws.readyState = 3; // CLOSED
    ws.deliver({ type: "ping" });
    ws.deliver("{not json");
    await flush();
    expect(ws.sent).toEqual([]);
  });

  it("answers a ping with a pong while open", async () => {
    const { ws } = setup();
    ws.deliver({ type: "ping" });
    await vi.waitFor(() => expect(ws.sent).toEqual([{ type: "pong" }]));
  });
});

describe("tokenize field validation", () => {
  it("never routes a tokenize whose model is not a string", async () => {
    const { ws, router } = setup();
    router.tokenizeText.mockResolvedValue({ tokens: ["a"], tokenIds: [1] });
    ws.deliver({ type: "tokenize", requestId: "t1", model: 7, text: "a" });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "tokenize.error", requestId: "t1", reason: "internal" });
    expect(router.tokenizeText).not.toHaveBeenCalled();
  });

  it("never routes a tokenize whose text is not a string", async () => {
    const { ws, router } = setup();
    router.tokenizeText.mockResolvedValue({ tokens: ["a"], tokenIds: [1] });
    ws.deliver({ type: "tokenize", requestId: "t2", model: "m", text: 1 });
    await vi.waitFor(() => expect(ws.sent).toHaveLength(1));
    expect(ws.sent[0]).toEqual({ type: "tokenize.error", requestId: "t2", reason: "internal" });
    expect(router.tokenizeText).not.toHaveBeenCalled();
  });
});

describe("generation bookkeeping", () => {
  it("tells the superseded request why it ended", async () => {
    const { ws, router } = setup();
    router.streamResponse
      .mockImplementationOnce(({ signal }: { signal: AbortSignal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))))
      .mockResolvedValueOnce([step("assistant", { content: "ok" })]);
    ws.deliver(chatSend({ requestId: "first" }));
    await vi.waitFor(() => expect(router.streamResponse).toHaveBeenCalledTimes(1));
    ws.deliver(chatSend({ requestId: "second" }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    expect(ws.ofType("chat.error")).toEqual([
      { type: "chat.error", conversationId: "c", requestId: "first", message: "Generation superseded by a newer request." },
    ]);
  });

  it("does not report a finished request as superseded when the conversation sends again", async () => {
    const { ws, router } = setup();
    router.streamResponse.mockResolvedValue([step("assistant", { content: "ok" })]);
    ws.deliver(chatSend({ requestId: "first" }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    ws.deliver(chatSend({ requestId: "second" }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(2));
    expect(ws.ofType("chat.error")).toEqual([]);
  });

  it("does not report a failed request as superseded when the conversation sends again", async () => {
    const { ws, router } = setup();
    router.streamResponse.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([step("assistant", { content: "ok" })]);
    ws.deliver(chatSend({ requestId: "first" }));
    await vi.waitFor(() => expect(ws.ofType("chat.error")).toHaveLength(1));
    ws.deliver(chatSend({ requestId: "second" }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    expect(ws.ofType("chat.error")).toEqual([{ type: "chat.error", conversationId: "c", requestId: "first", message: "boom" }]);
  });

  it("reports a non-Error failure as 'Unknown server error'", async () => {
    const { ws, router } = setup();
    router.streamResponse.mockRejectedValue("a bare string");
    ws.deliver(chatSend());
    await vi.waitFor(() => expect(ws.ofType("chat.error")).toHaveLength(1));
    expect(ws.ofType("chat.error")[0]).toEqual({ type: "chat.error", conversationId: "c", requestId: "r1", message: "Unknown server error" });
  });
});

describe("which response steps count as tool calls", () => {
  it("finishes on a prose-only response", async () => {
    const { ws, router } = setup();
    const prose = step("assistant", { content: "hello" });
    router.streamResponse.mockResolvedValue([prose]);
    ws.deliver(chatSend());
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    expect((ws.ofType("chat.done")[0].steps as ConversationStep[]).map((s) => s.id)).toEqual([prose.id]);
    expect(ws.ofType("chat.error")).toEqual([]);
  });

  it("ignores a toolCall field on a step that is not a tool_call", async () => {
    const { ws, router } = setup();
    const odd = step("assistant", { content: "x", toolCall: { name: "web_search", id: "t", arguments: {} } });
    router.streamResponse.mockResolvedValue([odd]);
    ws.deliver(chatSend());
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === "chat.done" || m.type === "chat.error")).toBe(true));
    expect(ws.ofType("chat.error")).toEqual([]);
    expect(ws.ofType("chat.done")).toHaveLength(1);
    expect(router.streamResponse).toHaveBeenCalledTimes(1);
  });
});

describe("tool-call budget origin", () => {
  const twoCalls = () => [0, 1].map((i) => step("tool_call", { toolCall: { name: "web_search", id: `t${i}`, arguments: { query: "q" } } }));

  it("names the server ceiling when it capped the requested budget", async () => {
    const { ws, router } = setup({ maxModelInvocations: 64, maxToolCalls: 1 });
    router.streamResponse.mockResolvedValue(twoCalls());
    ws.deliver(chatSend({ tools: [webSearch], maxToolCalls: 5 }));
    await vi.waitFor(() => expect(ws.ofType("chat.error")).toHaveLength(1));
    expect(ws.ofType("chat.error")[0].message).toContain("at most 1 tool calls per request (server ceiling)");
  });

  it("names the conversation setting when the request chose the lower budget", async () => {
    const { ws, router } = setup({ maxModelInvocations: 64, maxToolCalls: 256 });
    router.streamResponse.mockResolvedValue(twoCalls());
    ws.deliver(chatSend({ tools: [webSearch], maxToolCalls: 1 }));
    await vi.waitFor(() => expect(ws.ofType("chat.error")).toHaveLength(1));
    expect(ws.ofType("chat.error")[0].message).toContain("at most 1 tool calls per request (conversation setting)");
  });
});

describe("tool execution message sequence", () => {
  it("emits the protocol call, an in-progress result and the final result under one id, then re-invokes the model", async () => {
    const { ws, router } = setup();
    const call = step("tool_call", { toolCall: { name: "web_search", id: "call-1", arguments: { query: "cats" } } });
    const answer = step("assistant", { content: "done" });
    router.streamResponse.mockResolvedValueOnce([call]).mockResolvedValueOnce([answer]);
    vi.spyOn(ToolDispatcher.prototype, "execute").mockResolvedValue("RESULT");

    ws.deliver(chatSend({ tools: [webSearch] }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));

    const stepsMsgs = ws.ofType("chat.steps");
    expect(stepsMsgs).toHaveLength(3);
    for (const m of stepsMsgs) expect(m).toMatchObject({ conversationId: "c", requestId: "r1" });

    expect((stepsMsgs[0].steps as ConversationStep[]).map((s) => s.id)).toEqual([call.id]);

    const [pending] = stepsMsgs[1].steps as ConversationStep[];
    expect(pending).toMatchObject({
      kind: "tool_result",
      title: "Executing: web_search",
      content: JSON.stringify({ query: "cats" }, null, 2),
      expanded: true,
      toolResult: { id: "call-1", name: "web_search" },
    });
    expect(stepsMsgs[1].steps).toHaveLength(1);

    const [final] = stepsMsgs[2].steps as ConversationStep[];
    expect(final).toMatchObject({
      id: pending.id,
      kind: "tool_result",
      title: "Result: web_search",
      content: "RESULT",
      expanded: true,
      toolResult: { id: "call-1", name: "web_search" },
    });

    // The model sees call and result on the second invocation; chat.done carries all new steps.
    const second = router.streamResponse.mock.calls[1][0] as { steps: ConversationStep[] };
    expect(second.steps.map((s) => s.id)).toEqual([USER.id, call.id, pending.id]);
    expect((ws.ofType("chat.done")[0].steps as ConversationStep[]).map((s) => s.id)).toEqual([call.id, pending.id, answer.id]);
  });

  it("forwards tool meta events with conversation and request ids while running", async () => {
    const { ws, router } = setup();
    router.streamResponse
      .mockResolvedValueOnce([step("tool_call", { toolCall: { name: "web_search", id: "k", arguments: { query: "q" } } })])
      .mockResolvedValueOnce([step("assistant", { content: "ok" })]);
    const event: MetaEvent = { id: "e1", kind: "search_start", title: "Search", detail: "d", timestamp: "2026-01-01T00:00:00Z" };
    vi.spyOn(ToolDispatcher.prototype, "execute").mockImplementation(async (_n, _a, emit) => { emit(event); return "R"; });
    ws.deliver(chatSend({ tools: [webSearch] }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    expect(ws.ofType("meta.event")).toEqual([{ type: "meta.event", conversationId: "c", requestId: "r1", event }]);
  });

  it("marks rejected compact_context results expanded like executed results", async () => {
    const { ws, router } = setup();
    router.streamResponse
      .mockResolvedValueOnce([
        step("tool_call", { toolCall: { name: "compact_context", id: "a", arguments: { summary: "s" } } }),
        step("tool_call", { toolCall: { name: "web_search", id: "b", arguments: { query: "q" } } }),
      ])
      .mockResolvedValueOnce([step("assistant", { content: "ok" })]);
    ws.deliver(chatSend({ tools: [webSearch, compactTool] }));
    await vi.waitFor(() => expect(ws.ofType("chat.done")).toHaveLength(1));
    const results = ws.ofType("chat.steps")[1].steps as ConversationStep[];
    expect(results).toHaveLength(2);
    for (const r of results) expect(r).toMatchObject({ kind: "tool_result", expanded: true });
    expect(results.map((r) => r.title)).toEqual(["Result: compact_context", "Result: web_search"]);
  });
});

describe("stop during a tool call", () => {
  it("drops the tool's late meta events and result and ends silently", async () => {
    const { ws, router } = setup();
    router.streamResponse
      .mockResolvedValueOnce([step("tool_call", { toolCall: { name: "web_search", id: "k", arguments: { query: "q" } } })])
      .mockResolvedValue([step("assistant", { content: "should not run" })]);
    let started = false;
    vi.spyOn(ToolDispatcher.prototype, "execute").mockImplementation((_n, _a, emit, signal) => {
      started = true;
      return new Promise((resolve) => {
        signal!.addEventListener("abort", () => {
          emit({ id: "late", kind: "search_start", title: "late", detail: "", timestamp: "2026-01-01T00:00:00Z" });
          resolve("LATE RESULT");
        });
      });
    });
    ws.deliver(chatSend({ tools: [webSearch] }));
    await vi.waitFor(() => expect(started).toBe(true));
    const before = ws.sent.length;
    ws.deliver({ type: "chat.stop", conversationId: "c", requestId: "r1" });
    await flush();
    expect(ws.sent.slice(before)).toEqual([]);
    expect(router.streamResponse).toHaveBeenCalledTimes(1);
  });
});

describe("MCP initialisation", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ws-mcp-"));
    mcp.listTools.mockReset();
    mcp.callTool.mockReset().mockResolvedValue({ content: [{ type: "text", text: "mcp says hi" }] });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function config(content: string): Promise<string> {
    const path = join(dir, "mcp.json");
    await writeFile(path, content);
    return path;
  }

  it("returns no tools and sends nothing without a config path, a readable file, valid JSON or servers", async () => {
    const { ws, handler } = setup();
    expect(await handler.initMcp()).toEqual([]);
    expect(await handler.initMcp(join(dir, "missing.json"))).toEqual([]);
    expect(await handler.initMcp(await config("{nope"))).toEqual([]);
    expect(await handler.initMcp(await config("{}"))).toEqual([]);
    expect(ws.sent).toEqual([]);
  });

  it("does not announce an empty MCP tool list", async () => {
    mcp.listTools.mockResolvedValue({ tools: [] });
    const { ws, handler } = setup();
    expect(await handler.initMcp(await config(JSON.stringify({ mcpServers: { srv: { command: "x" } } })))).toEqual([]);
    expect(ws.ofType("tools.update")).toEqual([]);
    expect(ws.ofType("meta.event").length).toBeGreaterThan(0);
    for (const m of ws.ofType("meta.event")) expect(m.conversationId).toBe("init");
  });

  it("rejects MCP tools that collide with built-in names, announces the rest and makes them dispatchable", async () => {
    mcp.listTools.mockResolvedValue({ tools: [
      { name: "web_search", inputSchema: { type: "object" } },
      { name: "compact_context", inputSchema: { type: "object" } },
      { name: "mcp_echo", inputSchema: { type: "object" } },
    ] });
    const { ws, router, handler } = setup();
    const tools = await handler.initMcp(await config(JSON.stringify({ mcpServers: { srv: { command: "x" } } })));
    expect(tools.map((t) => t.name)).toEqual(["mcp_echo"]);
    expect(ws.ofType("tools.update")).toEqual([{ type: "tools.update", tools }]);
    const rejected = ws.ofType("meta.event").filter((m) => (m.event as MetaEvent).title === "MCP Tool Rejected");
    expect(rejected.map((m) => (m.event as MetaEvent).data)).toEqual([
      { server: "srv", tool: "web_search" },
      { server: "srv", tool: "compact_context" },
    ]);
    for (const m of ws.ofType("meta.event")) expect(m.conversationId).toBe("init");

    router.streamResponse
      .mockResolvedValueOnce([step("tool_call", { toolCall: { name: "mcp_echo", id: "m1", arguments: {} } })])
      .mockResolvedValueOnce([step("assistant", { content: "ok" })]);
    ws.deliver(chatSend({ tools }));
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === "chat.done" || m.type === "chat.error")).toBe(true));
    expect(ws.ofType("chat.error")).toEqual([]);
    expect(mcp.callTool).toHaveBeenCalledOnce();
  });
});
