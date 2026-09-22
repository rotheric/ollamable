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
 * S2's own tests exercise the `computed` boundary source exclusively
 * through an injected fake (tests/unit/token-view.test.tsx). Story S3
 * folded in the real production wiring: chat-workspace.tsx's
 * `TokenViewStepContent` call site (`~2264`) passes `tokenizeStepText`
 * (backend-client.tokenize() against the conversation's current model) as
 * `computedSource`, so `computed` is now reachable in production, not
 * only under test.
 *
 * Story S4 adds the request-preview panel's reconciliation arithmetic and
 * outgoing-message filtering (toOllamaFilteredMessages, findLastUsageStep,
 * turnHasToolCall, useTokenizedMessages, useReconciliation) at the bottom
 * of this file, per AC-STRUCT-3 and the story's own notes ("keep the
 * reconciliation arithmetic and template-lookup logic in a lib helper
 * rather than inline in chat-workspace.tsx"). src/components/request-
 * preview-extras.tsx is the presentational glue that calls these exports,
 * kept out of chat-workspace.tsx for the same reason token-view-step-
 * content.tsx was (S2): to bound that file's growth.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationStep } from "@/src/types/chat";
// Relative (not the usual "@/..." alias): this module is also loaded
// directly by tests/integration/*.test.ts under vitest.server.config.ts
// (node env, reconciliation-live.test.ts's existing precedent), which has
// no path-alias plugin configured — a value import (unlike the type-only
// ConversationStep import above) needs to resolve at runtime there too.
import { toOllamaMessages } from "../../shared/ollama-format";

/** Token-boundary separator. U+2502 BOX DRAWINGS LIGHT VERTICAL — never ASCII '|'. */
export const SEPARATOR = "│";

/** Inserted immediately before every literal '\n' in content. U+21B5. */
export const NEWLINE_MARKER = "↵";

/** Substituted 1:1 for each space that is part of a run of 2+ consecutive spaces. U+00B7. */
export const SPACE_RUN_MARKER = "·";

/**
 * Delay (ms) before a newly-mounted/changed computed round trip actually
 * fires (story S3). No debounce utility existed anywhere in this repo
 * before this epic (architecture.md Implementation Constraint 6);
 * `setTimeout` + cleanup is sufficient for this single call site.
 */
export const COMPUTED_SOURCE_DEBOUNCE_MS = 150;

export type BoundarySource = "stream" | "computed" | "pending" | "unavailable";

export interface TokenBoundaryResult {
  source: BoundarySource;
  /** Token strings for stream/computed; [] for pending/unavailable. */
  tokens: string[];
  /** Set only when source === "unavailable". */
  reason?: string;
}

/**
 * Covers the "nothing was ever attempted" `unavailable` sub-case: no
 * `computedSource` was supplied at all, or the step carries neither
 * `contentTokens` nor any computed state yet. Kept distinct from
 * `COMPUTED_FAILED_REASON` below so a round trip that ran and failed is
 * never reported as if nothing had been attempted.
 */
export const UNAVAILABLE_REASON =
  "No token boundaries are available for this step (nothing was captured while streaming, and no computed round trip has run).";

/**
 * Reason surfaced when a computed round trip was actually attempted and
 * failed (the `computedSource` promise rejected — e.g. a `tokenize.error`
 * from the server, or a dropped WebSocket connection). Distinct from
 * `UNAVAILABLE_REASON` so the notice never claims nothing was attempted
 * when something was attempted and failed.
 */
export const COMPUTED_FAILED_REASON =
  "A computed round trip for this step's tokens failed, so no boundaries are shown.";

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
  if (computedState.status === "error") {
    // A round trip was actually attempted and failed — never reported as
    // UNAVAILABLE_REASON's "nothing was captured... no computed round
    // trip has run", which would tell the user something false.
    return { source: "unavailable", tokens: [], reason: COMPUTED_FAILED_REASON };
  }
  return { source: "unavailable", tokens: [], reason: UNAVAILABLE_REASON };
}

