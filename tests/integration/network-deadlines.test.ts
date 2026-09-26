import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmRouter } from "../../server/llm-router.js";
import { fetchOllamaModelMeta } from "../../server/ollama-client.js";
import { fetchOpenAIModels } from "../../server/openai-client.js";
import { loadVocab, __resetVocabCacheForTests } from "../../server/tokenizer.js";
import { WebSearchExecutor } from "../../server/tools/web-search.js";
import { DISCOVERY_TIMEOUT_MS, TOOL_REQUEST_TIMEOUT_MS } from "../../server/network-deadline.js";

beforeEach(() => { vi.useFakeTimers(); __resetVocabCacheForTests(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function stallUntilAbort(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}
const openai = { id: "openai", type: "openai-compat" as const, name: "OpenAI", baseUrl: "https://openai.test" };

describe("application network deadlines", () => {
  it.each(["ollama metadata", "openai models"])("bounds stalled %s requests and aborts the fetch", async (operation) => {
    let signal!: AbortSignal;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init!.signal!;
      return stallUntilAbort(signal);
    });
    const request = operation === "ollama metadata" ? fetchOllamaModelMeta("https://ollama.test/api", "model") : fetchOpenAIModels(openai);
    const rejected = expect(request).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    await rejected;
    expect(signal.aborted).toBe(true);
  });

  it("keeps the deadline active while the response body is stalled", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => new Response(new ReadableStream({
      start(controller) { init!.signal!.addEventListener("abort", () => controller.error(init!.signal!.reason), { once: true }); },
    })));
    const rejected = expect(fetchOllamaModelMeta("https://ollama.test/api", "model")).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    await rejected;
  });

  it("retains healthy providers when another provider stalls", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => stallUntilAbort(init!.signal!));
    const router = new LlmRouter([
      { ...openai, knownModels: ["healthy-model"] },
      { id: "slow", type: "ollama", name: "Slow", baseUrl: "https://slow.test/api" },
    ]);
    const result = router.listAllModels();
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    expect(await result).toEqual([{ name: "healthy-model", provider: "openai", providerName: "OpenAI" }]);
  });

  it("retains discovered Ollama models when optional capability requests stall", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => String(url).endsWith("/tags")
      ? new Response(JSON.stringify({ models: [{ name: "found" }] })) : stallUntilAbort(init!.signal!));
    const router = new LlmRouter([{ id: "ollama", type: "ollama", name: "Ollama", baseUrl: "https://ollama.test/api" }]);
    const result = router.listAllModels();
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    expect(await result).toEqual([expect.objectContaining({ name: "found", provider: "ollama", capabilities: undefined })]);
  });

  it("expires a shared vocabulary load once and allows a later retry", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => stallUntilAbort(init!.signal!));
    const first = loadVocab("https://ollama.test/api", "model");
    const second = loadVocab("https://ollama.test/api", "model");
    expect(first).toBe(second);
    const rejected = expect(first).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(DISCOVERY_TIMEOUT_MS);
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ model_info: {
      "tokenizer.ggml.tokens": ["a"], "tokenizer.ggml.merges": [], "tokenizer.ggml.pre": "qwen2",
    } })));
    await expect(loadVocab("https://ollama.test/api", "model")).resolves.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each(["timeout", "caller cancellation"])("ends Brave requests on %s", async (mode) => {
    vi.stubEnv("BRAVE_API_KEY", "test-key");
    let signal!: AbortSignal;
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
      signal = init!.signal!;
      return stallUntilAbort(signal);
    });
    const controller = new AbortController();
    const result = new WebSearchExecutor().execute("web_search", { query: "test" }, () => {}, controller.signal);
    if (mode === "timeout") {
      await vi.advanceTimersByTimeAsync(TOOL_REQUEST_TIMEOUT_MS);
      expect(JSON.parse(await result).error).toContain("timed out");
    } else {
      const rejected = expect(result).rejects.toThrow("cancelled");
      controller.abort(new Error("cancelled"));
      await rejected;
    }
    expect(signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
