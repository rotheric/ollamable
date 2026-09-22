/**
 * LLM Router — aggregates models from all configured providers and routes
 * chat requests to the appropriate backend (Ollama or OpenAI-compatible).
 */

import type { ProviderConfig } from "./provider-config.js";
import type { ConversationStep, ReasoningEffort, ToolDefinition } from "./types.js";
import { fetchOllamaModelMeta, streamOllamaResponse } from "./ollama-client.js";
import { fetchOpenAIModels, streamOpenAIResponse } from "./openai-client.js";
import { tokenize, type TokenizeResult } from "./tokenizer.js";

/**
 * Thrown by `tokenizeText` when the resolved provider isn't Ollama-typed.
 * Mapped by server/ws-handler.ts to `tokenize.error{reason:
 * "unsupported_provider"}` (AC-ERR-2).
 */
export class UnsupportedProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedProviderError";
  }
}

// ── Public model type returned by the router ─────────────────────────

export interface ModelInfo {
  name: string;
  provider: string;
  providerName: string;
  family?: string;
  families?: string[];
  parameterSize?: string;
  format?: string;
  quantizationLevel?: string;
  capabilities?: string[];
}

// ── Router class ─────────────────────────────────────────────────────

export class LlmRouter {
  private configs: ProviderConfig[];
  /** Maps model name → provider config for routing without the frontend
   *  needing to send a provider field (backward-compatible fallback). */
  private modelProviderMap = new Map<string, ProviderConfig>();

  constructor(configs: ProviderConfig[]) {
    this.configs = configs;
  }

  /** Fetch models from every configured provider and return a unified list. */
  async listAllModels(): Promise<ModelInfo[]> {
    const results: ModelInfo[] = [];

    const fetches = this.configs.map(async (config) => {
      try {
        if (config.type === "ollama") {
          return await this.fetchOllamaModels(config);
        }
        if (config.type === "openai-compat") {
          return await this.fetchOpenAICompatModels(config);
        }
        return [];
      } catch (err) {
        console.warn(
          `[router] Failed to fetch models from ${config.name}:`,
          err instanceof Error ? err.message : err
        );
        return [];
      }
    });

    const groups = await Promise.all(fetches);
    for (const group of groups) {
      results.push(...group);
    }

    return results;
  }

  /** Route a streaming chat request to the correct provider. */
  async streamResponse(args: {
    provider?: string;
    model: string;
    steps: ConversationStep[];
    tools: ToolDefinition[];
    temperature?: number;
    maxOutputTokens?: number;
    reasoningEffort?: ReasoningEffort;
    onDelta: (steps: ConversationStep[]) => void;
    signal?: AbortSignal;
  }): Promise<ConversationStep[]> {
    const config = this.resolveProvider(args.provider, args.model);

    if (config.type === "ollama") {
      return streamOllamaResponse({
        baseUrl: config.baseUrl,
        model: args.model,
        steps: args.steps,
        tools: args.tools,
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
        reasoningEffort: args.reasoningEffort,
        onDelta: args.onDelta,
        signal: args.signal,
      });
    }

    if (config.type === "openai-compat") {
      return streamOpenAIResponse({
        config,
        model: args.model,
        steps: args.steps,
        tools: args.tools,
        temperature: args.temperature,
        maxOutputTokens: args.maxOutputTokens,
        reasoningEffort: args.reasoningEffort,
        onDelta: args.onDelta,
        signal: args.signal,
      });
    }

    throw new Error(`Unknown provider type: ${config.type}`);
  }

  /** Fetch model metadata. Only supported for Ollama models. */
  async showModelMeta(
    provider: string | undefined,
    modelName: string
  ): Promise<unknown> {
    const config = this.resolveProvider(provider, modelName);

    if (config.type !== "ollama") {
      throw new Error(
        `Model metadata is only available for Ollama models (provider: ${config.name}).`
      );
    }

    return fetchOllamaModelMeta(config.baseUrl, modelName);
  }

  /**
   * Tokenizes `text` against `model`'s vocabulary. Mirrors `showModelMeta`
   * (architecture.md Boundary Rule 4): the router owns the provider-type
   * gate and exposes a capability method, rather than handing the caller
   * the raw `ProviderConfig` (credentials included) to gate on itself.
   * Throws `UnsupportedProviderError` when the resolved provider isn't
   * Ollama-typed, or `VocabUnavailableError` (propagated from
   * server/tokenizer.ts) when the model's vocabulary can't be
   * loaded/used — both left for the caller to map to a typed
   * `tokenize.error` reason.
   */
  async tokenizeText(
    provider: string | undefined,
    model: string,
    text: string
  ): Promise<TokenizeResult> {
    const config = this.resolveProvider(provider, model);
    if (config.type !== "ollama") {
      throw new UnsupportedProviderError(
        `Tokenization is only available for Ollama models (provider: ${config.name}).`
      );
    }
    return tokenize(config.baseUrl, model, text);
  }

  /**
   * Resolves the provider config for a model, by explicit provider id
   * first, then the map populated by listAllModels(), then defaulting to
   * the first configured provider.
   */
  private resolveProvider(
    providerId: string | undefined,
    modelName: string
  ): ProviderConfig {
    if (providerId) {
      const config = this.configs.find((c) => c.id === providerId);
      if (config) return config;
    }

    const mapped = this.modelProviderMap.get(modelName);
    if (mapped) return mapped;

    // Default to first provider (Ollama)
    return this.configs[0];
  }

  private async fetchOllamaModels(
    config: ProviderConfig
  ): Promise<ModelInfo[]> {
    const response = await fetch(`${config.baseUrl}/tags`);
    if (!response.ok) {
      throw new Error(`Ollama /tags failed: ${response.status}`);
    }

    const data = (await response.json()) as {
      models?: Array<{
        name: string;
        modified_at?: string;
        details?: {
          family?: string;
          families?: string[];
          parameter_size?: string;
          format?: string;
          quantization_level?: string;
        };
      }>;
    };

    const models = data.models ?? [];

    // Fetch capabilities from /show for each model in parallel
    const metaResults = await Promise.allSettled(
      models.map((m) => fetchOllamaModelMeta(config.baseUrl, m.name))
    );

    return models.map((m, i) => {
      this.modelProviderMap.set(m.name, config);
      const meta =
        metaResults[i].status === "fulfilled"
          ? metaResults[i].value
          : undefined;
      return {
        name: m.name,
        provider: config.id,
        providerName: config.name,
        family: m.details?.family,
        families: m.details?.families,
        parameterSize: m.details?.parameter_size,
        format: m.details?.format,
        quantizationLevel: m.details?.quantization_level,
        capabilities: meta?.capabilities,
      };
    });
  }

  private async fetchOpenAICompatModels(
    config: ProviderConfig
  ): Promise<ModelInfo[]> {
    // Use the curated known-models list when available
    if (config.knownModels && config.knownModels.length > 0) {
      return config.knownModels.map((name) => {
        this.modelProviderMap.set(name, config);
        return {
          name,
          provider: config.id,
          providerName: config.name,
        };
      });
    }

    const models = await fetchOpenAIModels(config);
    return models.map((m) => {
      this.modelProviderMap.set(m.id, config);
      return {
        name: m.id,
        provider: config.id,
        providerName: config.name,
      };
    });
  }
}