export interface UseTokenBoundariesOptions {
  /**
   * Injected computed-boundary provider. Exercised via an injected fake in
   * this module's own tests; chat-workspace.tsx's production call site
   * passes `tokenizeStepText` (backend-client.tokenize() against the
   * conversation's current model, story S3).
   */
  computedSource?: (step: ConversationStep) => Promise<string[]>;
  /**
   * Included in the pending/resolved cache key alongside (step.id,
   * step.content), so a change invalidates any already-resolved computed
   * result instead of leaving it displayed as still current. Production
   * wiring passes the conversation's current model: `computedSource`
   * closes over the model already (chat-workspace.tsx's `tokenizeStepText`),
   * but switching models re-creates that closure with a NEW identity while
   * `key` stays the same (step.id/content are unaffected) — without this
   * suffix in the key, the hook would keep serving a computed result
   * resolved under the OLD model while COMPUTED_NOTICE claims it was
   * computed under the conversation's CURRENT one.
   */
  cacheKeySuffix?: string;
}

/**
 * Hook backing the `computed` boundary source: debounces a caller-supplied
 * `computedSource` round trip and caches its result. Exercised via an
 * injected fake in this module's own tests; chat-workspace.tsx wires the
 * real production path (backend-client.tokenize(), story S3). Keys the
 * pending/resolved cache by (step.id, step.content, cacheKeySuffix) — not
 * step.id alone — so a stale in-flight request for since-mutated content,
 * or a since-invalidated `cacheKeySuffix` (e.g. a model switch), is
 * ignored on resolution rather than overwriting a newer result.
 */
