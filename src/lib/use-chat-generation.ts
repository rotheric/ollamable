"use client";

import { useCallback, useRef, useState } from "react";
import type { Conversation, ConversationStep, OllamaModel } from "@/src/types/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import { findModel, isReasoningModel } from "@/src/lib/models";
import {
  appendResponseSteps,
  insertMetaStep,
  mergeStreamingSteps,
  settleInterruptedSteps,
  upsertStableSteps,
} from "@/src/lib/stream-steps";

interface ChatGenerationDeps {
  backendClient: BackendClient;
  send: (data: unknown) => boolean;
  connected: boolean;
  availableModels: OllamaModel[];
  updateConversation: (id: string, updater: (conversation: Conversation) => Conversation) => void;
  defaultExpanded: (step: ConversationStep) => boolean;
  setError: (message: string) => void;
}

/**
 * Owns one generation at a time: sends a conversation to the backend, folds
 * the streamed steps into it as they arrive, and settles it on completion,
 * stop, failure or a lost connection.
 */
export function useChatGeneration({
  backendClient,
  send,
  connected,
  availableModels,
  updateConversation,
  defaultExpanded,
  setError,
}: ChatGenerationDeps) {
  const [streaming, setStreaming] = useState(false);
  const [stoppedConversationId, setStoppedConversationId] = useState<string | null>(null);
  // Identifies the generation that currently owns the UI; a superseded one must not settle it.
  const stopStreamRef = useRef<(() => void) | null>(null);

  const updateSteps = useCallback(
    (conversationId: string, compute: (steps: ConversationStep[]) => ConversationStep[]) => {
      updateConversation(conversationId, (conversation) => ({
        ...conversation,
        steps: compute(conversation.steps),
        updatedAt: new Date().toISOString(),
      }));
    },
    [updateConversation]
  );

  async function streamConversationResponse(nextConversation: Conversation) {
    setError("");
    setStreaming(true);
    setStoppedConversationId(null);

    const activeTools = nextConversation.availableTools.filter((tool) =>
      nextConversation.activeToolIds.includes(tool.id)
    );

    if (!connected) {
      setError("Backend is not connected. Make sure the server is running (make dev).");
      setStreaming(false);
      return;
    }

    const streamModel = findModel(availableModels, nextConversation.model, nextConversation.provider);
    const streamReasoningSupported = streamModel ? isReasoningModel(streamModel) : false;

    const { promise, stop } = backendClient.startStream(send, {
      conversationId: nextConversation.id,
      model: nextConversation.model,
      provider: nextConversation.provider,
      steps: nextConversation.steps,
      tools: activeTools,
      temperature: nextConversation.temperature,
      maxOutputTokens: nextConversation.maxOutputTokens,
      reasoningEffort: streamReasoningSupported ? nextConversation.reasoningEffort : undefined,
      maxModelInvocations: nextConversation.maxModelInvocations,
      maxToolCalls: nextConversation.maxToolCalls,
      onDelta: (partialSteps) =>
        updateSteps(nextConversation.id, (steps) => mergeStreamingSteps(steps, partialSteps, defaultExpanded)),
      onStableSteps: (stableSteps) =>
        updateSteps(nextConversation.id, (steps) => upsertStableSteps(steps, stableSteps, defaultExpanded)),
      onMetaEvent: (metaStep) =>
        updateSteps(nextConversation.id, (steps) => insertMetaStep(steps, metaStep, defaultExpanded)),
    });
    stopStreamRef.current = stop;

    try {
      const responseSteps = await promise;
      if (stopStreamRef.current !== stop) return;
      updateSteps(nextConversation.id, (steps) => appendResponseSteps(steps, responseSteps, defaultExpanded));
    } catch (streamError) {
      if (stopStreamRef.current !== stop) return;
      const isAbort =
        streamError instanceof Error && streamError.message === "AbortError";
      const connectionLost = streamError instanceof Error && streamError.name === "ConnectionLostError";
      const message = isAbort
        ? "Generation stopped."
        : connectionLost ? streamError.message
          : streamError instanceof Error ? `Failed to stream from backend: ${streamError.message}` : "Failed to stream from backend.";
      setError(message);
      // Preserve genuine partial prose only when the connection dropped mid-response.
      updateSteps(nextConversation.id, (steps) => settleInterruptedSteps(steps, connectionLost));
      if (isAbort) {
        setStoppedConversationId(nextConversation.id);
      }
    } finally {
      if (stopStreamRef.current === stop) {
        stopStreamRef.current = null;
        setStreaming(false);
      }
    }
  }

  function stopGeneration() {
    stopStreamRef.current?.();
  }

  /** Continues a stopped conversation from its current steps. */
  async function resumeGeneration(conversation: Conversation) {
    setStoppedConversationId(null);
    await streamConversationResponse(conversation);
  }

  return { streaming, stoppedConversationId, streamConversationResponse, stopGeneration, resumeGeneration };
}
