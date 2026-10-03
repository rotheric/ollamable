/** useChatGeneration settle signal (epic-compaction-tool S2): one bump per owned generation, however it ends. */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatGeneration } from "@/src/lib/use-chat-generation";
import { createConversation } from "@/src/lib/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import type { Conversation, ConversationStep } from "@/src/types/chat";

function setup(promise: Promise<never[]>, stop = vi.fn()) {
  const backendClient = { startStream: vi.fn(() => ({ promise, stop })) } as unknown as BackendClient;
  return renderHook(() =>
    useChatGeneration({
      backendClient,
      send: () => true,
      connected: true,
      availableModels: [],
      updateConversation: vi.fn(),
      defaultExpanded: () => false,
      setError: vi.fn(),
    })
  );
}

const conversation = createConversation("a:latest", [], "ollama");

describe("useChatGeneration settledCount", () => {
  it("increments exactly once when the generation completes", async () => {
    const { result } = setup(Promise.resolve([]));
    await act(async () => result.current.streamConversationResponse(conversation));
    expect(result.current.settledCount).toBe(1);
    expect(result.current.streaming).toBe(false);
  });

  it("increments exactly once when the generation is stopped", async () => {
    const { result } = setup(Promise.reject(new Error("AbortError")));
    await act(async () => result.current.streamConversationResponse(conversation));
    expect(result.current.settledCount).toBe(1);
  });

  it("increments exactly once when the generation fails", async () => {
    const { result } = setup(Promise.reject(new Error("boom")));
    await act(async () => result.current.streamConversationResponse(conversation));
    expect(result.current.settledCount).toBe(1);
  });

  it("does not increment for a generation superseded before it settles", async () => {
    let resolveA!: (steps: never[]) => void;
    let resolveB!: (steps: never[]) => void;
    const first = new Promise<never[]>((resolve) => { resolveA = resolve; });
    const second = new Promise<never[]>((resolve) => { resolveB = resolve; });
    const startStream = vi.fn()
      .mockReturnValueOnce({ promise: first, stop: vi.fn() })
      .mockReturnValueOnce({ promise: second, stop: vi.fn() });
    const backendClient = { startStream } as unknown as BackendClient;
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: true, availableModels: [],
        updateConversation: vi.fn(), defaultExpanded: () => false, setError: vi.fn(),
      })
    );

    let runA!: Promise<void>;
    let runB!: Promise<void>;
    act(() => { runA = result.current.streamConversationResponse(conversation); });
    act(() => { runB = result.current.streamConversationResponse(conversation); });

    await act(async () => { resolveA([]); await runA; });
    expect(result.current.settledCount).toBe(0);
    expect(result.current.streaming).toBe(true);

    await act(async () => { resolveB([]); await runB; });
    expect(result.current.settledCount).toBe(1);
    expect(result.current.streaming).toBe(false);
  });

  it("does not increment when the backend is not connected", async () => {
    const backendClient = { startStream: vi.fn() } as unknown as BackendClient;
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: false, availableModels: [],
        updateConversation: vi.fn(), defaultExpanded: () => false, setError: vi.fn(),
      })
    );
    await act(async () => result.current.streamConversationResponse(conversation));
    expect(result.current.settledCount).toBe(0);
  });
});

describe("useChatGeneration request context records", () => {
  it("records the inputs that determine the note (not its text) at the sent step count", async () => {
    const backendClient = { startStream: vi.fn(() => ({ promise: Promise.resolve([]), stop: vi.fn() })) } as unknown as BackendClient;
    let stored = createConversation("a:latest", [], "ollama");
    stored = {
      ...stored,
      availableTools: [{ id: "c", name: "compact_context", description: "", inputSchema: "{}" }],
      activeToolIds: ["c"],
      steps: [{ id: "u", kind: "user", title: "", content: "hi", createdAt: "2026-01-01T00:00:00.000Z" }],
      requestContexts: [
        { startIndex: 0, compactEnabled: false },
        { startIndex: 1, compactEnabled: true },
        { startIndex: 5, compactEnabled: true },
      ],
    };
    const updateConversation = vi.fn((_id: string, updater: (c: typeof stored) => typeof stored) => { stored = updater(stored); });
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: true, availableModels: [],
        updateConversation, defaultExpanded: () => false, setError: vi.fn(),
        getContextRequest: () => ({ contextWindow: 8192, contextWindowSource: "estimated", modelFamily: "llama" }),
      })
    );
    await act(async () => result.current.streamConversationResponse(stored));
    expect(stored.requestContexts).toEqual([
      { startIndex: 0, compactEnabled: false },
      { startIndex: 1, compactEnabled: true, contextWindow: { tokens: 8192, source: "estimated" }, modelFamily: "llama" },
    ]);
    expect(JSON.stringify(stored.requestContexts)).not.toContain("Automatic note");
  });
});