export function useTokenBoundaries(
  step: ConversationStep,
  options?: UseTokenBoundariesOptions
): TokenBoundaryResult {
  const computedSource = options?.computedSource;
  const key = `${step.id}:${step.content}:${options?.cacheKeySuffix ?? ""}`;
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
    // Debounced (story S3, AC-STRUCT-3): the real computedSource is a
    // network round trip (backend-client.tokenize()). Each mounted step
    // owns its own hook instance and its own timer, so this delay does
    // NOT coalesce concurrent requests across steps — toggling showTokens
    // on a transcript with N visible steps still issues N tokenize
    // requests, just after a shared delay. What it actually does: a step
    // that unmounts or re-keys (content/id change) before the timer
    // elapses never issues its request at all, so rapid remounts/edits
    // within the window are suppressed rather than each firing its own
    // round trip. The per-(step.id, content) cache above is what avoids
    // repeat requests once a step's boundaries have already resolved.
    const timer = setTimeout(() => {
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
    }, COMPUTED_SOURCE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
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

  // A BPE boundary that splits a multi-byte character makes server/
  // tokenizer.ts's decodeTokens emit "" for the token contributing only
  // partial bytes (by design — that's what keeps the join invariant this
  // formatter's precondition above depends on). A zero-length token
  // advances `cumulative` by 0, so its boundary offset collides with its
  // neighbour's and this Set silently dedups it: the user sees one
  // separator where the model actually produced two tokens. Lossy by
  // design at exactly that boundary — there is no better rendering for
  // half a character — and not an AC-UX-2 violation (that AC forbids a
  // 1:1 element-per-token rendering, not this collapse).
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

// ─────────────────────────────────────────────────────────────────────────
// Story S4 — request-preview panel: outgoing-message filtering, chat-
// template-overhead reconciliation.
// ─────────────────────────────────────────────────────────────────────────

/** A single outgoing message as Ollama's /api/chat would receive it. */
export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
}

/**
 * Filters `steps` exactly as `toOllamaMessages` filters them
 * (AC-TOK-5) — delegates to the single shared implementation in
 * `shared/ollama-format.ts`, consumed identically by
 * server/ollama-client.ts's `buildOllamaChatBody`. Before this delegated
 * to a shared implementation, this was a hand-kept mirror of the
 * server's private function; the two drifted on three points (a pending
 * tool call surviving a following non-empty `system` step, and the
 * `toolCall`/`toolResult` payload guards). Only
 * `role`/`content` are surfaced here (tool-call argument payloads are
 * irrelevant to token counting and to AC-UX-5's │-separated content
 * rendering); `shared/ollama-format.ts`'s `tool_calls`/`tool_name`
 * fields are dropped.
 *
 * This is the ONLY place S4's reconciliation and request-preview
 * rendering may derive their message list from (Implementation
 * Constraint 5) — never `requestJsonPreview`, which is built by
 * `buildOpenAIRequestBody`/`toOpenAIMessages` and filters differently.
 */
export function toOllamaFilteredMessages(steps: ConversationStep[]): OllamaMessage[] {
  return toOllamaMessages(steps).map(({ role, content }) => ({ role, content }));
}

/**
 * Locates the reconciliation oracle: the LAST step reporting
 * `usage.inputTokens` (Ollama's `prompt_eval_count`) — "last" because every
 * completed request stamps usage on its assistant step, so the most recent
 * one closes the most recently completed request. A tool-loop turn's
 * intermediate iterations *usually* lack it (their empty-content assistant
 * step is dropped by compactSteps), but not always: a model that emits both
 * content and a tool call stamps usage on that step too, so "intermediate
 * steps never carry usage" would be the wrong reason to rely on. Returns
 * null when nothing in the conversation has ever reported usage (nothing to
 * reconcile against yet).
 */
export function findLastUsageStep(
  steps: ConversationStep[]
): { index: number; promptEvalCount: number } | null {
  for (let i = steps.length - 1; i >= 0; i--) {
    const inputTokens = steps[i].usage?.inputTokens;
    if (steps[i].kind === "assistant" && inputTokens != null) {
      return { index: i, promptEvalCount: inputTokens };
    }
  }
  return null;
}

/**
 * True when the turn that produced `steps[assistantIndex]` contains a
 * tool call — walking backward from `assistantIndex` to (and including)
 * the nearest preceding `user` step, or to the start of the
 * conversation. Per AC-UX-6/Implementation Constraint 4: a tool-loop
 * turn's usage describes only the last of several requests, so
 * reconciliation must not be attempted for it. Scoped to the turn, not
 * the whole conversation — an EARLIER turn's tool calls don't invalidate
 * a LATER, tool-free turn's reconciliation.
 *
 * Two step shapes carry a tool call, and both are checked:
 * - the legacy standalone `kind === "tool_call"` step, still produced by
 *   tour/example conversations built directly from provider deltas;
 * - the shape the live server actually persists (`ws-handler.ts`'s
 *   loop merges every `tool_call` step into the turn's `assistant` step
 *   as `assistant.toolCalls[]`, per architecture.md's Implementation
 *   Constraint 4 "mints a synthetic replacement carrying `toolCalls`").
 *   A `tool_result` step is also treated as sufficient, since one is
 *   only ever persisted after a tool call.
 */
export function turnHasToolCall(steps: ConversationStep[], assistantIndex: number): boolean {
  for (let i = assistantIndex; i >= 0; i--) {
    const step = steps[i];
    if (step.kind === "tool_call") return true;
    if (step.kind === "tool_result") return true;
    if (step.kind === "assistant" && step.toolCalls && step.toolCalls.length > 0) return true;
    if (step.kind === "user") break;
  }
  return false;
}

/** AC-UX-6's exact label for the computed/reported difference — never "mismatch", "error", or "warning". */
export const TEMPLATE_OVERHEAD_LABEL = "chat-template overhead";

export const RECONCILIATION_TOOL_CALL_REASON =
  "This turn's completion used tool calls, so its reported usage covers only the final request in the tool-call loop — content-token reconciliation is unavailable for it.";

/**
 * Reason surfaced when a tokenize round trip for the reconciliation
 * readout was actually attempted and failed (mirrors
 * `COMPUTED_FAILED_REASON`'s wording/discipline): distinct
 * from leaving `status: "pending"` forever, which would tell the user
 * nothing rather than naming what happened.
 */
export const RECONCILIATION_FAILED_REASON =
  "A computed round trip for this turn's messages failed, so reconciliation could not run.";

/**
 * Reason surfaced when the outgoing-message list's tokenize round trip
 * failed: the │ separators are silently absent from
 * `formatTokenViewText`'s unseparated fallback otherwise, with no
 * indication anything was attempted (AC-ERR-1's discipline).
 */
export const OUTGOING_MESSAGES_FAILED_REASON =
  "A computed round trip for these messages' token boundaries failed, so they are shown without │ separators.";

export interface ReconciliationState {
  status: "none" | "unavailable" | "pending" | "ready" | "error";
  /** Set only when status === "unavailable" or "error". */
  reason?: string;
  contentTokenCount?: number;
  promptEvalCount?: number;
  /** contentTokenCount subtracted from promptEvalCount — the chat-template overhead. */
  overhead?: number;
}

/**
 * Per-(cacheKeySuffix, content) tokenize memo, shared across multiple
 * `useTokenizedMessages` instances that may request overlapping message
 * lists: `RequestPreviewExtras` tokenizes the full outgoing list
 * AND (via `useReconciliation`) the preceding-turn prefix of that same
 * list, so without a shared cache the overlapping messages are tokenized
 * twice — two hook instances, two independent caches, ~2N round trips on
 * dialog open. Callers create one instance (e.g. `useRef(new Map())`)
 * per panel-open lifetime and pass it to every `useTokenizedMessages`/
 * `useReconciliation` call that may share message content; an omitted
 * cache falls back to a hook-local one (no sharing, prior behavior).
 */
export type TokenizeCache = Map<
  string,
  { status: "pending" | "resolved" | "error"; promise: Promise<string[]>; tokens?: string[] }
>;

function tokenizeCached(
  cache: TokenizeCache,
  cacheKeySuffix: string,
  content: string,
  tokenizeText: (text: string) => Promise<string[]>
): Promise<string[]> {
  if (!content) return Promise.resolve([]);
  const key = `${cacheKeySuffix}\u0000${content}`;
  const existing = cache.get(key);
  if (existing) return existing.promise;
  const promise = tokenizeText(content).then(
    (tokens) => {
      cache.set(key, { status: "resolved", promise, tokens });
      return tokens;
    },
    (err) => {
      // Evict rather than cache the rejection: a transient failure (dropped
      // socket, tokenize.error, "no active model") must not be permanent for
      // this (model, content) pair. Mirrors loadVocab's failure-path eviction
      // in server/tokenizer.ts. Retry storms are prevented at the hook level
      // by `failedKey`, not by a poisoned cache entry.
      cache.delete(key);
      throw err;
    }
  );
  cache.set(key, { status: "pending", promise });
  return promise;
}

export interface UseTokenizedMessagesResult {
  messages: Array<OllamaMessage & { tokens: string[] | null }>;
  /**
   * True once the round trip for the CURRENT key has been attempted and
   * failed. Stays true until `key` changes (message contents or
   * `cacheKeySuffix`); never retried automatically. The stickiness
   * is hook-level only — the shared cache EVICTS a rejection rather than
   * storing it, so a later key change genuinely retries.
   */
  failed: boolean;
}

/**
 * Tokenizes a fixed list of outgoing messages via `tokenizeText` and
 * caches the result. Keyed on (message contents, `cacheKeySuffix`) rather
 * than message contents alone — mirrors `useTokenBoundaries`'
 * invariant-computed-boundary-model-key discipline (S3): without the
 * model in the key, switching models while the panel is open would keep
 * serving tokens computed under the OLD model against content that looks
 * unchanged. `active` gates the round trip so it only fires while the
 * panel showing it is actually open.
 *
 * Debounced by `COMPUTED_SOURCE_DEBOUNCE_MS`, same as `useTokenBoundaries`
 * — opening the request-preview dialog mounts this hook (plus, via
 * `useReconciliation`, a second instance) immediately, and without a
 * debounce that fires the tokenize round trip(s) with no coalescing.
 * `tokenizeText` is read through a ref rather than placed in the fetch
 * effect's dependency array (mirrors `useTokenBoundaries`'
 * `computedSourceRef`) — the effect is keyed on `[key, active]`
 * only. PRECONDITION this hook shares with `useTokenBoundaries`:
 * `tokenizeText` need not itself be referentially stable (the ref absorbs
 * a fresh lambda every render) — but the caller must not rely on a change
 * in `tokenizeText`'s behavior alone (with `key`/`active` unchanged) to
 * re-fire the round trip, since it won't.
 */
export function useTokenizedMessages(
  messages: OllamaMessage[],
  tokenizeText: ((text: string) => Promise<string[]>) | undefined,
  active: boolean,
  cacheKeySuffix?: string,
  sharedCache?: TokenizeCache
): UseTokenizedMessagesResult {
  const key = active
    ? `${messages.map((m) => m.content).join("\u0000")}\u0001${cacheKeySuffix ?? ""}`
    : null;
  const [state, setState] = useState<{ key: string; tokens: string[][] } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);

  const tokenizeTextRef = useRef(tokenizeText);
  useEffect(() => {
    tokenizeTextRef.current = tokenizeText;
  });

  const localCacheRef = useRef<TokenizeCache | null>(null);
  if (!sharedCache && !localCacheRef.current) localCacheRef.current = new Map();
  const cache = sharedCache ?? localCacheRef.current!;

  useEffect(() => {
    if (!active || messages.length === 0) return;
    const source = tokenizeTextRef.current;
    if (!source) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      Promise.all(messages.map((m) => tokenizeCached(cache, cacheKeySuffix ?? "", m.content, source)))
        .then((tokens) => {
          if (cancelled) return;
          setState({ key: key!, tokens });
        })
        .catch(() => {
          if (cancelled) return;
          setFailedKey(key);
        });
    }, COMPUTED_SOURCE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active]);

  const resolved = state?.key === key ? state.tokens : null;
  return {
    messages: messages.map((m, i) => ({ ...m, tokens: resolved ? resolved[i] : null })),
    // `key` is null while inactive, and `failedKey` starts null — without the
    // null guard `failed` reads true on every inactive render, flashing the
    // failure notice through MUI's dialog exit transition.
    failed: key !== null && failedKey === key,
  };
}

