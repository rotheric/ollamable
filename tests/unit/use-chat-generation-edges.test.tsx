/**
 * Edge-case tests for `useChatGeneration` that target mutation-gate residuals
 * the main / fork-properties suites don't observe directly:
 *
 *   - `!connected`: setError + setStreaming(false) + no backendClient.startStream.
 *   - Unknown-model path: reasoningEffort NOT threaded into the backend call.
 *   - stoppedConversationId reflects an AbortError settle, and resumeGeneration clears it.
 *   - `error.name === "ConnectionLostError"` surfaces the server message verbatim
 *     (vs the generic "Failed to stream from backend" wrapper).
 *
 * These are deliberately shallow: they drive the real hook with a tiny
 * BackendClient double, assert the externally visible outputs, and avoid
 * mirroring the internal branch structure.
 */
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatGeneration } from "@/src/lib/use-chat-generation";
import { createConversation } from "@/src/lib/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import type { Conversation } from "@/src/types/chat";

interface Deferred {
  promise: Promise<never[]>;
  resolve: () => void;
  reject: (err: Error) => void;
  stop: ReturnType<typeof vi.fn>;
}

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<never[]>((res, rej) => {
    resolve = () => res([]);
    reject = (err) => rej(err);
  });
  return { promise, resolve, reject, stop: vi.fn() };
}

const conversation: Conversation = {
  ...createConversation("a:latest", [], "ollama"),
  reasoningEffort: "high",
};

describe("useChatGeneration disconnected guard", () => {
  it("without a backend connection, surfaces an error, settles streaming false, and does not start a stream", async () => {
    const startStream = vi.fn();
    const backendClient = { startStream } as unknown as BackendClient;
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: false, availableModels: [],
        updateConversation: vi.fn(), defaultExpanded: () => false, setError,
      })
    );

    await act(async () => result.current.streamConversationResponse(conversation));

    expect(startStream).not.toHaveBeenCalled();
    expect(result.current.streaming).toBe(false);
    // The last error call is a non-empty disconnected message (we don't pin the exact text).
    const lastError = setError.mock.calls.at(-1)?.[0];
    expect(typeof lastError).toBe("string");
    expect(lastError!.length).toBeGreaterThan(0);
    // settledCount is NOT bumped for a request that was refused up front.
    expect(result.current.settledCount).toBe(0);
  });
});

describe("useChatGeneration reasoning-model gate", () => {
  it("omits reasoningEffort in the backend send when the model is not known to be a reasoning model", async () => {
    const d = deferred();
    const startStream = vi.fn(() => ({ promise: d.promise, stop: d.stop }));
    const backendClient = { startStream } as unknown as BackendClient;
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: true,
        availableModels: [], // model unknown → gate falls to `false`
        updateConversation: vi.fn(), defaultExpanded: () => false, setError: vi.fn(),
      })
    );

    const run = act(async () => {
      await result.current.streamConversationResponse(conversation);
    });

    expect(startStream).toHaveBeenCalledOnce();
    const call = (startStream.mock.calls[0] as unknown as unknown[])[1] as { reasoningEffort?: string };
    expect(call.reasoningEffort).toBeUndefined();

    act(() => d.resolve());
    await run;
  });
});

describe("useChatGeneration AbortError settle", () => {
  it("records stoppedConversationId on an AbortError settle, and resumeGeneration clears it", async () => {
    const first = deferred();
    const startStream = vi.fn().mockReturnValueOnce({ promise: first.promise, stop: first.stop });
    const backendClient = { startStream } as unknown as BackendClient;
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: true, availableModels: [],
        updateConversation: vi.fn(), defaultExpanded: () => false, setError,
      })
    );

    await act(async () => {
      const streamed = result.current.streamConversationResponse(conversation);
      first.reject(new Error("AbortError"));
      await streamed;
    });

    expect(result.current.stoppedConversationId).toBe(conversation.id);
    expect(result.current.streaming).toBe(false);

    const resume = deferred();
    startStream.mockReturnValueOnce({ promise: resume.promise, stop: resume.stop });
    await act(async () => {
      const resumed = result.current.resumeGeneration(conversation);
      resume.resolve();
      await resumed;
    });

    // resumeGeneration starts by clearing the stopped flag, then runs a fresh stream.
    expect(result.current.stoppedConversationId).toBeNull();
    expect(startStream).toHaveBeenCalledTimes(2);
  });
});

describe("useChatGeneration connection-lost error surface", () => {
  it("surfaces a ConnectionLostError's own message, not the generic wrapper", async () => {
    const d = deferred();
    const startStream = vi.fn(() => ({ promise: d.promise, stop: d.stop }));
    const backendClient = { startStream } as unknown as BackendClient;
    const setError = vi.fn();
    const { result } = renderHook(() =>
      useChatGeneration({
        backendClient, send: () => true, connected: true, availableModels: [],
        updateConversation: vi.fn(), defaultExpanded: () => false, setError,
      })
    );

    await act(async () => {
      const streamed = result.current.streamConversationResponse(conversation);
      const err = new Error("Backend connection lost. Partial response kept; reconnect and retry manually.");
      err.name = "ConnectionLostError";
      d.reject(err);
      await streamed;
    });

    const lastErr = setError.mock.calls.at(-1)?.[0] as string;
    expect(lastErr).toContain("connection lost");
    // Not the generic failed-to-stream wrapper.
    expect(lastErr.startsWith("Failed to stream from backend")).toBe(false);
    // Not an AbortError-triggered stop either.
    expect(result.current.stoppedConversationId).toBeNull();
  });
});
