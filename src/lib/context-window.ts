import { modelIdentity } from "@/src/lib/model-identity";
import { contextPercent, lastUsedTokens } from "../../shared/context-usage";
import { withDefaultTag } from "../../shared/model-name";
import { isStreamingStep } from "@/src/lib/stream-steps";
import type {
  ContextWindowSource,
  ConversationStep,
  ModelRuntime,
  OllamaModelMeta,
} from "@/src/types/chat";

/** Window used when nothing is known about the model (every OpenAI-compatible model, failed `/models/show`). */
export const ASSUMED_CONTEXT_WINDOW = 8192;

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
  /** Only ever set with source "runtime": the model is unloaded and `tokens` is its last observed window. */
  stale?: boolean;
}

export type ContextFillLevel = "ok" | "warn" | "error";

export type ContextFill =
  | { usedTokens: number; percent: number; level: ContextFillLevel }
  | { unknown: true };

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** `num_ctx` from the raw Modelfile `parameters` text (one `name  value` pair per line). */
function modelfileNumCtx(parameters: string | undefined): number | undefined {
  if (!parameters) return undefined;
  const match = /^[ \t]*num_ctx[ \t]+(\d+)[ \t]*$/m.exec(parameters);
  const value = match ? Number(match[1]) : undefined;
  return positiveInteger(value) ? value : undefined;
}

/** The model's maximum window: `<general.architecture>.context_length`, else any `*.context_length`. */
function architectureContextLength(modelInfo: OllamaModelMeta["modelInfo"]): number | undefined {
  if (!modelInfo) return undefined;
  const architecture = modelInfo["general.architecture"];
  if (typeof architecture === "string") {
    const exact = modelInfo[`${architecture}.context_length`];
    if (positiveInteger(exact)) return exact;
  }
  for (const [key, value] of Object.entries(modelInfo)) {
    if (key.endsWith(".context_length") && positiveInteger(value)) return value;
  }
  return undefined;
}

/**
 * Picks the effective context window with an honest provenance, in order: the live
 * window of the loaded model; the last window remembered for it (stale, it has since
 * been unloaded); the Modelfile `num_ctx`; the architecture maximum (an estimate,
 * Ollama may load with a smaller default); otherwise 8192 (assumed).
 */
export function resolveContextWindow(input: {
  runtime?: Omit<ModelRuntime, "metadata">;
  remembered?: number;
  modelMeta?: OllamaModelMeta;
}): ResolvedContextWindow {
  const { runtime, remembered, modelMeta } = input;
  if (runtime?.loaded && positiveInteger(runtime.contextLength)) {
    return { tokens: runtime.contextLength, source: "runtime" };
  }
  if (positiveInteger(remembered)) {
    return { tokens: remembered, source: "runtime", stale: true };
  }
  const modelfile = modelfileNumCtx(modelMeta?.parameters);
  if (modelfile !== undefined) return { tokens: modelfile, source: "modelfile" };
  const estimated = architectureContextLength(modelMeta?.modelInfo);
  if (estimated !== undefined) return { tokens: estimated, source: "estimated" };
  return { tokens: ASSUMED_CONTEXT_WINDOW, source: "assumed" };
}

/**
 * Cache key for a remembered window. Ollama reports an untagged model by its resolved
 * `:latest` tag (see the server's `/api/ps` matching), so `llama3` and `llama3:latest`
 * share one entry. `provider` undefined and absent are the same identity.
 */
function rememberedKey(provider: string | undefined, model: string): string {
  const name = withDefaultTag(model);
  return modelIdentity(provider || undefined, name);
}

/**
 * Returns `remembered` with `resolved` recorded for `provider/model` when it is a live
 * (non-stale) runtime window. Returns the same object when nothing changes, so callers
 * can skip a persistence write.
 */
export function recordRuntimeWindow(
  remembered: Record<string, number>,
  provider: string | undefined,
  model: string,
  resolved: ResolvedContextWindow
): Record<string, number> {
  if (resolved.source !== "runtime" || resolved.stale) return remembered;
  const key = rememberedKey(provider, model);
  if (remembered[key] === resolved.tokens) return remembered;
  return { ...remembered, [key]: resolved.tokens };
}

/** The remembered window for `provider/model`, if any. */
export function rememberedWindow(
  remembered: Record<string, number>,
  provider: string | undefined,
  model: string
): number | undefined {
  return remembered[rememberedKey(provider, model)];
}

/** Level from the raw ratio, not the rounded display percent (99.5% is still "warn"). */
function levelFor(usedTokens: number, windowTokens: number): ContextFillLevel {
  if (usedTokens >= windowTokens) return "error";
  if (usedTokens * 100 >= windowTokens * 80) return "warn";
  return "ok";
}

/**
 * Fill is `inputTokens + outputTokens` of the LATEST response's usage (the model's whole context at
 * the end of its latest invocation). Before any response there is nothing to count (zero fill); a
 * latest response whose provider reported no usage is `unknown`, even when an older response
 * reported usage. In-flight (streaming) steps are ignored, so the meter holds the previous
 * completed invocation's value while a response streams.
 */
export function computeContextFill(
  allSteps: ReadonlyArray<Pick<ConversationStep, "kind" | "usage"> & { id?: string }>,
  window: Pick<ResolvedContextWindow, "tokens">
): ContextFill {
  const steps = allSteps.filter((step) => step.id === undefined || !isStreamingStep({ id: step.id }));
  const usedTokens = lastUsedTokens(steps);
  if (usedTokens !== undefined) {
    const percent = contextPercent(usedTokens, window.tokens);
    return { usedTokens, percent, level: levelFor(usedTokens, window.tokens) };
  }
  if (steps.some((step) => step.kind === "assistant")) return { unknown: true };
  return { usedTokens: 0, percent: 0, level: "ok" };
}
