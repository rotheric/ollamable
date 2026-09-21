/**
 * token-view — separator formatting, whitespace markers, and boundary-source
 * resolution for the `showTokens` transcript display mode (epic-token-view,
 * story S2).
 *
 * Owns (per AC-STRUCT-3): the │ separator formatter, the ↵/· whitespace
 * markers, and boundary-source resolution (stream/computed/pending/
 * unavailable). None of this logic may be duplicated inline in
 * chat-workspace.tsx — that file only calls these exports.
 *
 * S2 does not depend on S3: the `computed` boundary source is exercised
 * exclusively through an injected fake in tests/unit/token-view.test.tsx.
 * Production wiring in chat-workspace.tsx passes no `computedSource` yet, so
 * only the stream/unavailable sources occur there; supplying the real
 * useTokenBoundaries computed branch backed by backend-client.tokenize().
 */

import { useEffect, useRef, useState } from "react";
import type { ConversationStep } from "@/src/types/chat";

/** Token-boundary separator. U+2502 BOX DRAWINGS LIGHT VERTICAL — never ASCII '|'. */
export const SEPARATOR = "│";

/** Inserted immediately before every literal '\n' in content. U+21B5. */
export const NEWLINE_MARKER = "↵";

/** Substituted 1:1 for each space that is part of a run of 2+ consecutive spaces. U+00B7. */
export const SPACE_RUN_MARKER = "·";

export type BoundarySource = "stream" | "computed" | "pending" | "unavailable";

export interface TokenBoundaryResult {
  source: BoundarySource;
  /** Token strings for stream/computed; [] for pending/unavailable. */
  tokens: string[];
  /** Set only when source === "unavailable". */
  reason?: string;
}

/**
 * Covers BOTH `unavailable` sub-cases with one message: (1) nothing was ever
 * attempted, and (2) a computed round trip was attempted and errored. Only (1)
 * is reachable while no caller supplies a `computedSource` that can fail.
 *
 * AC-ERR-1 requires "a visible notice naming the reason" (singular) and does
 * not require the sub-cases be distinguishable, so one constant satisfies it
 * today — a deferred decision, not a defect.
 * Revisit once a `computedSource` that can fail is wired: that is when a
 * computed-failure message may need splitting out from never-attempted.
 */
export const UNAVAILABLE_REASON =
  "No token boundaries are available for this step (nothing was captured while streaming, and no computed round trip has run).";

/**
 * Reason surfaced when a resolved computed round trip's tokens don't
 * reconstruct the step's content (tokens.join("") !== step.content) — e.g.
 * S3 tokenizing filtered/reconciled text that diverges from the displayed
 * preview (AC-TOK-5). Distinct from UNAVAILABLE_REASON so the notice names
 * the actual reason rather than the generic "nothing captured" one.
 */
export const COMPUTED_MISMATCH_REASON =
  "Computed token boundaries did not reconstruct this step's content, so they were discarded instead of being shown as if they matched.";

export const STREAM_LABEL = "stream boundaries";
export const STREAM_CAVEAT =
  "A single stream delta may merge more than one model token, so these boundaries are not guaranteed to match the model's exact emitted tokens.";

export const COMPUTED_LABEL = "computed boundaries";
export const COMPUTED_NOTICE =
  "Computed under the conversation's current model, tokenizing this step's text as a standalone string — not the model's exact emitted tokens.";

/**
 * Pure resolution: stream wins whenever `step.contentTokens` is defined,
 * read live off the array on every call (never cached by step id alone —
 * `contentTokens` can grow under a stable id while a component holds a
 * reference, per architecture.md's invariant-delta-step-identity carry-
 * forward). Otherwise defers to the supplied `computedState`; with none
 * supplied, resolves to `unavailable` (no re-tokenization fallback,
 * AC-ERR-1).
 */
