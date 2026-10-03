"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Conversation, ModelRuntime, OllamaModel, OllamaModelMeta } from "@/src/types/chat";
import {
  computeContextFill,
  rememberedWindow,
  resolveContextWindow,
  type ContextFill,
  type ResolvedContextWindow,
} from "@/src/lib/context-window";
import { modelIdentity } from "@/src/lib/model-identity";
import { fetchModelMetaIfAvailable, fetchModelRuntime } from "@/src/lib/ollama";

interface ContextWindowDeps {
  /** The window is needed (meter shown or `compact_context` active); nothing is fetched while it is not. */
  enabled: boolean;
  conversation: Conversation | null | undefined;
  /** The conversation's model as discovered, or `undefined` when discovery does not know it. */
  model: OllamaModel | undefined;
  /** Windows remembered per `modelIdentity(provider, model)` (sidebar preference). */
  remembered: Record<string, number>;
  /** Persists a live runtime window; must be called after every resolve and every re-query. */
  rememberContextWindow: (provider: string | undefined, model: string, resolved: ResolvedContextWindow) => void;
  /** Changes whenever a generation settles (done, stopped or failed); each change re-queries the runtime window. */
  settledCount: number;
}

interface Observed {
  key: string;
  runtime: ModelRuntime | undefined;
  modelMeta: OllamaModelMeta | undefined;
}

/**
 * Resolves the selected conversation's context window and the fill measured against it.
 * The runtime window is read while the window is needed (meter shown or compact_context active),
 * when the model changes and after each settled generation. Model metadata is fetched only when
 * not yet cached, the model is not loaded with a known window, and the provider has metadata;
 * failed lookups are retried. Returns `undefined`
 * for both while the first observation of the current model is pending.
 */
export function useContextWindow({
  enabled,
  conversation,
  model,
  remembered,
  rememberContextWindow,
  settledCount,
}: ContextWindowDeps): { window: ResolvedContextWindow | undefined; fill: ContextFill | undefined } {
  const [observed, setObserved] = useState<Observed | null>(null);
  const metaCache = useRef(new Map<string, OllamaModelMeta>());
  const rememberedRef = useRef(remembered);
  rememberedRef.current = remembered;
  const rememberRef = useRef(rememberContextWindow);
  rememberRef.current = rememberContextWindow;

  const modelName = model?.name;
  const provider = model?.provider;
  const key = modelName === undefined ? undefined : modelIdentity(provider, modelName);

  useEffect(() => {
    if (!enabled || !model || key === undefined) return;
    let cancelled = false;

    (async () => {
      let runtime: ModelRuntime | undefined;
      try {
        runtime = await fetchModelRuntime(model);
      } catch {
        // The backend could not answer: fall back to what is remembered or assumed.
      }
      // Metadata is still worth trying when the runtime lookup failed: /api/show can answer while
      // /api/ps does not. Only a definite answer is cached; a transient failure is retried next time.
      // A loaded model's live window wins outright, so a slow /models/show must not delay it.
      let modelMeta = metaCache.current.get(key);
      const liveWindow = runtime?.loaded === true && runtime.contextLength !== undefined;
      if (modelMeta === undefined && !liveWindow) {
        modelMeta = await fetchModelMetaIfAvailable(model, runtime);
        if (modelMeta !== undefined) metaCache.current.set(key, modelMeta);
      }
      if (cancelled) return;
      const resolved = resolveContextWindow({
        runtime,
        remembered: rememberedWindow(rememberedRef.current, provider, model.name),
        modelMeta,
      });
      rememberRef.current(provider, model.name, resolved);
      setObserved({ key, runtime, modelMeta });
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, model, key, provider, settledCount]);

  const rememberedTokens = modelName === undefined ? undefined : rememberedWindow(remembered, provider, modelName);
  const current = observed?.key === key ? observed : null;
  // Without a discovered model nothing can be fetched; resolve from what is remembered.
  const pending = model !== undefined && current === null;

  const window = useMemo(
    () =>
      pending
        ? undefined
        : resolveContextWindow({
            runtime: current?.runtime,
            remembered: rememberedTokens,
            modelMeta: current?.modelMeta,
          }),
    [pending, current, rememberedTokens]
  );
  const steps = conversation?.steps;
  const fill = useMemo(() => (window && steps ? computeContextFill(steps, window) : undefined), [window, steps]);

  return { window, fill };
}