describe("useChatGeneration fork on compaction", () => {
  const compactTool = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
  const searchTool = { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" };
  const payload = { toolCallStepId: "tc-1", summary: "SUM", remainingWork: "RW" };
  const original: Conversation = {
    ...createConversation("a:latest", [compactTool, searchTool], "ollama"),
    id: "original",
    title: "Notes",
    activeToolIds: [compactTool.id, searchTool.id],
  };
  const toolCallStep = { id: "tc-1", kind: "tool_call" as const, title: "Tool Call", content: "", createdAt: "t" };

  interface Deferred { promise: Promise<ConversationStep[]>; resolve: (steps: ConversationStep[]) => void; reject: (error: Error) => void; stop: ReturnType<typeof vi.fn> }
  function deferred(): Deferred {
    let resolve!: Deferred["resolve"];
    let reject!: Deferred["reject"];
    const promise = new Promise<ConversationStep[]>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject, stop: vi.fn() };
  }

  function setupFork(streams: Deferred[], extra: { getContextRequest?: () => Record<string, unknown> } = {}) {
    const events: string[] = [];
    const startStream = vi.fn();
    streams.forEach((stream) => startStream.mockImplementationOnce((_send: unknown, request: { conversationId: string; onCompaction?: (p: typeof payload) => void }) => {
      events.push(`stream:${request.conversationId}`);
      return { promise: stream.promise, stop: stream.stop };
    }));
    const onFork = vi.fn((fork: Conversation) => { events.push(`fork:${fork.id}`); });
    const updateConversation = vi.fn((id: string, updater: (c: Conversation) => Conversation) => {
      const probe = updater({ ...original, steps: [original.steps[0]] });
      events.push(`update:${id}:${probe.steps.map((s) => s.kind).join(",")}`);
    });
    const hook = renderHook(() =>
      useChatGeneration({
        backendClient: { startStream } as unknown as BackendClient,
        send: () => true, connected: true, availableModels: [], updateConversation,
        defaultExpanded: () => false, setError: vi.fn(), onFork, ...extra,
      })
    );
    const deliver = (n = 0) => (startStream.mock.calls[n][1] as { onCompaction: (p: typeof payload) => void }).onCompaction(payload);
    return { ...hook, startStream, onFork, updateConversation, events, deliver };
  }

  it("applies the original's chat.done steps, then the harness step, then the fork - and sends nothing for the fork", async () => {
    const first = deferred();
    const { result, startStream, onFork, events, deliver } = setupFork([first]);
    let run!: Promise<void>;
    act(() => { run = result.current.streamConversationResponse(original); });
    deliver();
    await act(async () => { first.resolve([toolCallStep]); await run; });

    expect(onFork).toHaveBeenCalledTimes(1);
    const fork = onFork.mock.calls[0][0];
    expect(fork.forkedFrom).toEqual({ conversationId: "original", stepId: "tc-1" });
    // original steps applied, then the harness step on the original, then the fork in state.
    const originalApply = events.findIndex((e) => e === "update:original:system,tool_call");
    const harness = events.findIndex((e) => e === "update:original:system,meta");
    expect(originalApply).toBeGreaterThan(-1);
    expect(harness).toBeGreaterThan(originalApply);
    expect(events.indexOf(`fork:${fork.id}`)).toBeGreaterThan(harness);
    // No stream for the fork: the user's first message there is a normal send.
    expect(startStream).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.startsWith(`stream:${fork.id}`))).toBe(false);
  });

  it("settles the original normally: streaming ends and settledCount rises exactly once", async () => {
    const first = deferred();
    const { result, deliver } = setupFork([first]);
    let run!: Promise<void>;
    act(() => { run = result.current.streamConversationResponse(original); });
    deliver();
    await act(async () => { first.resolve([toolCallStep]); await run; });
    expect(result.current.streaming).toBe(false);
    expect(result.current.settledCount).toBe(1);
  });

  it("never forks when the original is stopped or fails after the payload was delivered", async () => {
    for (const error of [new Error("AbortError"), new Error("boom")]) {
      const first = deferred();
      const { result, deliver, onFork, startStream } = setupFork([first]);
      let run!: Promise<void>;
      act(() => { run = result.current.streamConversationResponse(original); });
      deliver();
      await act(async () => { first.reject(error); await run; });
      expect(onFork).not.toHaveBeenCalled();
      expect(startStream).toHaveBeenCalledTimes(1);
    }
  });

  it("never forks when the original was superseded by another generation before its response arrived", async () => {
    const first = deferred();
    const other = deferred();
    const { result, deliver, onFork, startStream } = setupFork([first, other]);
    let run!: Promise<void>;
    act(() => { run = result.current.streamConversationResponse(original); });
    deliver();
    act(() => { void result.current.streamConversationResponse({ ...original, id: "other" }); });
    await act(async () => { first.resolve([toolCallStep]); await run; });
    expect(onFork).not.toHaveBeenCalled();
    expect(startStream).toHaveBeenCalledTimes(2);
  });

  it("does not fork a response that carried no compaction payload", async () => {
    const first = deferred();
    const { result, onFork } = setupFork([first]);
    let run!: Promise<void>;
    act(() => { run = result.current.streamConversationResponse(original); });
    await act(async () => { first.resolve([toolCallStep]); await run; });
    expect(onFork).not.toHaveBeenCalled();
  });
});