export function resolveBoundarySource(
  step: ConversationStep,
  computedState?: { status: "pending" | "resolved" | "error"; tokens?: string[] }
): TokenBoundaryResult {
  if (step.contentTokens !== undefined) {
    return { source: "stream", tokens: step.contentTokens };
  }
  if (computedState === undefined) {
    return { source: "unavailable", tokens: [], reason: UNAVAILABLE_REASON };
  }
  if (computedState.status === "pending") {
    return { source: "pending", tokens: [] };
  }
  if (computedState.status === "resolved") {
    const tokens = computedState.tokens ?? [];
    // Validated here — where the source is decided — rather than left to
    // formatTokenViewText alone, so the label and the rendering can never
    // disagree: a degrade to unseparated content must come with a notice
    // naming that reason, not a "computed boundaries" label sitting above
    // text it doesn't describe. The `stream` branch above is exempt: S1's
    // invariant-content-tokens-join guarantees stream tokens always join to
    // content, so there's nothing to validate there.
    if (tokens.join("") !== step.content) {
      if (process.env.NODE_ENV !== "production") {
        console.error(
          "resolveBoundarySource: computed tokens.join('') !== step.content — resolving to unavailable instead of a mislabeled computed source",
          { content: step.content, tokens }
        );
      }
      return { source: "unavailable", tokens: [], reason: COMPUTED_MISMATCH_REASON };
    }
    return { source: "computed", tokens };
  }
  return { source: "unavailable", tokens: [], reason: UNAVAILABLE_REASON };
}

export interface UseTokenBoundariesOptions {
  /**
   * Injected computed-boundary provider. Only ever supplied in this
   * module's own tests, or by real wiring once a caller supplies one —
   * chat-workspace.tsx's call site passes none today.
   */
  computedSource?: (step: ConversationStep) => Promise<string[]>;
}

/**
 * Hook shell exposing a computed slot this story's own tests satisfy with
 * an injected fake. Keys the pending/resolved cache by
 * (step.id, step.content) — not step.id alone — so a stale in-flight
 * request for since-mutated content is ignored on resolution rather than
 * overwriting a newer result.
 */
