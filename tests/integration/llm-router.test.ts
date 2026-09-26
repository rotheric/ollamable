import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../server/ollama-client.js", () => ({
  streamOllamaResponse: vi.fn().mockResolvedValue([]),
  fetchOllamaModelMeta: vi.fn().mockResolvedValue({}),
}));
vi.mock("../../server/tokenizer.js", () => ({ tokenize: vi.fn().mockResolvedValue({ tokens: [], tokenIds: [] }) }));
vi.mock("../../server/openai-client.js", () => ({ streamOpenAIResponse: vi.fn().mockResolvedValue([]), fetchOpenAIModels: vi.fn().mockResolvedValue([]) }));
import { LlmRouter, UnknownProviderError } from "../../server/llm-router.js";
import { streamOllamaResponse, fetchOllamaModelMeta } from "../../server/ollama-client.js";
import { tokenize } from "../../server/tokenizer.js";
import { streamOpenAIResponse } from "../../server/openai-client.js";

const configs = [
  { id: "first", type: "ollama" as const, name: "First", baseUrl: "http://first.test/api" },
  { id: "second", type: "ollama" as const, name: "Second", baseUrl: "http://second.test/api" },
];
beforeEach(() => vi.clearAllMocks());
describe("explicit provider routing", () => {
  it.each(["removed-provider", ""])("rejects unknown explicit ID %j for chat, metadata, and tokenization", async (provider) => {
    const router = new LlmRouter(configs);
    await expect(router.streamResponse({ provider, model: "shared-model", steps: [], tools: [], onDelta: () => {} })).rejects.toBeInstanceOf(UnknownProviderError);
    await expect(router.showModelMeta(provider, "shared-model")).rejects.toThrow("Unknown provider");
    await expect(router.tokenizeText(provider, "shared-model", "text")).rejects.toThrow("Unknown provider");
    expect(streamOllamaResponse).not.toHaveBeenCalled();
    expect(fetchOllamaModelMeta).not.toHaveBeenCalled();
    expect(tokenize).not.toHaveBeenCalled();
  });

  it.each(configs)("keeps identical model names on the explicit $id provider", async (provider) => {
    const router = new LlmRouter(configs);
    await router.streamResponse({ provider: provider.id, model: "shared-model", steps: [], tools: [], onDelta: () => {} });
    await router.showModelMeta(provider.id, "shared-model");
    await router.tokenizeText(provider.id, "shared-model", "text");
    expect(streamOllamaResponse).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: provider.baseUrl }));
    expect(fetchOllamaModelMeta).toHaveBeenCalledWith(provider.baseUrl, "shared-model");
    expect(tokenize).toHaveBeenCalledWith(provider.baseUrl, "shared-model", "text");
  });

  it("retains legacy default routing only when provider is omitted", async () => {
    const router = new LlmRouter(configs);
    await router.showModelMeta(undefined, "old-saved-model");
    expect(fetchOllamaModelMeta).toHaveBeenCalledWith(configs[0].baseUrl, "old-saved-model");
    await expect(new LlmRouter([]).showModelMeta(undefined, "m")).rejects.toThrow("No providers are configured");
  });

  it("uses the discovered model map only for omitted IDs", async () => {
    const providers = configs.map((config, index) => ({ ...config, type: "openai-compat" as const, knownModels: [index ? "mapped-model" : "default-model"] }));
    const router = new LlmRouter(providers);
    await router.listAllModels();
    const args = { model: "mapped-model", steps: [], tools: [], onDelta: () => {} };
    await expect(router.streamResponse({ ...args, provider: "removed" })).rejects.toThrow("Unknown provider");
    expect(streamOpenAIResponse).not.toHaveBeenCalled();
    await router.streamResponse(args);
    expect(streamOpenAIResponse).toHaveBeenCalledWith(expect.objectContaining({ config: providers[1] }));
  });
});