/**
 * AC-UX-6/AC-TOK-5's reconciliation readout. Computes the content-token
 * count from `steps[0..i)` — `i` being the index of the last step to
 * report usage — filtered via `toOllamaFilteredMessages` (never
 * `requestJsonPreview`), tokenized via `tokenizeText`, and compares the
 * total against that usage's `promptEvalCount`. Reports `unavailable`
 * with a named reason for any tool-loop turn (Implementation
 * Constraint 4) without attempting partial reconciliation, and `error`
 * with `RECONCILIATION_FAILED_REASON` when the tokenize round trip itself
 * failed rather than leaving the panel on `pending` forever.
 *
 * `sharedCache`, when supplied, is forwarded to the internal
 * `useTokenizedMessages` call so a caller that also tokenizes the full
 * outgoing-message list (a superset, in the common case) can dedupe the
 * overlapping round trips — see `TokenizeCache`'s docstring.
 */
export function useReconciliation(
  steps: ConversationStep[],
  tokenizeText: ((text: string) => Promise<string[]>) | undefined,
  active: boolean,
  cacheKeySuffix?: string,
  sharedCache?: TokenizeCache
): ReconciliationState {
  const target = useMemo(() => findLastUsageStep(steps), [steps]);
  const toolCallTurn = target ? turnHasToolCall(steps, target.index) : false;
  const precedingMessages = useMemo(
    () => (target && !toolCallTurn ? toOllamaFilteredMessages(steps.slice(0, target.index)) : []),
    [steps, target, toolCallTurn]
  );
  const { messages: tokenized, failed } = useTokenizedMessages(
    precedingMessages,
    tokenizeText,
    active && !!target && !toolCallTurn,
    cacheKeySuffix,
    sharedCache
  );

  if (!active || !target) return { status: "none" };
  if (toolCallTurn) return { status: "unavailable", reason: RECONCILIATION_TOOL_CALL_REASON };
  if (failed) return { status: "error", reason: RECONCILIATION_FAILED_REASON };
  if (tokenized.some((m) => m.tokens === null)) return { status: "pending" };

  const contentTokenCount = tokenized.reduce((sum, m) => sum + (m.tokens?.length ?? 0), 0);
  return {
    status: "ready",
    contentTokenCount,
    promptEvalCount: target.promptEvalCount,
    overhead: target.promptEvalCount - contentTokenCount,
  };
}