export function useTokenBoundaries(
  step: ConversationStep,
  options?: UseTokenBoundariesOptions
): TokenBoundaryResult {
  const computedSource = options?.computedSource;
  const key = `${step.id}:${step.content}`;
  // Presence, not identity: a boolean has stable identity across renders,
  // so it can sit in the fetch effect's deps without reintroducing the
  // unbounded re-fire loop the ref below guards against, while still
  // signaling the transition that matters — `computedSource` arriving
  // (undefined -> function) or leaving. Comparing the ref's *contents*
  // across renders is not an option (that's exactly what the ref exists
  // to avoid re-triggering on); this is the one property of a fresh
  // per-render lambda that's cheap and stable to track.
  const hasComputedSource = computedSource !== undefined;

  // Holds the latest `computedSource` without making it a dependency of the
  // fetch effect below. `computedSource` is a caller-supplied function —
  // S3's real wiring passes an inline lambda (a fresh identity on every
  // render), and including it in that effect's deps would re-fire the
  // fetch/setState cycle every render, unboundedly. Reading through a ref
  // keeps the fetch effect keyed only on `key` + `hasComputedSource` (step
  // identity + content + whether a source is supplied at all), while still
  // calling whatever `computedSource` the latest render passed.
  const computedSourceRef = useRef(computedSource);
  useEffect(() => {
    computedSourceRef.current = computedSource;
  });

  const [computedState, setComputedState] = useState<
    { status: "pending" | "resolved" | "error"; tokens?: string[] } | null
  >(null);
  const [computedKey, setComputedKey] = useState<string | null>(null);

  useEffect(() => {
    if (step.contentTokens !== undefined) return;
    const source = computedSourceRef.current;
    if (!source) return;

    let cancelled = false;
    source(step)
      .then((tokens) => {
        if (cancelled) return;
        setComputedKey(key);
        setComputedState({ status: "resolved", tokens });
      })
      .catch(() => {
        if (cancelled) return;
        setComputedKey(key);
        setComputedState({ status: "error" });
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, step.contentTokens, hasComputedSource]);

  if (step.contentTokens !== undefined) {
    return resolveBoundarySource(step);
  }
  if (!computedSource) {
    return resolveBoundarySource(step);
  }

  const currentState = computedKey === key ? computedState ?? undefined : undefined;
  return resolveBoundarySource(step, currentState ?? { status: "pending" });
}

/**
 * Single-pass formatter producing one display string. Inserts SEPARATOR at
 * token-boundary offsets derived from `tokens` (skipped when `tokens` is
 * null — unavailable/pending sources render unseparated). Unconditionally
 * augments every '\n' with a preceding NEWLINE_MARKER and substitutes
 * SPACE_RUN_MARKER 1:1 for each space in a run of 2+ — both independent of
 * `tokens`/boundary source, per AC-UX-4's unconditional phrasing (whitespace
 * markers apply even to unavailable/pending steps; only the │ separator is
 * gated on having real boundaries).
 *
 * Precondition when `tokens` is non-null: `tokens.join("") === content`
 * (the producer's contract — the stream join invariant, the injected fake's
 * contract for computed). `stream` always satisfies this via S1's join
 * invariant; `computed` does not have that guarantee once S3 tokenizes
 * standalone text (AC-TOK-5 already flags the wrong-source risk there).
 *
 * `resolveBoundarySource`'s computed branch validates this same precondition
 * before this formatter ever runs, so a mismatch there resolves to
 * `unavailable` with COMPUTED_MISMATCH_REASON — keeping the visible label
 * and the rendered content in agreement. The guard here is defense in
 * depth for any caller that builds `tokens` outside that resolution path
 * (e.g. a future direct producer, or a test): on violation it degrades to
 * the unseparated AC-ERR-1 presentation rather than inserting boundaries at
 * arbitrary offsets — a mismatch would otherwise look like a plausible-but-
 * fabricated tokenization instead of failing loudly. It has no notice
 * channel of its own, which is exactly why the primary check lives
 * upstream in `resolveBoundarySource`.
 */
export function formatTokenViewText(content: string, tokens: string[] | null): string {
  if (tokens !== null && tokens.join("") !== content) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "formatTokenViewText: tokens.join('') !== content — degrading to unseparated rendering instead of fabricating boundaries",
        { content, tokens }
      );
    }
    tokens = null;
  }

  const boundaryOffsets = new Set<number>();
  if (tokens !== null) {
    let cumulative = 0;
    for (let i = 0; i < tokens.length - 1; i++) {
      cumulative += tokens[i].length;
      if (cumulative > 0) {
        boundaryOffsets.add(cumulative);
      }
    }
  }

  const markableSpace = new Array<boolean>(content.length).fill(false);
  let runStart = -1;
  for (let i = 0; i <= content.length; i++) {
    const isSpace = i < content.length && content[i] === " ";
    if (isSpace) {
      if (runStart === -1) runStart = i;
    } else if (runStart !== -1) {
      if (i - runStart >= 2) {
        for (let j = runStart; j < i; j++) markableSpace[j] = true;
      }
      runStart = -1;
    }
  }

  let out = "";
  for (let i = 0; i < content.length; i++) {
    if (tokens !== null && i !== 0 && boundaryOffsets.has(i)) {
      out += SEPARATOR;
    }
    const ch = content[i];
    if (ch === "\n") {
      out += NEWLINE_MARKER;
      out += "\n";
    } else if (ch === " " && markableSpace[i]) {
      out += SPACE_RUN_MARKER;
    } else {
      out += ch;
    }
  }
  return out;
}

/**
 * Visible label/caveat for a resolved boundary source. `null` for
 * `pending` — AC-ERR-1 requires no notice while a round trip is in
 * flight, so toggling doesn't flash a notice for every step.
 */
export function getBoundaryNotice(result: TokenBoundaryResult): { label: string; detail: string } | null {
  switch (result.source) {
    case "stream":
      return { label: STREAM_LABEL, detail: STREAM_CAVEAT };
    case "computed":
      return { label: COMPUTED_LABEL, detail: COMPUTED_NOTICE };
    case "unavailable":
      return { label: "boundaries unavailable", detail: result.reason ?? UNAVAILABLE_REASON };
    case "pending":
      return null;
  }
}
