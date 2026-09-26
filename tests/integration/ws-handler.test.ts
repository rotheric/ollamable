/**
 * Integration tests for the WebSocket backend handler.
 *
 * These tests start a real WebSocket server with a ConnectionHandler,
 * connect a `ws` client, and verify the server's message protocol:
 *   - ping / pong keep-alive
 *   - chat.send → chat.delta / chat.done streaming
 *   - tool loop (tool_call → execute → re-call Ollama)
 *   - meta.event emission during tool execution
 *   - chat.stop abort flow
 *   - chat.error propagation
 *
 * The Ollama HTTP client (`streamOllamaResponse`) is mocked so these
 * tests exercise the handler logic without needing a running Ollama.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

// ── Mock Ollama client before importing the handler ──────────────────

vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn(),
  buildOllamaChatBody: vi.fn(),
}));

import { CurlExecutor } from "../../server/tools/curl.js";
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import { ConnectionHandler, MAX_MODEL_INVOCATIONS, MAX_TOOL_CALLS } from "../../server/ws-handler.js";
import { streamOllamaResponse } from "../../server/ollama-client.js";
import type { ConversationStep } from "../../server/types.js";

const mockStreamOllama = vi.mocked(streamOllamaResponse);

// ── Server lifecycle ─────────────────────────────────────────────────

let httpServer: Server;
let wss: WebSocketServer;
let wsPort: number;

beforeAll(async () => {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    // Create a handler but skip MCP init (no external servers needed)
    new ConnectionHandler(ws);
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
  mockStreamOllama.mockReset();
  vi.restoreAllMocks();
  delete process.env.BRAVE_API_KEY;
});

// ── Helpers ──────────────────────────────────────────────────────────

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${wsPort}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function sendJson(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
}

interface ParsedMessage {
  type?: string;
  conversationId?: string;
  steps?: ConversationStep[];
  message?: string;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

function waitForMessage(
  ws: WebSocket,
  predicate: (msg: ParsedMessage) => boolean,
  timeoutMs = 5_000
): Promise<ParsedMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("waitForMessage timeout")),
      timeoutMs
    );

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

function collectMessages(
  ws: WebSocket,
  predicate: (msgs: ParsedMessage[]) => boolean,
  timeoutMs = 5_000
): Promise<ParsedMessage[]> {
  return new Promise((resolve, reject) => {
    const msgs: ParsedMessage[] = [];
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `collectMessages timeout — received ${msgs.length}: [${msgs.map((m) => m.type).join(", ")}]`
          )
        ),
      timeoutMs
    );

    function onMessage(raw: Buffer | ArrayBuffer | Buffer[]) {
      const msg = JSON.parse(raw.toString()) as ParsedMessage;
      msgs.push(msg);
      if (predicate(msgs)) {
        clearTimeout(timer);
        ws.off("message", onMessage);
        resolve(msgs);
      }
    }

    ws.on("message", onMessage);
  });
}

function makeStep(
  kind: ConversationStep["kind"],
  content: string,
  extra?: Partial<ConversationStep>
): ConversationStep {
  return {
    id: `test-${kind}-${Date.now()}`,
    kind,
    title: kind.charAt(0).toUpperCase() + kind.slice(1),
    content,
    createdAt: new Date().toISOString(),
    expanded: true,
    ...extra,
  };
}

function makeChatSend(overrides?: Record<string, unknown>) {
  return {
    type: "chat.send",
    conversationId: `conv-${Date.now()}`,
    model: "qwen3:latest",
    steps: [makeStep("system", ""), makeStep("user", "Hello")],
    tools: [],
    ...overrides,
  };
}

/**
 * Mock global fetch to return a Brave Search API response.
 * Also sets BRAVE_API_KEY so the executor treats itself as configured.
 * Note: the env var must be set before the ConnectionHandler is created
 * (i.e. before `connectClient()`), because the WebSearchExecutor reads
 * it in its constructor.
 */
function mockBraveSearchFetch() {
  process.env.BRAVE_API_KEY = "test-brave-key";

  const braveResponse = {
    web: {
      results: [
        { title: "Example Result", url: "https://example.com", description: "A test result" },
      ],
    },
  };

  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(braveResponse), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );
}

