# Compaction Tool

## Problem

Every request sends the full conversation (`chat.send` carries all `steps`), and nothing in the
app knows how large the model's context window is. The app never sets Ollama's `num_ctx`, so the
effective window is whatever the Ollama server defaults to — and when a prompt exceeds it,
Ollama silently discards the oldest tokens. Long or tool-heavy conversations therefore degrade
without any visible signal: the model "forgets" the task, and neither the learner nor the model
can see why.

The project exists to make LLM internals observable. Context-window pressure and compaction —
how agents such as Claude Code survive long tasks by summarising and starting over — are core
concepts that the app currently neither shows nor lets a learner experiment with.

## Solution

Make context-window usage visible, give the model the information it needs to notice pressure,
and let the model act on it:

1. The frontend resolves each conversation's effective context window and, when the user turns
   the meter on, always shows tokens used and percentage of the window.
2. A model-callable `compact_context` tool lets the model write a summary of the conversation
   and its remaining work. Calling it ends the current turn.
3. The client forks a new conversation seeded with that summary and automatically continues the
   task there. The original conversation stays as it is.
4. While the tool is enabled, the model is told its current context usage on every invocation,
   so it can decide when to compact.

How a summary (and the usage note) is best placed into a model's context is model-dependent;
a research story establishes that before the seeding and injection stories are implemented.

## Scope

### In Scope

- Frontend resolution of the effective context window per conversation from model metadata the
  backend reports, without the app setting `num_ctx` and without triggering model loads.
- Requesting streamed usage from OpenAI-compatible providers (`stream_options.include_usage`).
- A toggleable context meter (tokens used and percentage), computed and rendered by the frontend.
- A research story establishing a default placement for the usage note and the compaction
  summary, plus per-family exceptions where templates diverge.
- A server-injected context-usage note on every model invocation while `compact_context` is
  enabled, reproduced identically in the request JSON preview.
- A built-in server tool `compact_context`; its outcome is carried on `chat.done`.
- Client-side fork + auto-continue: new conversation seeded with the summary and linking back to
  the original; the original untouched.
- A guard against immediately compacting again in the fork.

### Out of Scope

- Automatic (threshold-triggered) or user-triggered compaction — possible future epics that can
  reuse the S6 fork path.
- In-place compaction (replacing or hiding steps inside one conversation).
- Mechanical pruning or sliding-window strategies.
- A separate summarizer invocation or a summarizer model distinct from the conversation's model.
- Exact prompt token counting before a response arrives (the meter uses reported usage).
- Forward links from the original conversation to its forks.
- Exposing or configuring the window size in the UI (a `num_ctx` setting) — deferred.

## Design Decisions

1. **The model writes the summary in the tool arguments.** `compact_context({summary,
   remaining_work})` is authored by the conversation's current model; there is no second
   summarizer invocation. This keeps the summary authentic agent-authored content (AGENTS.md)
   and makes it inspectable in the tool-call card. Weak summaries from small models are an
   accepted, educational outcome.
2. **Display is a frontend concern.** The backend contributes raw facts only: model metadata
   (already served by `POST /models/show`, `server/index.ts`) and per-invocation `usage`
   (`server/response-usage.ts`). Window resolution, fill computation, percentage and all
   formatting live in the frontend. Refs: `src/lib/ollama.ts:67`.
3. **The app does not set `num_ctx`.** Changing `num_ctx` makes Ollama reload the model, so the
   app reads the effective window instead of choosing it. Ollama reports the window of a loaded
   model via `GET /api/ps` (`models[].context_length`, verified on Ollama 0.30.8) — reading it
   loads nothing. The backend exposes this raw fact via `POST /models/runtime`; the window size
   is not shown or configurable in the UI (deferred).
4. **Window resolution has an honest provenance.** `resolveContextWindow` returns the loaded
   window from `/models/runtime` (`source: "runtime"`); before the model is loaded, the Modelfile
   `num_ctx` (`"modelfile"`) or the model's maximum `<arch>.context_length` (`"estimated"`, since
   Ollama may load it with a smaller default) from `/models/show`; and `8192` marked `assumed`
   for providers that expose no window (every OpenAI-compatible model). The meter always shows a
   percentage and labels an `estimated` or `assumed` denominator as such. The frontend refreshes
   the runtime window after each `chat.done`.
