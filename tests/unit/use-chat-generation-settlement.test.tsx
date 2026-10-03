/**
 * `useChatGeneration` settlement and folding, driven with a BackendClient
 * double and a real in-memory conversation store: streamed callbacks fold into
 * the conversation, each failure kind surfaces its own message, only an
 * AbortError marks the conversation as stopped, a superseded generation never
 * settles the UI, and a fresh send clears a previous stop.
 */
import { describe, it, expect, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useChatGeneration } from "@/src/lib/use-chat-generation";
import { createConversation } from "@/src/lib/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import type { Conversation, ConversationStep } from "@/src/types/chat";

interface Controlled {
  promise: Promise<ConversationStep[]>;
  resolve: (steps: ConversationStep[]) => void;
  reject: (error: unknown) => void;
}

function controlled(): Controlled {
  let resolve!: (steps: ConversationStep[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<ConversationStep[]>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type StreamRequest = {
  onDelta: (steps: ConversationStep[]) => void;
  onStableSteps: (steps: ConversationStep[]) => void;
  onMetaEvent: (step: ConversationStep) => void;
};

function store(initial: Conversation) {
  let current = initial;
  const updateConversation = vi.fn((id: string, updater: (c: Conversation) => Conversation) => {
    if (id === current.id) current = updater(current);
  });
  return { get: () => current, updateConversation };
}

const base = createConversation("m", [], "ollama");
const conversation: Conversation = {
  ...base,
  steps: [...base.steps, { id: "u1", kind: "user", title: "User", content: "hi", createdAt: "2026-01-01T00:00:00Z" }],
};

function setup(streams: Controlled[]) {
  const requests: StreamRequest[] = [];
  const startStream = vi.fn((_send: unknown, request: StreamRequest) => {
    requests.push(request);
    const s = streams[requests.length - 1];
    return { promise: s.promise, stop: vi.fn() };
  });
  const backendClient = { startStream } as unknown as BackendClient;
  const conv = store(conversation);
  const setError = vi.fn();
  const hook = renderHook(
    ({ updateConversation }: { updateConversation: typeof conv.updateConversation }) =>
      useChatGeneration({
        backendClient, send: () => true, connected: true, availableModels: [],
        updateConversation, defaultExpanded: () => true, setError,
      }),
    { initialProps: { updateConversation: conv.updateConversation } }
  );
  return { hook, requests, startStream, conv, setError };
}

const lastError = (setError: ReturnType<typeof vi.fn>) => setError.mock.calls.at(-1)?.[0];

describe("streamed callbacks fold into the conversation", () => {
  it("applies deltas, stable steps and meta events as they arrive", async () => {
    const stream = controlled();
    const { hook, requests, conv } = setup([stream]);
    let run!: Promise<void>;
    act(() => { run = hook.result.current.streamConversationResponse(conversation); });

    const tool: ConversationStep = { id: "tc", kind: "tool_call", title: "Call", content: "", createdAt: "2026-01-01T00:00:01Z", toolCall: { id: "k", name: "web_search", arguments: {} } };
    const meta: ConversationStep = { id: "meta-1", kind: "meta", title: "Search", content: "d", createdAt: "2026-01-01T00:00:02Z", metaEvent: { kind: "search_start", title: "Search", detail: "d" } };
    act(() => requests[0].onStableSteps([tool]));
    expect(conv.get().steps.map((s) => s.id)).toContain("tc");
    act(() => requests[0].onMetaEvent(meta));
    expect(conv.get().steps.map((s) => s.id)).toContain("meta-1");
    act(() => requests[0].onDelta([{ id: "stream-a", kind: "assistant", title: "Assistant", content: "partial", createdAt: "2026-01-01T00:00:03Z" }]));
    expect(conv.get().steps.some((s) => s.kind === "assistant" && s.content === "partial")).toBe(true);

    await act(async () => { stream.resolve([]); await run; });
  });

  it("folds into the conversation through the latest updateConversation", async () => {
    const stream = controlled();
    const { hook, requests, conv } = setup([stream]);
    const replacement = vi.fn(conv.updateConversation);
    hook.rerender({ updateConversation: replacement });
    let run!: Promise<void>;
    act(() => { run = hook.result.current.streamConversationResponse(conversation); });
    replacement.mockClear();
    act(() => requests[0].onDelta([{ id: "stream-a", kind: "assistant", title: "Assistant", content: "x", createdAt: "2026-01-01T00:00:03Z" }]));
    expect(replacement).toHaveBeenCalledOnce();
    await act(async () => { stream.resolve([]); await run; });
  });
});

describe("failure messages", () => {
  it("wraps an ordinary error and does not mark the conversation stopped", async () => {
    const stream = controlled();
    const { hook, setError } = setup([stream]);
    await act(async () => {
      const run = hook.result.current.streamConversationResponse(conversation);
      stream.reject(new Error("boom"));
      await run;
    });
    expect(lastError(setError)).toBe("Failed to stream from backend: boom");
    expect(hook.result.current.stoppedConversationId).toBeNull();
    expect(hook.result.current.streaming).toBe(false);
    expect(hook.result.current.settledCount).toBe(1);
  });

  it("reports a non-Error failure generically", async () => {
    const stream = controlled();
    const { hook, setError } = setup([stream]);
    await act(async () => {
      const run = hook.result.current.streamConversationResponse(conversation);
      stream.reject("not an error");
      await run;
    });
    expect(lastError(setError)).toBe("Failed to stream from backend.");
    expect(hook.result.current.stoppedConversationId).toBeNull();
  });

  it("reports a stop as 'Generation stopped.' and marks the conversation stopped", async () => {
    const stream = controlled();
    const { hook, setError } = setup([stream]);
    await act(async () => {
      const run = hook.result.current.streamConversationResponse(conversation);
      stream.reject(new Error("AbortError"));
      await run;
    });
    expect(lastError(setError)).toBe("Generation stopped.");
    expect(hook.result.current.stoppedConversationId).toBe(conversation.id);
  });

  it("keeps partial prose only when the connection was lost", async () => {
    for (const [error, kept] of [[Object.assign(new Error("lost"), { name: "ConnectionLostError" }), true], [new Error("boom"), false]] as const) {
      const stream = controlled();
      const { hook, requests, conv } = setup([stream]);
      await act(async () => {
        const run = hook.result.current.streamConversationResponse(conversation);
        requests[0].onDelta([{ id: "stream-a", kind: "assistant", title: "Assistant", content: "partial prose", createdAt: "2026-01-01T00:00:03Z" }]);
        stream.reject(error);
        await run;
      });
      expect(conv.get().steps.some((s) => s.content === "partial prose")).toBe(kept);
    }
  });

  it("explains a missing backend connection", async () => {
    const setError = vi.fn();
    const { result } = renderHook(() => useChatGeneration({
      backendClient: { startStream: vi.fn() } as unknown as BackendClient, send: () => true, connected: false,
      availableModels: [], updateConversation: vi.fn(), defaultExpanded: () => true, setError,
    }));
    await act(async () => result.current.streamConversationResponse(conversation));
    expect(lastError(setError)).toBe("Backend is not connected. Make sure the server is running (make dev).");
  });
});

describe("ownership of the UI", () => {
  it("a superseded generation's failure neither reports an error nor ends streaming", async () => {
    const first = controlled();
    const second = controlled();
    const { hook, setError } = setup([first, second]);
    let runFirst!: Promise<void>;
    let runSecond!: Promise<void>;
    act(() => { runFirst = hook.result.current.streamConversationResponse(conversation); });
    act(() => { runSecond = hook.result.current.streamConversationResponse(conversation); });
    setError.mockClear();
    await act(async () => { first.reject(new Error("AbortError")); await runFirst; });
    expect(setError).not.toHaveBeenCalled();
    expect(hook.result.current.streaming).toBe(true);
    expect(hook.result.current.stoppedConversationId).toBeNull();
    await act(async () => { second.resolve([]); await runSecond; });
    expect(hook.result.current.streaming).toBe(false);
    expect(hook.result.current.settledCount).toBe(1);
  });

  it("a fresh send clears a previous stop", async () => {
    const first = controlled();
    const second = controlled();
    const { hook } = setup([first, second]);
    await act(async () => {
      const run = hook.result.current.streamConversationResponse(conversation);
      first.reject(new Error("AbortError"));
      await run;
    });
    expect(hook.result.current.stoppedConversationId).toBe(conversation.id);
    let run!: Promise<void>;
    act(() => { run = hook.result.current.streamConversationResponse(conversation); });
    expect(hook.result.current.stoppedConversationId).toBeNull();
    await act(async () => { second.resolve([]); await run; });
  });
});
