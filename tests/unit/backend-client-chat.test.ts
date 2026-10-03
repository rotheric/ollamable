import { describe, expect, it, vi } from "vitest";
import { BackendClient } from "@/src/lib/backend-client";

function request() {
  return { conversationId: "conversation", model: "model", steps: [], tools: [],
    onDelta: vi.fn(), onStableSteps: vi.fn(), onMetaEvent: vi.fn() };
}

describe("chat transport lifecycle", () => {
  it.each(["false", "throw"])("rejects and removes pending chat when send returns %s", async (mode) => {
    const client = new BackendClient();
    const callbacks = request();
    const send = () => { if (mode === "throw") throw new Error("broken transport"); return false; };
    const stream = client.startStream(send, callbacks);
    await expect(stream.promise).rejects.toThrow(mode === "throw" ? "broken transport" : "socket not open");
    client.handleServerMessage({ type: "chat.delta", conversationId: callbacks.conversationId, steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    expect(() => stream.stop()).not.toThrow();
  });

  it("rejects chat distinctly on disconnect, clears tokenization timers, and permits manual retry", async () => {
    const client = new BackendClient();
    const callbacks = request();
    const old = client.startStream(() => true, callbacks);
    const tokenize = client.tokenize(() => true, "model", "text");
    client.connectionClosed();
    await expect(old.promise).rejects.toMatchObject({
      name: "ConnectionLostError",
      // Shown to the user as is.
      message: "Backend connection lost. Partial response kept; reconnect and retry manually.",
    });
    await expect(tokenize).rejects.toThrow("AbortError");
    client.handleServerMessage({ type: "chat.delta", conversationId: callbacks.conversationId, steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    const send = vi.fn((_message: unknown) => true);
    const retry = client.startStream(send, callbacks);
    client.handleServerMessage({ type: "chat.done", conversationId: callbacks.conversationId,
      requestId: (send.mock.calls[0][0] as { requestId: string }).requestId, steps: [] });
    await expect(retry.promise).resolves.toEqual([]);
  });
  it("ignores old generation messages and stop callbacks after replacement", async () => {
    const client = new BackendClient();
    const send = vi.fn((_message: unknown) => true);
    const older = client.startStream(send, request());
    const oldFailure = expect(older.promise).rejects.toThrow("superseded");
    const callbacks = request();
    const newer = client.startStream(send, callbacks);
    await oldFailure;
    const oldId = (send.mock.calls[0][0] as { requestId: string }).requestId;
    const newId = (send.mock.calls[1][0] as { requestId: string }).requestId;
    expect(oldId).not.toBe(newId);
    older.stop();
    expect(send).toHaveBeenCalledTimes(2);
    for (const type of ["chat.delta", "chat.steps", "chat.done", "chat.error", "meta.event"]) {
      client.handleServerMessage({ type, requestId: oldId, conversationId: "conversation", steps: [], message: "late error" });
    }
    expect(callbacks.onDelta).not.toHaveBeenCalled();
    expect(callbacks.onStableSteps).not.toHaveBeenCalled();
    expect(callbacks.onMetaEvent).not.toHaveBeenCalled();
    client.handleServerMessage({ type: "chat.delta", requestId: newId, conversationId: "conversation", steps: [] });
    expect(callbacks.onDelta).toHaveBeenCalledOnce();
    client.handleServerMessage({ type: "chat.done", requestId: newId, conversationId: "conversation", steps: [] });
    await expect(newer.promise).resolves.toEqual([]);
  });
});

describe("chat message routing", () => {
  /** Starts a stream and returns what a test needs to drive it from the server side. */
  function start(overrides: Partial<Parameters<BackendClient["startStream"]>[1]> = {}) {
    const client = new BackendClient();
    const callbacks = { ...request(), ...overrides };
    const send = vi.fn((_message: unknown) => true);
    const stream = client.startStream(send, callbacks);
    const sent = send.mock.calls[0][0] as Record<string, unknown>;
    const fromServer = (message: Record<string, unknown>) =>
      client.handleServerMessage({ conversationId: callbacks.conversationId, requestId: sent.requestId, ...message });
    return { client, callbacks, send, stream, sent, fromServer };
  }

  it("sends one chat.send carrying the conversation, model, steps, tools and settings", () => {
    const steps = [{ id: "u1", kind: "user" as const, title: "User", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" }];
    const tools = [{ id: "curl", name: "curl", description: "Fetch", inputSchema: "{}" }];
    const { send, sent } = start({
      provider: "ollama", steps, tools, temperature: 0.6, maxOutputTokens: 100,
      reasoningEffort: "low", maxModelInvocations: 4, maxToolCalls: 8,
    });

    expect(send).toHaveBeenCalledOnce();
    expect(sent).toEqual({
      type: "chat.send", requestId: expect.any(String), conversationId: "conversation", model: "model",
      provider: "ollama", steps, tools, temperature: 0.6, maxOutputTokens: 100,
      reasoningEffort: "low", maxModelInvocations: 4, maxToolCalls: 8,
    });
    expect(sent.requestId).not.toBe("");
  });

  it("carries the resolved context window, its source and the model family in chat.send", () => {
    const { sent } = start({ contextWindow: 8192, contextWindowSource: "runtime", modelFamily: "qwen3" });
    expect(sent).toMatchObject({ type: "chat.send", contextWindow: 8192, contextWindowSource: "runtime", modelFamily: "qwen3" });
  });

  it("omits the context fields when none were resolved", () => {
    const { sent } = start();
    expect(JSON.parse(JSON.stringify(sent))).not.toHaveProperty("contextWindow");
    expect(JSON.parse(JSON.stringify(sent))).not.toHaveProperty("modelFamily");
  });

  it("routes deltas and stable steps to their own callbacks without settling the stream", async () => {
    const { callbacks, stream, fromServer } = start();
    const partial = [{ id: "a", kind: "assistant", content: "He" }];
    const stable = [{ id: "tc", kind: "tool_call", content: "" }];

    fromServer({ type: "chat.delta", steps: partial });
    fromServer({ type: "chat.steps", steps: stable });

    expect(callbacks.onDelta).toHaveBeenCalledExactlyOnceWith(partial);
    expect(callbacks.onStableSteps).toHaveBeenCalledExactlyOnceWith(stable);
    expect(callbacks.onMetaEvent).not.toHaveBeenCalled();
    const settled = vi.fn();
    void stream.promise.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
  });

  it("hands the chat.done compaction payload to onCompaction unchanged, before the stream resolves", async () => {
    const onCompaction = vi.fn();
    const { stream, fromServer } = start({ onCompaction });
    const final = [{ id: "tc", kind: "tool_call", content: "" }];
    const compaction = { toolCallStepId: "tc", summary: "S", remainingWork: "R" };
    const order: string[] = [];
    onCompaction.mockImplementation(() => order.push("compaction"));
    void stream.promise.then(() => order.push("resolved"));

    fromServer({ type: "chat.done", steps: final, compaction });

    await expect(stream.promise).resolves.toEqual(final);
    expect(onCompaction).toHaveBeenCalledExactlyOnceWith(compaction);
    expect(onCompaction.mock.calls[0][0]).toBe(compaction);
    expect(order).toEqual(["compaction", "resolved"]);
  });

  it("still resolves the stream when onCompaction throws", async () => {
    const onCompaction = vi.fn(() => { throw new Error("consumer bug"); });
    const { stream, fromServer } = start({ onCompaction });
    expect(() => fromServer({ type: "chat.done", steps: [], compaction: { toolCallStepId: "x", summary: "S" } })).toThrow("consumer bug");
    await expect(stream.promise).resolves.toEqual([]);
  });

  it("does not call onCompaction for a chat.done without compaction, and tolerates a missing callback", async () => {
    const onCompaction = vi.fn();
    const withCallback = start({ onCompaction });
    withCallback.fromServer({ type: "chat.done", steps: [] });
    await expect(withCallback.stream.promise).resolves.toEqual([]);
    expect(onCompaction).not.toHaveBeenCalled();

    const without = start();
    without.fromServer({ type: "chat.done", steps: [], compaction: { toolCallStepId: "x", summary: "S" } });
    await expect(without.stream.promise).resolves.toEqual([]);
  });

  it("resolves with the final steps on chat.done and stops listening afterwards", async () => {
    const { callbacks, stream, fromServer } = start();
    const final = [{ id: "a", kind: "assistant", content: "Hello" }];

    fromServer({ type: "chat.done", steps: final });

    await expect(stream.promise).resolves.toEqual(final);
    fromServer({ type: "chat.delta", steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
  });

  it("rejects with the server message on chat.error, or a generic one when none is given", async () => {
    const withMessage = start();
    withMessage.fromServer({ type: "chat.error", message: "Execution budget exhausted" });
    await expect(withMessage.stream.promise).rejects.toThrow("Execution budget exhausted");

    const without = start();
    without.fromServer({ type: "chat.error" });
    await expect(without.stream.promise).rejects.toThrow("Server error");
  });

  it("turns a meta.event into an expanded meta step for the transcript", () => {
    const { callbacks, fromServer } = start();

    fromServer({
      type: "meta.event",
      event: {
        id: "42", kind: "mcp_call", title: "MCP Call", detail: "browser_navigate",
        data: { tool: "browser_navigate" }, timestamp: "2026-01-01T00:00:01.000Z", durationMs: 12,
      },
    });

    expect(callbacks.onMetaEvent).toHaveBeenCalledExactlyOnceWith({
      id: "meta-42", kind: "meta", title: "MCP Call", content: "browser_navigate",
      createdAt: "2026-01-01T00:00:01.000Z", expanded: true,
      metaEvent: { kind: "mcp_call", title: "MCP Call", detail: "browser_navigate", data: { tool: "browser_navigate" }, durationMs: 12 },
    });
  });

  it.each([
    ["no type", { steps: [] }],
    ["a delta without steps", { type: "chat.delta" }],
    ["stable steps without steps", { type: "chat.steps" }],
    ["a done without steps", { type: "chat.done" }],
    ["a meta.event without an event", { type: "meta.event" }],
  ])("ignores a message with %s", async (_what, message) => {
    const { callbacks, stream, fromServer } = start();

    fromServer(message);

    expect(callbacks.onDelta).not.toHaveBeenCalled();
    expect(callbacks.onStableSteps).not.toHaveBeenCalled();
    expect(callbacks.onMetaEvent).not.toHaveBeenCalled();
    // Still pending: a well-formed chat.done afterwards settles it.
    fromServer({ type: "chat.done", steps: [] });
    await expect(stream.promise).resolves.toEqual([]);
  });

  it("ignores messages for another conversation or without a conversation id", () => {
    const { client, callbacks, sent } = start();

    client.handleServerMessage({ type: "chat.delta", requestId: sent.requestId, conversationId: "other", steps: [] });
    client.handleServerMessage({ type: "chat.delta", requestId: sent.requestId, steps: [] });

    expect(callbacks.onDelta).not.toHaveBeenCalled();
  });

  it("stop() tells the server, rejects with AbortError and stops listening", async () => {
    const { callbacks, send, stream, sent, fromServer } = start();

    stream.stop();

    expect(send).toHaveBeenLastCalledWith({ type: "chat.stop", conversationId: "conversation", requestId: sent.requestId });
    await expect(stream.promise).rejects.toThrow("AbortError");
    fromServer({ type: "chat.delta", steps: [] });
    expect(callbacks.onDelta).not.toHaveBeenCalled();
  });

  it("stop() still rejects locally when the socket is already gone", async () => {
    const client = new BackendClient();
    let open = true;
    const stream = client.startStream(() => { if (!open) throw new Error("socket gone"); return true; }, request());
    open = false;

    expect(() => stream.stop()).not.toThrow();
    await expect(stream.promise).rejects.toThrow("AbortError");
  });

  it("stop() after completion sends nothing", async () => {
    const { send, stream, fromServer } = start();
    fromServer({ type: "chat.done", steps: [] });
    await stream.promise;

    stream.stop();

    expect(send).toHaveBeenCalledOnce();
  });

  it("cancelAll() rejects every pending stream with AbortError and stops listening", async () => {
    const client = new BackendClient();
    const first = { ...request(), conversationId: "one" };
    const second = { ...request(), conversationId: "two" };
    const send = vi.fn((_message: unknown) => true);
    const a = client.startStream(send, first);
    const b = client.startStream(send, second);

    client.cancelAll();

    await expect(a.promise).rejects.toThrow("AbortError");
    await expect(b.promise).rejects.toThrow("AbortError");
    client.handleServerMessage({
      type: "chat.delta", conversationId: "one", steps: [],
      requestId: (send.mock.calls[0][0] as { requestId: string }).requestId,
    });
    expect(first.onDelta).not.toHaveBeenCalled();
  });

  it("keeps streams of different conversations independent", async () => {
    const client = new BackendClient();
    const first = { ...request(), conversationId: "one" };
    const second = { ...request(), conversationId: "two" };
    const send = vi.fn((_message: unknown) => true);
    const a = client.startStream(send, first);
    const b = client.startStream(send, second);
    const idOf = (call: number) => (send.mock.calls[call][0] as { requestId: string }).requestId;

    client.handleServerMessage({ type: "chat.done", conversationId: "two", requestId: idOf(1), steps: [] });
    await expect(b.promise).resolves.toEqual([]);

    client.handleServerMessage({ type: "chat.delta", conversationId: "one", requestId: idOf(0), steps: [] });
    expect(first.onDelta).toHaveBeenCalledOnce();
    expect(second.onDelta).not.toHaveBeenCalled();
    client.handleServerMessage({ type: "chat.done", conversationId: "one", requestId: idOf(0), steps: [] });
    await expect(a.promise).resolves.toEqual([]);
  });
});