// ── Tests ────────────────────────────────────────────────────────────

describe("ConnectionHandler", () => {
  // ── Keep-alive ───────────────────────────────────────────────────

  it("responds to ping with pong", async () => {
    const ws = await connectClient();
    try {
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      sendJson(ws, { type: "ping" });
      const pong = await pongPromise;
      expect(pong.type).toBe("pong");
    } finally {
      ws.close();
    }
  });

  // ── Basic chat ───────────────────────────────────────────────────

  it("streams a simple assistant response via chat.delta and chat.done", async () => {
    const assistantStep = makeStep("assistant", "Hello from the server!");

    mockStreamOllama.mockImplementation(async (args) => {
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const messagesPromise = collectMessages(
        ws,
        (msgs) => msgs.some((m) => m.type === "chat.done")
      );

      sendJson(ws, makeChatSend());
      const messages = await messagesPromise;

      const deltas = messages.filter((m) => m.type === "chat.delta");
      const done = messages.find((m) => m.type === "chat.done");

      expect(deltas.length).toBeGreaterThanOrEqual(1);
      expect(deltas[0].steps?.[0]?.content).toBe("Hello from the server!");

      expect(done).toBeDefined();
      expect(done!.steps).toHaveLength(1);
      expect(done!.steps![0].kind).toBe("assistant");
      expect(done!.steps![0].content).toBe("Hello from the server!");
    } finally {
      ws.close();
    }
  });

  it("streams reasoning and assistant steps", async () => {
    const reasoningStep = makeStep("reasoning", "Thinking about the question...");
    const assistantStep = makeStep("assistant", "Here is my answer.");

    mockStreamOllama.mockImplementation(async (args) => {
      args.onDelta([reasoningStep, assistantStep]);
      return [reasoningStep, assistantStep];
    });

    const ws = await connectClient();
    try {
      const donePromise = waitForMessage(ws, (m) => m.type === "chat.done");
      sendJson(ws, makeChatSend());
      const done = await donePromise;

      expect(done.steps).toHaveLength(2);
      expect(done.steps![0].kind).toBe("reasoning");
      expect(done.steps![0].content).toBe("Thinking about the question...");
      expect(done.steps![1].kind).toBe("assistant");
      expect(done.steps![1].content).toBe("Here is my answer.");
    } finally {
      ws.close();
    }
  });

  it("forwards reasoningEffort from chat.send to the LLM router", async () => {
    const assistantStep = makeStep("assistant", "Reasoned response.");

    mockStreamOllama.mockImplementation(async (args) => {
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const donePromise = waitForMessage(ws, (m) => m.type === "chat.done");
      sendJson(ws, makeChatSend({ reasoningEffort: "high" }));
      await donePromise;

      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamOllama.mock.calls[0][0];
      expect(callArgs.reasoningEffort).toBe("high");
    } finally {
      ws.close();
    }
  });

  it("omits reasoningEffort when chat.send does not provide one", async () => {
    const assistantStep = makeStep("assistant", "Plain response.");

    mockStreamOllama.mockImplementation(async (args) => {
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const donePromise = waitForMessage(ws, (m) => m.type === "chat.done");
      sendJson(ws, makeChatSend());
      await donePromise;

      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
      const callArgs = mockStreamOllama.mock.calls[0][0];
      expect(callArgs.reasoningEffort).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  it("preserves conversationId in all response messages", async () => {
    const conversationId = "conv-id-test-123";
    const assistantStep = makeStep("assistant", "Ack.");

    mockStreamOllama.mockImplementation(async (args) => {
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const messagesPromise = collectMessages(
        ws,
        (msgs) => msgs.some((m) => m.type === "chat.done")
      );

      sendJson(ws, makeChatSend({ conversationId }));
      const messages = await messagesPromise;

      for (const msg of messages) {
        expect(msg.conversationId).toBe(conversationId);
      }
    } finally {
      ws.close();
    }
  });

  it.each([[], undefined])("rejects disabled calls with tools=%j before dispatch", async (tools) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not execute"));
    mockStreamOllama.mockResolvedValue([makeStep("tool_call", "", {
      toolCall: { id: "blocked", name: "curl", arguments: { url: "https://example.com" } },
    })]);
    const ws = await connectClient();
    try {
      const error = waitForMessage(ws, (m) => m.type === "chat.error");
      sendJson(ws, makeChatSend({ tools, steps: [makeStep("assistant", "", {
        toolCalls: [{ id: "old", name: "curl", arguments: { url: "https://example.com" } }],
      })] }));
      expect((await error).message).toContain("Tool is not enabled for this request: curl");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
    } finally {
      ws.close();
    }
  });

  it("reports an enabled but unavailable tool without continuing the provider loop", async () => {
    mockStreamOllama.mockResolvedValue([makeStep("tool_call", "", {
      toolCall: { name: "missing_tool", arguments: {} },
    })]);
    const ws = await connectClient();
    try {
      const error = waitForMessage(ws, (m) => m.type === "chat.error");
      sendJson(ws, makeChatSend({ tools: [{ name: "missing_tool", description: "", parameters: {} }] }));
      expect((await error).message).toContain("Tool is not available on this server: missing_tool");
      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
    } finally {
      ws.close();
    }
  });

  it.each(["stop", "disconnect"])("cancels an in-flight tool and prevents the next action on %s", async (action) => {
    let release!: (response: Response) => void;
    let requestSignal: AbortSignal | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      requestSignal = options?.signal as AbortSignal;
      // Deliberately ignore abort until released, modelling a late tool completion.
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    mockStreamOllama.mockResolvedValue(["first", "second"].map((id) => makeStep("tool_call", "", {
      toolCall: { id, name: "curl", arguments: { url: `https://example.com/${id}` } },
    })));
    const ws = await connectClient();
    try {
      const conversationId = `cancel-${action}`;
      sendJson(ws, makeChatSend({ conversationId, tools: new CurlExecutor().getToolDefinitions() }));
      await vi.waitFor(() => expect(requestSignal).toBeDefined());
      if (action === "stop") sendJson(ws, { type: "chat.stop", conversationId });
      else ws.close();
      await vi.waitFor(() => expect(requestSignal!.aborted).toBe(true));
      release(new Response("late result", { headers: { "content-type": "text/plain" } }));
      // Allow the ignored-abort promise to finish and the sequential loop to advance.
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
    } finally {
      ws.close();
    }
  });

  it("terminates repeated tool calls at the model budget and preserves completed results", async () => {
    mockBraveSearchFetch();
    mockStreamOllama.mockImplementation(async () => [makeStep("tool_call", "", {
      toolCall: { name: "web_search", arguments: { query: "repeat" } },
    })]);
    const ws = await connectClient();
    try {
      const received = collectMessages(ws, (messages) => messages.some((m) => m.type === "chat.error"));
      sendJson(ws, makeChatSend({ tools: new WebSearchExecutor().getToolDefinitions() }));
      const messages = await received;
      expect(messages.at(-1)?.message).toContain("Execution budget exceeded");
      expect(mockStreamOllama).toHaveBeenCalledTimes(MAX_MODEL_INVOCATIONS);
      const completed = messages.flatMap((m) => m.steps ?? []).filter((s) => s.kind === "tool_result" && s.title.startsWith("Result:"));
      expect(completed).toHaveLength(MAX_MODEL_INVOCATIONS);
    } finally { ws.close(); }
  });

  it("rejects a batch exceeding the remaining action budget before any side effects", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    mockStreamOllama.mockResolvedValue(Array.from({ length: MAX_TOOL_CALLS + 1 }, (_, index) => makeStep("tool_call", "", {
      toolCall: { id: String(index), name: "curl", arguments: { url: "https://example.com" } },
    })));
    const ws = await connectClient();
    try {
      const error = waitForMessage(ws, (m) => m.type === "chat.error");
      sendJson(ws, makeChatSend({ tools: new CurlExecutor().getToolDefinitions() }));
      expect((await error).message).toContain(`${MAX_TOOL_CALLS} tool calls`);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(mockStreamOllama).toHaveBeenCalledTimes(1);
    } finally { ws.close(); }
  });

  // ── Tool loop ────────────────────────────────────────────────────

  it("executes the tool loop when Ollama returns tool calls", async () => {
    mockBraveSearchFetch();
    let ollamaCallCount = 0;

    // First call: Ollama returns a tool_call for web_search
    // Second call: Ollama returns a plain assistant response
    mockStreamOllama.mockImplementation(async (args) => {
      ollamaCallCount++;

      if (ollamaCallCount === 1) {
        const toolCallStep = makeStep("tool_call", "Requested web_search", {
          toolCall: {
            name: "web_search",
            arguments: { query: "test query" },
          },
        });
        args.onDelta([toolCallStep]);
        return [toolCallStep];
      }

      const assistantStep = makeStep(
        "assistant",
        "Based on the search results, here is the answer."
      );
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const messagesPromise = collectMessages(
        ws,
        (msgs) => msgs.some((m) => m.type === "chat.done")
      );

      sendJson(ws, makeChatSend({ tools: new WebSearchExecutor().getToolDefinitions() }));
      const messages = await messagesPromise;

      // Ollama should have been called twice (tool loop)
      expect(ollamaCallCount).toBe(2);

      // Meta events should have been emitted for tool dispatch
      const metaEvents = messages.filter((m) => m.type === "meta.event");
      expect(metaEvents.length).toBeGreaterThanOrEqual(1);

      // WebSearchExecutor emits search_start and search_result meta events
      const searchEvents = metaEvents.filter(
        (m) =>
          (m.event as Record<string, unknown>)?.kind === "search_start" ||
          (m.event as Record<string, unknown>)?.kind === "search_result"
      );
      expect(searchEvents.length).toBe(2);

      // Final chat.done should include assistant (with merged toolCalls) + tool_result + final assistant
      const done = messages.find((m) => m.type === "chat.done");
      expect(done).toBeDefined();

      const stepKinds = done!.steps!.map((s) => s.kind);
      expect(stepKinds).toContain("tool_result");
      expect(stepKinds).toContain("assistant");

      // Tool calls are merged into the assistant step's toolCalls array
      const assistantWithTools = done!.steps!.find(
        (s) => s.kind === "assistant" && s.toolCalls?.length
      );
      expect(assistantWithTools).toBeDefined();
      expect(assistantWithTools!.toolCalls![0].name).toBe("web_search");

      // Tool result should contain search output
      const toolResult = done!.steps!.find((s) => s.kind === "tool_result");
      expect(toolResult?.content).toContain("Example Result");
    } finally {
      ws.close();
    }
  });

  it("passes tool_call and tool_result steps back to Ollama on the second call", async () => {
    mockBraveSearchFetch();
    let secondCallSteps: ConversationStep[] = [];
    let ollamaCallCount = 0;

    mockStreamOllama.mockImplementation(async (args) => {
      ollamaCallCount++;

      if (ollamaCallCount === 1) {
        const toolCallStep = makeStep("tool_call", "Requested web_search", {
          toolCall: {
            name: "web_search",
            arguments: { query: "verify-steps" },
          },
        });
        args.onDelta([toolCallStep]);
        return [toolCallStep];
      }

      // Capture the steps passed to the second Ollama call
      secondCallSteps = args.steps;

      const assistantStep = makeStep("assistant", "Done.");
      args.onDelta([assistantStep]);
      return [assistantStep];
    });

    const ws = await connectClient();
    try {
      const donePromise = waitForMessage(ws, (m) => m.type === "chat.done");
      sendJson(ws, makeChatSend({ tools: new WebSearchExecutor().getToolDefinitions() }));
      await donePromise;

      // The second call should include original steps + assistant (with toolCalls) + tool_result
      const kinds = secondCallSteps.map((s) => s.kind);
      expect(kinds).toContain("system");
      expect(kinds).toContain("user");
      expect(kinds).toContain("assistant");
      expect(kinds).toContain("tool_result");

      // Tool calls are merged into the assistant step
      const assistantWithTools = secondCallSteps.find(
        (s) => s.kind === "assistant" && s.toolCalls?.length
      );
      expect(assistantWithTools).toBeDefined();
      expect(assistantWithTools!.toolCalls![0].name).toBe("web_search");
    } finally {
      ws.close();
    }
  });

  // ── Error handling ───────────────────────────────────────────────

  it("sends chat.error when Ollama throws", async () => {
    mockStreamOllama.mockRejectedValue(new Error("Ollama request failed: 503"));

    const ws = await connectClient();
    try {
      const errorPromise = waitForMessage(ws, (m) => m.type === "chat.error");
      sendJson(ws, makeChatSend());
      const error = await errorPromise;

      expect(error.type).toBe("chat.error");
      expect(error.message).toBe("Ollama request failed: 503");
    } finally {
      ws.close();
    }
  });

  it("does not send chat.error when stream is aborted via chat.stop", async () => {
    // Make Ollama hang until aborted
    mockStreamOllama.mockImplementation(async (args) => {
      return new Promise((_, reject) => {
        args.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });

    const ws = await connectClient();
    try {
      const chatSend = makeChatSend();
      sendJson(ws, chatSend);

      // Give the handler a moment to start processing
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send stop
      sendJson(ws, {
        type: "chat.stop",
        conversationId: chatSend.conversationId,
      });

      // Wait briefly for any messages
      const received: ParsedMessage[] = [];
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500);
        function onMessage(raw: Buffer | ArrayBuffer | Buffer[]) {
          const msg = JSON.parse(raw.toString()) as ParsedMessage;
          received.push(msg);
        }
        ws.on("message", onMessage);
        setTimeout(() => {
          ws.off("message", onMessage);
          clearTimeout(timer);
          resolve();
        }, 500);
      });

      // Should NOT have a chat.error (abort is silent)
      const chatError = received.find((m) => m.type === "chat.error");
      expect(chatError).toBeUndefined();

      // Should NOT have a chat.done (stream was aborted)
      const chatDone = received.find((m) => m.type === "chat.done");
      expect(chatDone).toBeUndefined();
    } finally {
      ws.close();
    }
  });

  // ── Edge cases ───────────────────────────────────────────────────

  it("ignores malformed JSON messages without crashing", async () => {
    const ws = await connectClient();
    try {
      // Send garbage
      ws.send("not valid json {{{");

      // Server should still respond to a valid ping
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      sendJson(ws, { type: "ping" });
      const pong = await pongPromise;
      expect(pong.type).toBe("pong");
    } finally {
      ws.close();
    }
  });

  it("ignores unknown message types without crashing", async () => {
    const ws = await connectClient();
    try {
      sendJson(ws, { type: "unknown.message", data: "test" });

      // Should still respond to ping
      const pongPromise = waitForMessage(ws, (m) => m.type === "pong");
      sendJson(ws, { type: "ping" });
      const pong = await pongPromise;
      expect(pong.type).toBe("pong");
    } finally {
      ws.close();
    }
  });

  it("handles concurrent conversations independently", async () => {
    const responses: Record<string, string> = {
      "conv-a": "Response for conversation A",
      "conv-b": "Response for conversation B",
    };

    mockStreamOllama.mockImplementation(async (args) => {
      // Find the conversationId from the calling context by checking user step content
      const userStep = args.steps.find(
        (s: ConversationStep) => s.kind === "user"
      );
      const convId = userStep?.content === "Hello A" ? "conv-a" : "conv-b";
      const step = makeStep("assistant", responses[convId]);
      args.onDelta([step]);
      return [step];
    });

    const ws = await connectClient();
    try {
      const allDonePromise = collectMessages(
        ws,
        (msgs) => msgs.filter((m) => m.type === "chat.done").length === 2
      );

      sendJson(ws, {
        ...makeChatSend({ conversationId: "conv-a" }),
        steps: [makeStep("system", ""), makeStep("user", "Hello A")],
      });

      sendJson(ws, {
        ...makeChatSend({ conversationId: "conv-b" }),
        steps: [makeStep("system", ""), makeStep("user", "Hello B")],
      });

      const messages = await allDonePromise;
      const doneMessages = messages.filter((m) => m.type === "chat.done");

      const doneA = doneMessages.find((m) => m.conversationId === "conv-a");
      const doneB = doneMessages.find((m) => m.conversationId === "conv-b");

      expect(doneA).toBeDefined();
      expect(doneA!.steps![0].content).toBe("Response for conversation A");

      expect(doneB).toBeDefined();
      expect(doneB!.steps![0].content).toBe("Response for conversation B");
    } finally {
      ws.close();
    }
  });
});
