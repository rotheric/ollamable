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

export function TokenViewStepContent({ step }: { step: ConversationStep }) {
  const boundary = useTokenBoundaries(step);
  const tokens = boundary.source === "stream" || boundary.source === "computed" ? boundary.tokens : null;
  const text = formatTokenViewText(step.content, tokens);
  const notice = getBoundaryNotice(boundary);
  return (
    <Box>
      {notice ? (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          {notice.label} — {notice.detail}
        </Typography>
      ) : null}
      <Typography
        variant="body1"
        component="div"
        sx={{ whiteSpace: "pre-wrap", fontFamily: "monospace", lineHeight: 1.7, color: "text.primary" }}
      >
        {text}
      </Typography>
    </Box>
  );
}
