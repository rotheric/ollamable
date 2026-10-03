import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchModelMetaIfAvailable, fetchModelRuntime } from "@/src/lib/ollama";

const fetchMock = vi.fn();
beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("fetchModelRuntime", () => {
  it("posts model and provider to /models/runtime and returns a loaded window", async () => {
    fetchMock.mockResolvedValue(json({ loaded: true, metadata: true, contextLength: 4096 }));
    await expect(fetchModelRuntime({ name: "qwen3:1.7b", provider: "ollama" })).resolves.toEqual({ loaded: true, metadata: true, contextLength: 4096 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toMatch(/\/models\/runtime$/);
    expect(JSON.parse(init.body)).toEqual({ model: "qwen3:1.7b", provider: "ollama" });
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Content-Type")).toBe("application/json");
  });

  it("returns loaded:false for an unloaded model", async () => {
    fetchMock.mockResolvedValue(json({ loaded: false, metadata: true }));
    await expect(fetchModelRuntime({ name: "m" })).resolves.toEqual({ loaded: false, metadata: true });
  });

  it.each([
    { loaded: true },
    { loaded: true, contextLength: 0 },
    { loaded: true, contextLength: "4096" },
    { loaded: true, contextLength: 1.5 },
    { loaded: false, contextLength: 4096 },
    { loaded: "true", contextLength: 4096 },
    { contextLength: 4096 },
    {},
  ])(
    "never reports a loaded window without a positive integer contextLength: %j",
    async (body) => {
      fetchMock.mockResolvedValue(json(body));
      await expect(fetchModelRuntime({ name: "m" })).resolves.toEqual({ loaded: false, metadata: false });
    }
  );

  it("rejects with the backend's message on an error status", async () => {
    fetchMock.mockResolvedValue(json({ error: "Unknown provider" }, 500));
    await expect(fetchModelRuntime({ name: "m" })).rejects.toThrow("Unknown provider");
  });

  it.each([json({}, 503), new Response("not json", { status: 503 })])("names the status when the backend gives no message", async (response) => {
    fetchMock.mockResolvedValue(response);
    await expect(fetchModelRuntime({ name: "m" })).rejects.toThrow("Backend /models/runtime failed: 503");
  });
});

describe("fetchModelMetaIfAvailable", () => {
  it("AC-CTX-4: never requests /models/show when the runtime reports no metadata (non-Ollama provider)", async () => {
    fetchMock.mockResolvedValueOnce(json({ loaded: false, metadata: false }));
    const model = { name: "MiniMax-M2.7", provider: "minimax" };
    const runtime = await fetchModelRuntime(model);
    await expect(fetchModelMetaIfAvailable(model, runtime)).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([expect.stringMatching(/\/models\/runtime$/)]);
  });

  it("AC-CTX-4: a failed /models/show is undefined and is not logged as an error", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fetchMock.mockResolvedValue(json({ error: "Model metadata is only available for Ollama models" }, 500));
    await expect(fetchModelMetaIfAvailable({ name: "MiniMax-M2.7", provider: "minimax" })).resolves.toBeUndefined();
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("returns the metadata when the backend has it", async () => {
    fetchMock.mockResolvedValue(json({ parameters: "num_ctx 4096", model_info: { "general.architecture": "qwen3" } }));
    await expect(fetchModelMetaIfAvailable({ name: "qwen3:1.7b" }, { metadata: true })).resolves.toMatchObject({
      name: "qwen3:1.7b",
      parameters: "num_ctx 4096",
    });
  });
});
