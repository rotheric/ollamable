import type { OllamaModel } from "@/src/types/chat";

/**
 * Build a composite key for the model list so that models with the same
 * name on different providers remain distinguishable.
 */
export function modelSelectKey(provider: string | undefined, name: string): string {
  return provider ? `${provider}:${name}` : name;
}

/** Looks a model up by its full identity: the same name on another provider is a different model. */
export function findModel(
  models: OllamaModel[],
  name: string | undefined,
  provider: string | undefined
): OllamaModel | undefined {
  return models.find((model) => model.name === name && model.provider === provider);
}

/** Known reasoning model name patterns (for providers that don't report capabilities). */
const REASONING_MODEL_PATTERNS = [
  // OpenAI reasoning models
  /\bo1\b/i,
  /\bo3\b/i,
  /\bo4[-\s]?mini\b/i,
  // MiniMax reasoning models
  /\bMiniMax-M1\b/i,
  /\bMiniMax-M2\.5\b/i,
  /\bMiniMax-M2\.7\b/i,
];

export function isReasoningModel(model: OllamaModel): boolean {
  if (model.capabilities?.includes("thinking")) return true;
  return REASONING_MODEL_PATTERNS.some((pattern) => pattern.test(model.name));
}

export function isEmbeddingModel(model: OllamaModel) {
  const families = [...(model.families ?? []), model.family, model.parentModel]
    .filter(Boolean)
    .map((value) => value!.toLowerCase());

  const embeddingFamilies = [
    "bert",
    "bge",
    "gte",
    "embeddinggemma",
    "nomic-bert",
    "snowflake-arctic-embed",
    "all-minilm",
    "mxbai-embed-large",
  ];

  if (families.some((family) => embeddingFamilies.some((token) => family.includes(token)))) {
    return true;
  }

  return /^\d+\s*d$/i.test(model.parameterSize?.trim() ?? "");
}

export function supportsTemperature(model: OllamaModel | undefined): boolean {
  if (!model) {
    return false;
  }

  return !isEmbeddingModel(model);
}

/** Groups models under their provider's display name, in first-seen order. */
export function groupModelsByProviderName(models: OllamaModel[]): Map<string, OllamaModel[]> {
  const providers = new Map<string, OllamaModel[]>();
  for (const model of models) {
    const key = model.providerName ?? "Local";
    const group = providers.get(key) ?? [];
    group.push(model);
    providers.set(key, group);
  }
  return providers;
}
