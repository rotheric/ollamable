"use client";

import { useMemo } from "react";
import { Alert } from "@mui/material";
import type { Conversation, OllamaModel, ToolDefinition } from "@/src/types/chat";
import type { ResolvedContextWindow } from "@/src/lib/context-window";
import { placementInputForPreview } from "@/src/lib/token-view";
import { JsonPreviewDialog } from "@/src/components/json-preview-dialog";
import { RequestPreviewExtras } from "@/src/components/request-preview-extras";
import { isReasoningModel } from "@/src/lib/models";
import { buildOpenAIRequestBody } from "@/shared/openai-format";
import { placeStepsForModel } from "@/shared/context-usage";

interface RequestJsonDialogProps {
  open: boolean;
  onClose: () => void;
  conversation: Conversation | null;
  /** The conversation's model, when discovery knows it. */
  model: OllamaModel | undefined;
  activeTools: ToolDefinition[];
  /** The resolved window (same resolution as the meter); absent while unresolved. */
  contextWindow?: Pick<ResolvedContextWindow, "tokens" | "source">;
  showTokens: boolean;
  tokenizeText: (text: string) => Promise<string[]>;
}

/**
 * The request the next send would make, as an OpenAI-compatible body. With the
 * token view on, Ollama conversations also show token boundaries, the chat
 * template and the prompt-token reconciliation.
 */
export function RequestJsonDialog({
  open,
  onClose,
  conversation,
  model,
  activeTools,
  contextWindow,
  showTokens,
  tokenizeText,
}: RequestJsonDialogProps) {
  // The preview panel's figures/rendering are all Ollama-specific (built from
  // toOllamaFilteredMessages, labelled prompt_eval_count) — gating on this
  // avoids showing them, mislabelled, for an openai-compat conversation.
  // Keys on provider ID; ProviderConfig.type is not surfaced to the frontend.
  const isOllamaModel = model ? model.provider === "ollama" : true;

  const json = useMemo(() => {
    if (!conversation) {
      return "";
    }

    return JSON.stringify(
      buildOpenAIRequestBody({
        model: conversation.model,
        steps: placeStepsForModel(
          conversation.steps,
          placementInputForPreview(conversation.steps, { activeTools, contextWindow, family: model?.family })
        ),
        tools: activeTools,
        temperature: conversation.temperature,
        maxOutputTokens: conversation.maxOutputTokens,
        reasoningEffort: model && isReasoningModel(model)
          ? conversation.reasoningEffort
          : undefined,
      }),
      null,
      2
    );
  }, [activeTools, model, conversation, contextWindow]);

  return (
    <JsonPreviewDialog
      open={open}
      onClose={onClose}
      title="Request JSON"
      subtitle="OpenAI-compatible format"
      json={json}
      extra={
        showTokens && conversation ? (
          isOllamaModel ? (
            <RequestPreviewExtras
              open={open}
              steps={conversation.steps}
              model={model}
              activeTools={activeTools}
              contextWindow={contextWindow}
              requestContexts={conversation.requestContexts}
              tokenizeText={tokenizeText}
            />
          ) : (
            <Alert severity="info" data-testid="request-preview-ollama-only">
              Token boundaries, the chat template, and reconciliation are only available for Ollama-provider conversations.
            </Alert>
          )
        ) : undefined
      }
    />
  );
}