describe("useChatGeneration request inputs and quiet completions (mutation audit)", () => {
  const compactTool = { id: "compact-context", name: "compact_context", description: "d", inputSchema: "{}" };
  const searchTool = { id: "web-search", name: "web_search", description: "d", inputSchema: "{}" };

  function run(conv: Conversation, deps: { getContextRequest?: () => Record<string, unknown>; onFork?: (fork: Conversation) => void; compaction?: boolean } = {}) {
    let stored = conv;
    const setError = vi.fn();
    const updateConversation = vi.fn((_id: string, updater: (c: Conversation) => Conversation) => { stored = updater(stored); });
    const startStream = vi.fn((_send: unknown, request: { onCompaction?: (p: unknown) => void }) => {
      if (deps.compaction) request.onCompaction?.({ toolCallStepId: "tc", summary: "S" });
      return { promise: Promise.resolve([]), stop: vi.fn() };
    });
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient: { startStream } as unknown as BackendClient,
        send: () => true, connected: true, availableModels: [], updateConversation,
        defaultExpanded: () => false, setError, getContextRequest: deps.getContextRequest as never, onFork: deps.onFork,
      })
    );
    return { result, startStream, setError, stored: () => stored };
  }

  it("sends only the conversation's active tools and records compactEnabled from them", async () => {
    const conv = { ...createConversation("a:latest", [compactTool, searchTool], "ollama"), activeToolIds: [searchTool.id] };
    const { result, startStream, stored } = run(conv);
    await act(async () => result.current.streamConversationResponse(conv));
    expect((startStream.mock.calls[0][1] as unknown as { tools: { id: string }[] }).tools.map((t) => t.id)).toEqual([searchTool.id]);
    expect(stored().requestContexts?.at(-1)?.compactEnabled).toBe(false);
  });

  it.each([
    ["a window without its source", { contextWindow: 8192 }],
    ["a source without its window", { contextWindowSource: "runtime" }],
  ])("records no window for %s", async (_name, contextRequest) => {
    const conv = createConversation("a:latest", [], "ollama");
    const { result, stored } = run(conv, { getContextRequest: () => contextRequest });
    await act(async () => result.current.streamConversationResponse(conv));
    expect(stored().requestContexts?.at(-1)?.contextWindow).toBeUndefined();
  });

  it("a plain completion with a fork handler reports no error and appends no harness step", async () => {
    const conv = createConversation("a:latest", [], "ollama");
    const onFork = vi.fn();
    const { result, setError, stored } = run(conv, { onFork });
    await act(async () => result.current.streamConversationResponse(conv));
    expect(setError.mock.calls).toEqual([[""]]);
    expect(onFork).not.toHaveBeenCalled();
    expect(stored().steps.some((s) => s.kind === "meta")).toBe(false);
  });

  it("a compaction payload without a fork handler is ignored quietly", async () => {
    const conv = createConversation("a:latest", [], "ollama");
    const { result, setError, stored } = run(conv, { compaction: true });
    await act(async () => result.current.streamConversationResponse(conv));
    expect(setError.mock.calls).toEqual([[""]]);
    expect(stored().steps.some((s) => s.kind === "meta")).toBe(false);
  });
});
