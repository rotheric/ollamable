import { describe, expect, it } from "vitest";
import type { OllamaModel } from "@/src/types/chat";
import {
  findModel,
  groupModelsByProviderName,
  isEmbeddingModel,
  isReasoningModel,
  modelSelectKey,
  supportsTemperature,
} from "@/src/lib/models";

describe("modelSelectKey", () => {
  it("prefixes the provider so the same model name on two providers stays distinguishable", () => {
    expect(modelSelectKey("ollama", "qwen3:latest")).toBe("ollama:qwen3:latest");
    expect(modelSelectKey("minimax", "qwen3:latest")).toBe("minimax:qwen3:latest");
  });

  it("is the bare model name for a model without a provider", () => {
    expect(modelSelectKey(undefined, "qwen3:latest")).toBe("qwen3:latest");
  });
});

describe("findModel", () => {
  const models: OllamaModel[] = [
    { name: "qwen3:latest", provider: "ollama" },
    { name: "qwen3:latest", provider: "remote" },
    { name: "llama3.2:latest" },
  ];

  it("matches on name and provider together", () => {
    expect(findModel(models, "qwen3:latest", "remote")).toBe(models[1]);
  });

  it("matches a provider-less model only when no provider is asked for", () => {
    expect(findModel(models, "llama3.2:latest", undefined)).toBe(models[2]);
    expect(findModel(models, "llama3.2:latest", "ollama")).toBeUndefined();
  });

  it("does not fall back to a same-named model on another provider", () => {
    expect(findModel(models, "qwen3:latest", "minimax")).toBeUndefined();
    expect(findModel(models, "qwen3:latest", undefined)).toBeUndefined();
  });
});

describe("isReasoningModel", () => {
  it("trusts a reported thinking capability, whatever the model is called", () => {
    expect(isReasoningModel({ name: "anything", capabilities: ["completion", "thinking"] })).toBe(true);
  });

  it.each(["o1", "o1-preview", "o3-mini", "o4-mini", "o4 mini", "o4mini", "MiniMax-M1", "minimax-m2.5", "MiniMax-M2.7"])(
    "recognizes %s by name when the provider reports no capabilities",
    (name) => {
      expect(isReasoningModel({ name })).toBe(true);
    }
  );

  it.each(["gpt-4o", "llama3.2:latest", "o10", "foo1", "MiniMax-M2", "MiniMax-M2x5"])(
    "does not mistake %s for a reasoning model",
    (name) => {
      expect(isReasoningModel({ name })).toBe(false);
    }
  );

  it("is false for a model whose capabilities omit thinking", () => {
    expect(isReasoningModel({ name: "qwen2.5", capabilities: ["completion", "tools"] })).toBe(false);
  });
});

describe("isEmbeddingModel", () => {
  it.each([
    ["its family", { name: "m", family: "nomic-bert" }],
    ["one of its families", { name: "m", families: ["llama", "BGE-m3"] }],
    ["its parent model", { name: "m", parentModel: "mxbai-embed-large:latest" }],
    ["a dimension-style parameter size", { name: "m", parameterSize: "384 D" }],
    ["a padded dimension-style parameter size", { name: "m", parameterSize: " 768d " }],
    ["a dimension with several spaces before the unit", { name: "m", parameterSize: "1024   d" }],
  ] as [string, OllamaModel][])("detects an embedding model by %s", (_by, model) => {
    expect(isEmbeddingModel(model)).toBe(true);
  });

  it("treats an ordinary chat model as not embedding", () => {
    expect(isEmbeddingModel({ name: "qwen3:latest", family: "qwen", families: ["qwen"], parameterSize: "8B" })).toBe(false);
    expect(isEmbeddingModel({ name: "bare" })).toBe(false);
  });

  it("requires the whole parameter size to be a dimension, not merely to contain one", () => {
    expect(isEmbeddingModel({ name: "m", parameterSize: "768 dims" })).toBe(false);
    expect(isEmbeddingModel({ name: "m", parameterSize: "v2 768d" })).toBe(false);
    expect(isEmbeddingModel({ name: "m", parameterSize: "d" })).toBe(false);
  });
});

describe("supportsTemperature", () => {
  it("is false until the model is known, and false for embedding models", () => {
    expect(supportsTemperature(undefined)).toBe(false);
    expect(supportsTemperature({ name: "e", family: "bert" })).toBe(false);
    expect(supportsTemperature({ name: "qwen3:latest", family: "qwen" })).toBe(true);
  });
});

describe("groupModelsByProviderName", () => {
  it("groups by provider display name in first-seen order, keeping model order within a group", () => {
    const a = { name: "a", providerName: "Ollama" };
    const b = { name: "b", providerName: "MiniMax" };
    const c = { name: "c", providerName: "Ollama" };

    const groups = groupModelsByProviderName([a, b, c]);

    expect([...groups.keys()]).toEqual(["Ollama", "MiniMax"]);
    expect(groups.get("Ollama")).toEqual([a, c]);
    expect(groups.get("MiniMax")).toEqual([b]);
  });

  it('files models without a provider name under "Local"', () => {
    const groups = groupModelsByProviderName([{ name: "fallback" }]);
    expect([...groups.keys()]).toEqual(["Local"]);
  });
});