5. **Fill = last invocation's `inputTokens + outputTokens`.** This is what the model held at the
   end of its most recent invocation, uses data already persisted on steps, and needs no
   tokenizer. OpenAI-compatible streams only report usage when asked, so `server/openai-client.ts`
   sets `stream_options: { include_usage: true }`. When a provider still reports none, fill is
   `unknown`: the meter shows `—` and the usage note omits numbers.
6. **The meter is a toggle, off by default**, stored as the sidebar preference
   `showContextMeter` in `SidebarState` (`src/lib/chat.ts`, `src/lib/use-sidebar-state.ts`), the
   same mechanism as `showTokens`. When on, it always shows the token count and percentage.
7. **Placement is a shared step-list transform.** `shared/context-usage.ts` exports the note
   builder (numbers formatted with the fixed `en-US` locale so Node and browser agree) and
   `applyContextPlacement(steps, …)`, which inserts the note and maps `compaction` steps onto
   wire-level steps *before* either formatter runs. The server tool loop and the request JSON
   preview (which uses the OpenAI format even for Ollama, `src/components/request-json-dialog.tsx`)
   both call it, so the preview shows exactly the note and position the model receives. The note
   is never rendered as a transcript step.
8. **The usage note is only injected while `compact_context` is enabled** for the request — the
   note exists to inform the compaction decision; without the tool it is noise in the prompt.
   The client sends the resolved window (`contextWindow`) and, when known, the model family
   (`modelFamily`, from `/models/show` `details.family`) in `chat.send`, so the server does no
   window resolution or metadata lookup of its own.
9. **`compact_context` must be the only tool call in its response.** If the model emits it
   alongside other calls, the server executes none of them, returns an error tool result for each
   call, and lets the model try again. This avoids side effects whose results would be lost by
   the fork. Rejected calls count against `maxToolCalls`; `maxModelInvocations` bounds a model
   that keeps mixing calls.
10. **Compaction ends the turn; its outcome rides on `chat.done`.** The server records the
    authentic `tool_call` step and a matching `tool_result` (needed so the history stays
    protocol-valid if the user continues the original), then sends `chat.done` carrying
    `compaction: { toolCallStepId, summary, remainingWork }`. A single message avoids an ordering
    race with the client's one-generation-at-a-time stream handling
    (`src/lib/use-chat-generation.ts:42,95`).
11. **The original conversation stays as it is.** Beyond the `tool_call`/`tool_result` pair of
    the request, nothing about it changes — no dimming, banners or forward links. The user can
    keep chatting there.
12. **The fork links back.** The new conversation records `forkedFrom: { conversationId,
    stepId }` and renders it as a back-link above the `compaction` card. It inherits model,
    provider, settings, system prompt and active tools. The sidebar visibility
    rule (`src/lib/use-conversations.ts:23`, currently "has a `user` step") is extended to
    "has a `user` or `compaction` step".
13. **The summary enters the fork as a new `compaction` step kind.** It is rendered as its own
    card labelled as written by the model via `compact_context`, never as an assistant bubble.
    `server/request-validation.ts` `STEP_KINDS` accepts it.
14. **Auto-continue with a fresh budget, and a re-compaction guard.** After the original's
    `chat.done` has been applied, the client sends the fork's first request with a fresh
    execution budget and without `compact_context` in the tool list — so that request also
    carries no usage note (Design Decision 8). The tool returns from the next user turn onward.
15. **Placement is researched first, with one default.** Chat templates differ: some reject a
    `system` role, some require a `user` turn before anything else, some merge consecutive
    same-role messages, and changing the first system message invalidates Ollama's prompt-prefix
    cache on every invocation. S3 picks **one default** placement for the note and one for the
    summary, and records per-family exceptions only where research shows the default fails.
    Families without an exception — including every OpenAI-compatible model — use the default.

## Technical Approach

### `src/lib/context-window.ts` (new)

Pure functions. `resolveContextWindow(conversation, model, modelMeta) → { tokens, source }` with
`source ∈ "runtime" | "modelfile" | "estimated" | "assumed"` (Design Decision 4).
`computeContextFill(steps, windowTokens) → { usedTokens, percent, level } | { unknown: true }`
where `level ∈ "ok" | "warn" | "error"` (warn at ≥ 80 %, error at ≥ 100 %).

### Conversation model

`Conversation` (`src/types/chat.ts`) gains `forkedFrom?: { conversationId: string; stepId:
string }`. `StepKind` gains `"compaction"` on both sides of the boundary (`server/types.ts`,
`src/types/chat.ts`) and in `server/request-validation.ts` `STEP_KINDS`.

