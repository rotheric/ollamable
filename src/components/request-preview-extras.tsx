"use client";

/**
 * RequestPreviewExtras — │-separated outgoing-message rendering, verbatim
 * chat-template display, and content-token reconciliation for the request-
 * preview dialog (epic-token-view, story S4).
 *
 * Pure render + data-fetch glue: all filtering/tokenization/reconciliation
 * arithmetic lives in src/lib/token-view.ts (AC-STRUCT-3's shared line
 * budget; this story's own notes ask for the arithmetic to live in a lib
 * helper rather than inline in chat-workspace.tsx). This component only
 * calls those exports and src/lib/ollama.ts's existing `fetchModelMeta`
 * (already the /api/show round trip that returns `template`, per
 * architecture.md's instruction to check for that before adding a new
 * server round trip). Kept out of chat-workspace.tsx for the same reason
 * token-view-step-content.tsx was (S2): to bound that file's growth.
 */

import { useEffect, useRef, useState } from "react";
import { Alert, Box, Divider, Stack, Typography } from "@mui/material";
import type { ConversationStep, OllamaModel } from "@/src/types/chat";
import { fetchModelMeta } from "@/src/lib/ollama";
import {
  OUTGOING_MESSAGES_FAILED_REASON,
  TEMPLATE_OVERHEAD_LABEL,
  formatTokenViewText,
  toOllamaFilteredMessages,
  useReconciliation,
  useTokenizedMessages,
  type TokenizeCache,
} from "@/src/lib/token-view";

const MODEL_UNAVAILABLE_REASON =
  "Chat template unavailable — this conversation's model is not in the current model list.";

export interface RequestPreviewExtrasProps {
  /** Gates every round trip below (template fetch, tokenize calls) to when the dialog is actually open. */
  open: boolean;
  steps: ConversationStep[];
  model?: OllamaModel;
  /** backend-client.tokenize() bound to the conversation's current model (chat-workspace.tsx's tokenizeStepText). */
  tokenizeText?: (text: string) => Promise<string[]>;
}

export function RequestPreviewExtras({ open, steps, model, tokenizeText }: RequestPreviewExtrasProps) {
  const [template, setTemplate] = useState<string | undefined>(undefined);
  const [templateError, setTemplateError] = useState("");
  const [templateAbsent, setTemplateAbsent] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Reset every render-relevant piece of state up front, before the new
    // fetch (if any) starts. Without this, switching model A → B left A's
    // stale template on screen until B's fetch resolved, and left it there
    // permanently — under B's own error alert — if B's fetch rejected.
    setTemplate(undefined);
    setTemplateError("");
    setTemplateAbsent(false);
    if (!model) {
      // AC-UX-7: an unresolvable (model, provider) pair — a stale
      // conversation, a provider whose listAllModels failed, a model
      // since removed — must not leave the pane on "Loading…" forever
      // with no explanation.
      setTemplateError(MODEL_UNAVAILABLE_REASON);
      return;
    }
    let cancelled = false;
    fetchModelMeta(model)
      .then((meta) => {
        if (cancelled) return;
        // A resolved fetch whose `template` is undefined means the model
        // genuinely reports none — distinct from "still in flight", which
        // is what an undefined `template` means before this resolves.
        // Conflating the two left the pane on "Loading…" forever for a
        // model with no template.
        if (meta.template === undefined) {
          setTemplateAbsent(true);
        } else {
          setTemplate(meta.template);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setTemplateError(err instanceof Error ? err.message : "Failed to load chat template.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, model]);

  // Shared across both tokenize call sites below: precedingMessages
  // (inside useReconciliation) overlaps outgoingMessages in the common
  // case, and without a shared cache each overlapping message would be
  // tokenized twice — two hook instances, two independent caches, no
  // dedupe. Scoped to this component instance's lifetime (recreated on
  // remount), not module-level, so it never leaks across panels/models.
  const tokenizeCacheRef = useRef<TokenizeCache | null>(null);
  if (!tokenizeCacheRef.current) tokenizeCacheRef.current = new Map();
  const tokenizeCache = tokenizeCacheRef.current;

  const outgoingMessages = toOllamaFilteredMessages(steps);
  const { messages: tokenizedMessages, failed: outgoingTokenizeFailed } = useTokenizedMessages(
    outgoingMessages,
    tokenizeText,
    open,
    model?.name,
    tokenizeCache
  );
  const reconciliation = useReconciliation(steps, tokenizeText, open, model?.name, tokenizeCache);

  return (
    <Stack spacing={2} sx={{ mb: 2 }} data-testid="request-preview-extras">
      <Box>
        <Typography variant="overline" color="text.secondary">
          Outgoing messages (token boundaries) — the request that would be sent next
        </Typography>
        {outgoingTokenizeFailed ? (
          <Alert severity="warning" data-testid="outgoing-messages-failed">
            {OUTGOING_MESSAGES_FAILED_REASON}
          </Alert>
        ) : null}
        {tokenizedMessages.map((message, index) => (
          <Typography
            key={index}
            data-testid="outgoing-message"
            component="pre"
            variant="body2"
            sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}
          >
            {message.role}: {formatTokenViewText(message.content, message.tokens)}
          </Typography>
        ))}
      </Box>
      <Box>
        <Typography variant="overline" color="text.secondary">
          Chat template (verbatim, from /api/show)
        </Typography>
        {templateError ? (
          <Alert severity="warning" data-testid="template-error">
            {templateError}
          </Alert>
        ) : null}
        {templateAbsent ? (
          <Alert severity="info" data-testid="template-absent">
            This model reports no chat template.
          </Alert>
        ) : null}
        <Typography
          data-testid="chat-template"
          component="pre"
          variant="body2"
          sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", fontFamily: "monospace" }}
        >
          {template ?? (templateError || templateAbsent ? "" : "Loading…")}
        </Typography>
      </Box>
      {reconciliation.status === "unavailable" ||
      reconciliation.status === "error" ||
      reconciliation.status === "ready" ? (
        <Typography variant="overline" color="text.secondary">
          Reconciliation for the last completed turn
        </Typography>
      ) : null}
      {reconciliation.status === "unavailable" ? (
        <Alert severity="info" data-testid="reconciliation-unavailable">
          Reconciliation unavailable — {reconciliation.reason}
        </Alert>
      ) : null}
      {reconciliation.status === "error" ? (
        <Alert severity="warning" data-testid="reconciliation-error">
          {reconciliation.reason}
        </Alert>
      ) : null}
      {reconciliation.status === "ready" ? (
        <Typography variant="body2" data-testid="reconciliation-figures">
          Content tokens: {reconciliation.contentTokenCount} · prompt_eval_count:{" "}
          {reconciliation.promptEvalCount} · {TEMPLATE_OVERHEAD_LABEL}: {reconciliation.overhead}
        </Typography>
      ) : null}
      <Divider />
    </Stack>
  );
}
