"use client";

import { Box, LinearProgress, Typography } from "@mui/material";
import { contentColumnWidth } from "@/src/components/layout";
import type { ContextFill, ContextFillLevel, ResolvedContextWindow } from "@/src/lib/context-window";

interface ContextMeterProps {
  /** The conversation's fill, or `undefined` while the window is still being resolved. */
  fill: ContextFill | undefined;
  /** Only its provenance is shown; the window size itself never is. */
  window: Pick<ResolvedContextWindow, "source" | "stale"> | undefined;
  /** Both sidebars are open, so the column may use its wider measure. */
  wide: boolean;
}

const LEVEL_COLOR: Record<ContextFillLevel, "success" | "warning" | "error"> = {
  ok: "success",
  warn: "warning",
  error: "error",
};

/** The word that qualifies the numbers, when the window they are measured against is not firm. */
function provenanceLabel(window: ContextMeterProps["window"]): string | undefined {
  if (!window) return undefined;
  if (window.source === "estimated" || window.source === "assumed") return window.source;
  if (window.source === "runtime" && window.stale) return "stale";
  return undefined;
}

/**
 * Tokens used and the percentage of the context window. Purely presentational: it renders the
 * fill and window it is given. `data-level` (ok / warn / error) is absent while the fill is
 * unknown or still loading, so a missing value is never shown as a healthy one.
 */
export function ContextMeter({ fill, window, wide }: ContextMeterProps) {
  const known = fill !== undefined && !("unknown" in fill);
  const label = provenanceLabel(window);
  const loading = fill === undefined;
  const text = known ? `${fill.usedTokens.toLocaleString("en-US")} tokens · ${fill.percent}%` : loading ? "…" : "—";

  return (
    <Box
      data-testid="context-meter"
      data-level={known ? fill.level : undefined}
      sx={{
        flexShrink: 0,
        width: "100%",
        maxWidth: contentColumnWidth(wide),
        px: 2,
        transition: "max-width 0.35s ease",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "baseline", gap: 1 }}>
        <Typography variant="caption" color="text.secondary">
          Context
        </Typography>
        <Typography
          variant="caption"
          sx={{ fontVariantNumeric: "tabular-nums" }}
          aria-label={loading ? "Context usage loading" : undefined}
          data-testid="context-meter-value"
        >
          {text}
        </Typography>
        {label ? (
          <Typography variant="caption" color="text.secondary" data-testid="context-meter-source">
            {label}
          </Typography>
        ) : null}
      </Box>
      <LinearProgress
        variant="determinate"
        value={known ? Math.min(100, Math.max(0, fill.percent)) : 0}
        color={known ? LEVEL_COLOR[fill.level] : "inherit"}
        aria-label="Context used"
        aria-valuetext={known ? `${fill.percent}% used, ${fill.level}` : loading ? "loading" : "unknown"}
        sx={{ height: 6, borderRadius: 3, mt: 0.5 }}
      />
    </Box>
  );
}
