"use client";

import { useCallback, useRef, useState } from "react";
import type { CompactionPayload, ContextWindowSource, Conversation, ConversationStep, OllamaModel, RequestContextRecord } from "@/src/types/chat";
import type { BackendClient } from "@/src/lib/backend-client";
import { isCompactContextEnabled } from "@/shared/context-usage";
import { buildCompactionHarnessStep, buildFork } from "@/src/lib/fork";
import { findModel, isReasoningModel } from "@/src/lib/models";
import {
  appendResponseSteps,
  insertMetaStep,
  mergeStreamingSteps,
  settleInterruptedSteps,
  upsertStableSteps,
} from "@/src/lib/stream-steps";

/** The `chat.send` fields the server uses for the usage note and placement (from the context-window resolution). */
export interface ContextRequestFields {
  contextWindow?: number;
  contextWindowSource?: ContextWindowSource;
  modelFamily?: string;
}

interface ChatGenerationDeps {
  backendClient: BackendClient;
  send: (data: unknown) => boolean;
  connected: boolean;
  availableModels: OllamaModel[];
  updateConversation: (id: string, updater: (conversation: Conversation) => Conversation) => void;
  defaultExpanded: (step: ConversationStep) => boolean;
  setError: (message: string) => void;
  /** Window and family for `conversation`, as resolved by `useContextWindow`; none when unresolved. */
  getContextRequest?: (conversation: Conversation) => ContextRequestFields;
  /** Puts a conversation forked by `compact_context` into the list and selects it; nothing is sent for it. */
  onFork?: (fork: Conversation) => void;
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
  getContextRequest,
  onFork,
}: ChatGenerationDeps) {
  const [streaming, setStreaming] = useState(false);
  const [stoppedConversationId, setStoppedConversationId] = useState<string | null>(null);
  // Counts generations that settled (done, stopped or failed); lets observers (the context meter) refresh once per generation.
  const [settledCount, setSettledCount] = useState(0);
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

    const activeTools = nextConversation.availableTools.filter((tool) => nextConversation.activeToolIds.includes(tool.id));

    if (!connected) {
      setError("Backend is not connected. Make sure the server is running (make dev).");
      setStreaming(false);
      return;
    }

    const streamModel = findModel(availableModels, nextConversation.model, nextConversation.provider);
    const streamReasoningSupported = streamModel ? isReasoningModel(streamModel) : false;

    const contextRequest = getContextRequest?.(nextConversation) ?? {};
    // Remember what determined this request's usage note, so a later view of it (reconciliation) reproduces the note.
    const requestContext: RequestContextRecord = {
      startIndex: nextConversation.steps.length,
      compactEnabled: isCompactContextEnabled(activeTools),
      contextWindow:
        contextRequest.contextWindow === undefined || contextRequest.contextWindowSource === undefined
          ? undefined
          : { tokens: contextRequest.contextWindow, source: contextRequest.contextWindowSource },
      modelFamily: contextRequest.modelFamily,
    };
    updateConversation(nextConversation.id, (conversation) => ({
      ...conversation,
      // A request over a shorter (edited / regenerated) history supersedes the records past its end.
      requestContexts: [
        ...(conversation.requestContexts ?? []).filter((record) => record.startIndex < requestContext.startIndex),
        requestContext,
      ],
    }));

    // The compaction payload is only stashed here: whether it forks is decided once this generation
    // is known to still own the UI and its response steps have been applied (below).
    const pending: { compaction?: CompactionPayload } = {};

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
      ...contextRequest,
      onCompaction: (compaction) => {
        pending.compaction = compaction;
      },
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
      if (pending.compaction && onFork) {
        // The original settles normally in its own `finally`; the fork is only recorded and selected, and
        // nothing is sent for it until the user writes in it.
        const fork = buildFork(nextConversation, pending.compaction);
        // The harness event closes the original's turn: after its chat.done steps, before the fork is in state.
        updateSteps(nextConversation.id, (steps) => [...steps, buildCompactionHarnessStep(fork)]);
        onFork(fork);
      }
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
        // Exactly once per owned generation, whether it completed, was stopped or failed.
        setSettledCount((count) => count + 1);
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

  return { streaming, settledCount, stoppedConversationId, streamConversationResponse, stopGeneration, resumeGeneration };
}
