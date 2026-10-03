/** useContextWindow (epic-compaction-tool S2): pending state, failure fallback, stale-response discard. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { useContextWindow } from "@/src/lib/use-context-window";
import { fetchModelMetaIfAvailable, fetchModelRuntime } from "@/src/lib/ollama";
import { createConversation } from "@/src/lib/chat";
import type { ModelRuntime, OllamaModel } from "@/src/types/chat";

vi.mock("@/src/lib/ollama", () => ({
  fetchModelRuntime: vi.fn(),
  fetchModelMetaIfAvailable: vi.fn(),
}));

const runtimeMock = vi.mocked(fetchModelRuntime);
const metaMock = vi.mocked(fetchModelMetaIfAvailable);
const modelA: OllamaModel = { name: "a:latest", provider: "ollama" };
const modelB: OllamaModel = { name: "b:latest", provider: "ollama" };
const conversation = createConversation("a:latest", [], "ollama");

function setup(model: OllamaModel | undefined, enabled = true, settledCount = 0) {
  const remember = vi.fn();
  const hook = renderHook(
    (props: { model: OllamaModel | undefined; enabled: boolean; settledCount: number }) =>
      useContextWindow({ ...props, conversation, remembered: {}, rememberContextWindow: remember }),
    { initialProps: { model, enabled, settledCount } }
  );
  return { ...hook, remember };
}

describe("useContextWindow", () => {
  beforeEach(() => {
    runtimeMock.mockReset();
    metaMock.mockReset();
    metaMock.mockResolvedValue(undefined);
  });

  it("makes no request while disabled", async () => {
    const { result } = setup(modelA, false);
    await act(async () => {});
    expect(runtimeMock).not.toHaveBeenCalled();
    expect(metaMock).not.toHaveBeenCalled();
    expect(result.current.window).toBeUndefined();
  });

  it("is pending (no window, no fill) until the first observation resolves, then remembers a live window", async () => {
    let resolve!: (r: ModelRuntime) => void;
    runtimeMock.mockReturnValue(new Promise((done) => { resolve = done; }));
    const { result, remember } = setup(modelA);
    expect(result.current).toEqual({ window: undefined, fill: undefined });
    await act(async () => resolve({ loaded: true, metadata: true, contextLength: 4096 }));
    expect(result.current.window).toEqual({ tokens: 4096, source: "runtime" });
    expect(remember).toHaveBeenCalledWith("ollama", "a:latest", { tokens: 4096, source: "runtime" });
  });

  it("falls back to an assumed window when /models/runtime and metadata both fail", async () => {
    runtimeMock.mockRejectedValue(new Error("down"));
    const { result } = setup(modelA);
    await waitFor(() => expect(result.current.window).toEqual({ tokens: 8192, source: "assumed" }));
    expect(metaMock).toHaveBeenCalledWith(modelA, undefined);
  });

  it("still uses model metadata when only /models/runtime fails", async () => {
    runtimeMock.mockRejectedValue(new Error("ps down"));
    metaMock.mockResolvedValue({ name: "a:latest", parameters: "num_ctx 4096" });
    const { result } = setup(modelA);
    await waitFor(() => expect(result.current.window).toEqual({ tokens: 4096, source: "modelfile" }));
  });

  it("reads model metadata once per model but the runtime after every completion", async () => {
    runtimeMock.mockResolvedValue({ loaded: false, metadata: true });
    metaMock.mockResolvedValue({ name: "a:latest", parameters: "num_ctx 4096" });
    const { result, rerender } = setup(modelA);
    await waitFor(() => expect(result.current.window).toBeDefined());
    rerender({ model: modelA, enabled: true, settledCount: 1 });
    await waitFor(() => expect(runtimeMock).toHaveBeenCalledTimes(2));
    expect(metaMock).toHaveBeenCalledTimes(1);
  });

  it("publishes a loaded model's live window without waiting for (or requesting) metadata", async () => {
    runtimeMock.mockResolvedValue({ loaded: true, metadata: true, contextLength: 8192 });
    metaMock.mockReturnValue(new Promise(() => {}));
    const { result } = setup(modelA);
    await waitFor(() => expect(result.current.window).toEqual({ tokens: 8192, source: "runtime" }));
    expect(metaMock).not.toHaveBeenCalled();
  });

  it("retries a failed metadata lookup after the next settle instead of caching the failure", async () => {
    runtimeMock.mockResolvedValue({ loaded: false, metadata: true });
    metaMock.mockResolvedValueOnce(undefined).mockResolvedValue({ name: "a:latest", parameters: "num_ctx 4096" });
    const { result, rerender } = setup(modelA);
    await waitFor(() => expect(result.current.window?.source).toBe("assumed"));
    rerender({ model: modelA, enabled: true, settledCount: 1 });
    await waitFor(() => expect(result.current.window?.source).toBe("modelfile"));
    expect(metaMock).toHaveBeenCalledTimes(2);
  });

  it("discards a superseded model's late response", async () => {
    let resolveA!: (r: ModelRuntime) => void;
    runtimeMock.mockImplementation((model) =>
      model.name === "a:latest"
        ? new Promise((done) => { resolveA = done; })
        : Promise.resolve({ loaded: true, metadata: true, contextLength: 2000 })
    );
    const { result, rerender, remember } = setup(modelA);
    rerender({ model: modelB, enabled: true, settledCount: 0 });
    await waitFor(() => expect(result.current.window).toEqual({ tokens: 2000, source: "runtime" }));
    await act(async () => resolveA({ loaded: true, metadata: true, contextLength: 9999 }));
    expect(result.current.window).toEqual({ tokens: 2000, source: "runtime" });
    expect(remember).not.toHaveBeenCalledWith("ollama", "a:latest", expect.anything());
  });

  it("after a model switch it is pending again rather than showing the previous model's window", async () => {
    let resolveB!: (r: ModelRuntime) => void;
    runtimeMock.mockImplementation((model) =>
      model.name === "a:latest"
        ? Promise.resolve({ loaded: true, metadata: true, contextLength: 4096 })
        : new Promise((done) => { resolveB = done; })
    );
    const { result, rerender } = setup(modelA);
    await waitFor(() => expect(result.current.window).toEqual({ tokens: 4096, source: "runtime" }));
    rerender({ model: modelB, enabled: true, settledCount: 0 });
    expect(result.current).toEqual({ window: undefined, fill: undefined });
    await act(async () => resolveB({ loaded: true, metadata: true, contextLength: 2000 }));
    expect(result.current.window).toEqual({ tokens: 2000, source: "runtime" });
  });

  it("without a discovered model it resolves at once from what is known instead of staying pending", async () => {
    const { result } = setup(undefined);
    await act(async () => {});
    expect(result.current.window).toEqual({ tokens: 8192, source: "assumed" });
    expect(result.current.fill).toEqual({ usedTokens: 0, percent: 0, level: "ok" });
    expect(runtimeMock).not.toHaveBeenCalled();
  });
});