### `server/index.ts` / `server/llm-router.ts` — `POST /models/runtime` (new)

Takes `{ model, provider }`. For Ollama providers, calls `GET /api/ps` and returns
`{ loaded: true, contextLength }` for a matching entry, else `{ loaded: false }`. Returns
`{ loaded: false }` for OpenAI-compatible providers. Never calls an endpoint that loads a model.

### Context meter

A presentational component (app bar or composer area) bound to `showContextMeter`. Displays e.g.
`6,120 tokens · 15%` with a progress bar, exposes `data-level`, colours via theme tokens, and
marks an `estimated` or `assumed` window. The window size itself is not displayed.

### `shared/context-usage.ts` (new)

`buildContextUsageNote({ usedTokens?, windowTokens })`, the placement data from S3 (default plus
exceptions keyed by family), and `applyContextPlacement(steps, { note?, family? })`. Used by the
server tool loop and by the request preview before `shared/openai-format.ts` /
`shared/ollama-format.ts` run.

### `server/openai-client.ts`

Add `stream_options: { include_usage: true }` to streamed request bodies.

### `server/ws-handler.ts` — tool loop

`chat.send` gains `contextWindow?: number` and `modelFamily?: string` (used only for the note and
placement; never sent to the provider). On each invocation, if `compact_context` is among
the enabled tools, apply the placement with a note computed from the previous invocation's usage
in this loop (or from the last `usage` in the incoming steps for the first invocation). When a
response's tool calls include `compact_context`: enforce Design Decision 9; otherwise create the
`tool_result`, send `chat.done` with the new steps and the `compaction` payload, and stop.

### `server/tools/compact-context.ts` (new)

A `ToolExecutor` exposing `compact_context` with schema
`{ summary: string (minLength 1), remaining_work?: string }`. Its description tells the model that
the conversation will continue in a fresh context containing only the summary. The tool loop
intercepts execution (it must end the turn); the executor exists for registration, schema
validation and tool listing.

### `server/types.ts` / `src/types/chat.ts` — protocol

```ts
| { type: "chat.done"; requestId?: string; conversationId: string; steps: ConversationStep[];
    compaction?: { toolCallStepId: string; summary: string; remainingWork?: string } }
```

### `src/lib/use-chat-generation.ts` / `use-conversations.ts` — fork

When the original's generation resolves with a `compaction` payload: apply its steps to the
original as usual, then create the fork (title `"<original title> (compacted)"`) containing the
original's system steps and one `compaction` step, select it, and send its first request without
`compact_context`. Extend the sidebar visibility predicate.

## Stories

- **S1 — Context window resolution** — `/models/runtime`, resolver, OpenAI `include_usage`.
  Covers AC-CTX-1..8.
- **S2 — Context meter** — toggleable frontend meter showing tokens and percentage. Covers
  AC-UX-1..6.
- **S3 — Placement research** — default placement plus per-family exceptions, documented and
  mirrored as data. Covers AC-RES-1..4, MV-1.
- **S4 — Context-usage note** — shared note builder and placement transform, server injection,
  request-preview parity. Covers AC-NOTE-1..6.
- **S5 — `compact_context` tool** — executor, sole-call rule, compaction outcome on
  `chat.done`. Covers AC-TOOL-1..3, AC-TOOL-5..8.
- **S6 — Fork and auto-continue** — client fork, `compaction` step, back-link, sidebar
  visibility, auto-send, re-compaction guard. Covers AC-FORK-1..10.

Dependencies: S2 → S1; S4 → S1, S3; S5 → S4; S6 → S3, S5. S3 should deliver its default quickly
so S4–S6 are not blocked on exhaustive per-family testing.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- **epic-token-view** — shares the "show what the model actually sees" goal; the meter reuses
  reported usage rather than the tokenizer from that epic, and S3 reuses its finding that
  `prompt_eval_count` reports the full ingested prompt.
- **epic-frontend-architecture-maintainability** — the fork and meter must land in the
  panes/hooks structure that epic introduced, not in `chat-workspace.tsx` directly.

## Non-Goals

- Hiding or rewriting conversation history to save tokens — the project shows history, it does
  not optimise it away.
- Guaranteeing summary quality; the model's own summary is the lesson.
- Server-side conversation state; the server stays stateless per request.
