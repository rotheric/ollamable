"use client";

/**
 * TokenViewStepContent — presentational glue for the `showTokens` transcript
 * display mode (epic-token-view, story S2). Pure render: resolves the token
 * boundary via `useTokenBoundaries`, formats it via `formatTokenViewText`,
 * and renders the boundary notice via `getBoundaryNotice`. All formatting
 * and resolution logic itself lives in `src/lib/token-view.ts` — this
 * component only calls those exports (AC-STRUCT-3).
 *
 * Presentational only: all separator/marker/boundary logic lives in
 * src/lib/token-view.ts. Kept out of chat-workspace.tsx to bound that
 * file's growth.
 */

import { Box, Typography } from "@mui/material";
import type { ConversationStep } from "@/src/types/chat";
import { formatTokenViewText, getBoundaryNotice, useTokenBoundaries } from "@/src/lib/token-view";

export interface TokenViewStepContentProps {
  step: ConversationStep;
  /**
   * Tokenizes standalone text against the conversation's current model
   * (backend-client.tokenize(), story S3). Only ever consulted for step
   * kinds that never receive stream-captured `contentTokens` in the first
   * place: `assistant`/`reasoning` steps are deliberately excluded below,
   * regardless of what the caller passes, because AC-ERR-1 forbids
   * substituting a re-tokenized boundary for a persisted assistant step
   * that lost its stream tokens — that must render `unavailable`, never
   * `computed`. Today only `user` steps reach this component at all
   * (chat-workspace.tsx's render-branch gate), so in practice this is the
   * only kind that ever gets a computed round trip.
   */
  tokenizeText?: (text: string) => Promise<string[]>;
  /**
   * Forwarded to useTokenBoundaries' cache key (S3-F3) — the conversation's
   * current model, so switching models invalidates any already-resolved
   * computed result instead of leaving stale boundaries displayed under
   * COMPUTED_NOTICE's "current model" claim.
   */
  cacheKeySuffix?: string;
}

export function TokenViewStepContent({ step, tokenizeText, cacheKeySuffix }: TokenViewStepContentProps) {
  const eligibleForComputed = step.kind !== "assistant" && step.kind !== "reasoning";
  const computedSource =
    tokenizeText && eligibleForComputed ? (s: ConversationStep) => tokenizeText(s.content) : undefined;
  const boundary = useTokenBoundaries(step, { computedSource, cacheKeySuffix });
  const tokens = boundary.source === "stream" || boundary.source === "computed" ? boundary.tokens : null;
  const text = formatTokenViewText(step.content, tokens);
  const notice = getBoundaryNotice(boundary);
  return (
    <Box>
      {notice ? (
        <Typography
          variant="caption"
          color="text.secondary"
          data-testid="notice"
          sx={{ display: "block", mb: 0.5 }}
        >
          {notice.label} — {notice.detail}
        </Typography>
      ) : null}
      <Typography
        variant="body1"
        component="div"
        data-testid="token-text"
        sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.7, color: "text.primary" }}
      >
        {text}
      </Typography>
    </Box>
  );
}
