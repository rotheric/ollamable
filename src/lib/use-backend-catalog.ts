"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { OllamaModel, ToolDefinition } from "@/src/types/chat";
import { fallbackModels } from "@/src/lib/chat";
import { isEmbeddingModel } from "@/src/lib/models";
import { fetchAllModels, fetchTools } from "@/src/lib/ollama";

export type ModelDiscoveryState = "loading" | "ready" | "failed";

/**
 * Loads what the backend offers: the models of every configured provider and
 * the tools it can execute. Until discovery answers (or when it fails) the
 * fallback model list stands in.
 */
export function useBackendCatalog(onDiscoveryFailed: (message: string) => void) {
  const [models, setModels] = useState<OllamaModel[]>(fallbackModels);
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [modelDiscoveryState, setModelDiscoveryState] = useState<ModelDiscoveryState>("loading");
  const onDiscoveryFailedRef = useRef(onDiscoveryFailed);
  onDiscoveryFailedRef.current = onDiscoveryFailed;

  // Fetch available tools from the backend
  useEffect(() => {
    let cancelled = false;
    async function loadTools() {
      try {
        const remoteTools = await fetchTools();
        if (!cancelled) {
          setTools(remoteTools);
        }
      } catch {
        // Backend unreachable — no tools available
      }
    }
    void loadTools();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const models = await fetchAllModels();
        if (!cancelled) {
          setModels(models);
          setModelDiscoveryState("ready");
        }
      } catch {
        if (!cancelled) {
          setModelDiscoveryState("failed");
          onDiscoveryFailedRef.current("Could not reach the backend. Using fallback model list; saved selections are unchanged.");
        }
      }
    }

    void loadModels();

    return () => {
      cancelled = true;
    };
  }, []);

  /** MCP servers announce their tools over the WebSocket as they connect. */
  const mergeTools = useCallback((announced: ToolDefinition[]) => {
    setTools((current) => {
      const merged = [...current];
      for (const tool of announced) {
        if (!merged.some((t) => t.id === tool.id)) {
          merged.push(tool);
        }
      }
      return merged;
    });
  }, []);

  const availableModels = useMemo(() => {
    const filteredModels = models.filter((model) => !isEmbeddingModel(model));
    return filteredModels.length > 0 ? filteredModels : fallbackModels;
  }, [models]);

  return { models, availableModels, modelDiscoveryState, tools, mergeTools };
}
