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
3. The client forks a new conversation seeded with that summary and selects it; the summary
   reaches the model together with the user's next message there (no automatic model response).
   The original records a harness event linking to the fork.
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
- Client-side fork: new conversation seeded with the summary and linking back to the original,
  selected without sending anything; the original gets a harness event card linking to the fork.

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
   (`POST /models/show`, `server/index.ts`), the loaded window (`POST /models/runtime`) and
   per-invocation `usage` (`server/response-usage.ts`). Window resolution, fill computation and
   all UI formatting live in the frontend. The one arithmetic helper both sides need — the
   rounded percentage — lives in `shared/context-usage.ts`, so the meter and the model-facing
   note can never disagree. Refs: `src/lib/ollama.ts:67`.
3. **The app does not set `num_ctx`.** Changing `num_ctx` makes Ollama reload the model, so the
   app reads the effective window instead of choosing it. Ollama reports the window of a loaded
   model via `GET /api/ps` (`models[].context_length`, verified on Ollama 0.30.8) — reading it
   loads nothing. The window size is not shown or configurable in the UI (deferred).
4. **Window resolution has an honest provenance.** `resolveContextWindow` picks, in order: the
   live window from `/models/runtime` (`"runtime"`); the last runtime window remembered for that
   model while it is unloaded after `keep_alive` (`"runtime"`, `stale: true`); the Modelfile
   `num_ctx` (`"modelfile"`); the model's maximum `<arch>.context_length` (`"estimated"`, since
   Ollama may load it with a smaller default); otherwise `8192` (`"assumed"`) — which covers every
   OpenAI-compatible model and any failed or skipped `/models/show` (`modelMeta` undefined). The
   remembered window is stored per `provider/model` alongside the sidebar preferences and survives
   reloads. The frontend refreshes the runtime window after each `chat.done`.
5. **Fill = last invocation's `inputTokens + outputTokens`.** This is what the model held at the
   end of its most recent invocation, uses data already persisted on steps, and needs no
   tokenizer. OpenAI-compatible streams only report usage when asked, so `server/openai-client.ts`
   sets `stream_options: { include_usage: true }`. With no usage yet the meter shows `0`; when a
   provider reports none after a response, fill is `unknown` and the meter shows `—` — also when
   an earlier response did report usage; neither the meter nor the note ever falls back to an older
   figure (the server loop already behaves so per AC-NOTE-5). Whether
   Ollama's reported prompt tokens can ever exceed the runtime window (or are capped by its
   truncation) is observed in S3; the meter's `error` band is defined by that finding.
6. **The meter is a toggle, off by default**, stored as the sidebar preference
   `showContextMeter` in `SidebarState` (`src/lib/chat.ts`, `src/lib/use-sidebar-state.ts`), the
   same mechanism as `showTokens`. When on, it shows the token count and percentage, and labels
   an `estimated`, `assumed` or stale window as such.
7. **The model is never told a number the app does not know.** The usage note states tokens used,
   window and percentage only when both are known: with no usage reported yet (first invocation of
   a conversation) it omits all numbers; with an `assumed` window it states tokens used only; with
   an `estimated` window it marks window and percentage as approximate.
8. **Placement is a shared step-list transform applied to a per-invocation copy.**
   `shared/context-usage.ts` exports the note builder (numbers formatted with the fixed `en-US`
   locale) and `applyContextPlacement(steps, { note?, family? })`, which maps `compaction` steps
   onto wire-level steps and, when a note is given, inserts it — returning a new array *before*
   either formatter runs. It is **always** called (a fork's first request has no note but still
   needs its `compaction` step mapped); the steps the tool loop accumulates and returns in
   `chat.delta`/`chat.steps`/`chat.done` are never the transformed copy. Every place that shows
   what the model receives calls the same transform with the note rebuilt from the steps before
   the target: the request JSON preview (`src/components/request-json-dialog.tsx`, OpenAI format
   even for Ollama), and epic-token-view's Ollama outgoing-message list and `prompt_eval_count`
   reconciliation (`src/lib/token-view.ts` `toOllamaFilteredMessages`, `useReconciliation`). The
   note is never rendered as a transcript step.
9. **The usage note is only injected while `compact_context` is enabled** for the request — the
   note exists to inform the compaction decision; without the tool it is noise in the prompt.
   The client sends the resolved window (`contextWindow`, with its `contextWindowSource`) and, when
   known, the model family (`modelFamily`, from `/models/show` `details.family`) in `chat.send`, so
   the server does no window resolution or metadata lookup of its own. `validateChatRequest`
   accepts these only as a positive integer, a known source token and a non-empty string.
10. **`compact_context` must be the only tool call in its response.** The existing enablement and
    availability checks run first. Any response with more than one tool call that includes
    `compact_context` — including two `compact_context` calls — executes none of them, returns an
    error tool result for each call, and lets the model try again within the request's budgets.
    This avoids side effects whose results would be lost by the fork. Rejected calls count against
    `maxToolCalls`. A summary that is empty or whitespace-only is rejected the same way.
11. **Compaction ends the turn; its outcome rides on `chat.done`.** The server records the
    authentic `tool_call` step and **no** `tool_result` — nothing is returned to the model, the
    harness takes over — then sends `chat.done` carrying
    `compaction: { toolCallStepId, summary, remainingWork }`. A single message avoids an ordering
    race with the client's one-generation-at-a-time stream handling
    (`stopStreamRef` / `streamConversationResponse` in `src/lib/use-chat-generation.ts`).
12. **The original records the harness event.** Beyond the request's authentic steps, the client
    appends one harness step (`meta`, `metaEvent.kind: "compaction"`) when it creates the fork:
    an app-authored event card naming the fork with a link to it. Meta steps are never sent to the
    model. The user can keep chatting in the original: `placeStepsForModel` drops the unanswered
    `compact_context` call from the wire history, so strict OpenAI-compatible servers accept it.
13. **The fork links back.** The new conversation records `forkedFrom: { conversationId,
    stepId }` and renders it as a back-link above the `compaction` card. It inherits model,
    provider, settings, system prompt, `availableTools` and `activeToolIds`, and is created with
    `titleEdited: true` so its `"<original title> (compacted)"` title survives the first user send.
    The sidebar visibility rule (`src/lib/use-conversations.ts:23`, currently "has a `user` step")
    is extended to "has a `user` or `compaction` step".
14. **The summary enters the fork as a new `compaction` step kind.** It is rendered as its own
    card labelled as written by the model via `compact_context`, never as an assistant bubble.
    `server/request-validation.ts` `STEP_KINDS` accepts it. Transcript operations treat it as a
    turn boundary like a `user` step (`src/lib/transcript.ts` `findResponseStartIndex`,
    `deleteLastExchangeCutIndex`), so regenerating the fork's first response never removes it.
15. **No automatic continuation.** After the original's `chat.done` has been applied the client
    creates and selects the fork but sends nothing; compaction never triggers a model response on
    its own. The user's next message in the fork is sent with the summary collated in front of it
    (one user-role message on the wire), with the conversation's tools as for any send. This
    matches Claude Code's manual `/compact`, Codex and Amp. A model that compacts mid-task
    therefore pauses until the user replies.
16. **Placement is researched first, with one default.** Chat templates differ: some reject a
    `system` role, some require a `user` turn before anything else, some merge consecutive
    same-role messages, and changing the first system message invalidates Ollama's prompt-prefix
    cache on every invocation. S3 picks **one default** placement for the note and one for the
    summary, and records per-family exceptions only where research shows the default fails.
    Families without an exception — including every OpenAI-compatible model — use the default.
17. **One tool, two registries.** Built-in tools reach the UI via `GET /tools` from the static
    dispatcher (`server/index.ts`) while the tool loop uses each connection's own dispatcher
    (`server/ws-handler.ts` constructor). `compact_context` is registered in both with one stable
    `id`.

## Technical Approach

### `src/lib/context-window.ts` (new)

Pure functions. `resolveContextWindow({ runtime, remembered, modelMeta }) → { tokens, source,
stale? }` with `source ∈ "runtime" | "modelfile" | "estimated" | "assumed"` (Design Decision 4).
`computeContextFill(steps, window) → { usedTokens, percent, level } | { unknown: true }` where
`level ∈ "ok" | "warn" | "error"` (warn at ≥ 80 %, error at ≥ 100 %), using the shared
percentage helper.

### Conversation model and transcript

`Conversation` (`src/types/chat.ts`) gains `forkedFrom?: { conversationId: string; stepId:
string }`. `StepKind` gains `"compaction"` on both sides of the boundary (`server/types.ts`,
`src/types/chat.ts`) and in `server/request-validation.ts` `STEP_KINDS`. `src/lib/transcript.ts`
treats `compaction` as a turn boundary and as visible.

### `server/index.ts` / `server/llm-router.ts` — `POST /models/runtime` (new)

Takes `{ model, provider }`. For Ollama providers, calls `GET /api/ps` and returns
`{ loaded: true, metadata: true, contextLength }` for a matching entry, else
`{ loaded: false, metadata: true }`. Returns `{ loaded: false, metadata: false }` for
OpenAI-compatible providers, which tells the client to skip `/models/show`. Never calls an
endpoint that loads a model.

### Context meter

A presentational component (app bar or composer area) bound to `showContextMeter`. Displays e.g.
`6,120 tokens · 15%` with a progress bar, exposes `data-level`, colours via theme tokens, and
labels an `estimated`, `assumed` or stale window. The window size itself is not displayed.

### `shared/context-usage.ts` (new)

`contextPercent(used, window)`, `buildContextUsageNote({ usedTokens?, windowTokens, source })`,
the placement data from S3 (default plus exceptions keyed by family), and
`applyContextPlacement(steps, { note?, family? })` returning a new array.

### `src/lib/token-view.ts` / request preview

`toOllamaFilteredMessages`, `useReconciliation`'s preceding messages and the request JSON preview
run `applyContextPlacement` with the note rebuilt from the steps before the target step.

### `server/openai-client.ts`

Add `stream_options: { include_usage: true }` to streamed request bodies.

### `server/ws-handler.ts` — tool loop

`chat.send` gains `contextWindow?`, `contextWindowSource?` and `modelFamily?` (used only for the
note and placement; never sent to the provider). Every invocation sends
`applyContextPlacement(steps, { note, family })` — `note` only when `compact_context` is enabled,
computed from the previous invocation's usage in this loop (or from the last `usage` in the
incoming steps for the first invocation). When a response's tool calls include `compact_context`:
enforce Design Decision 10; otherwise record the `tool_call` step (no `tool_result`), send `chat.done` with the new steps
and the `compaction` payload, and stop.

### `server/tools/compact-context.ts` (new)

A `ToolExecutor` exposing `compact_context` with schema
`{ summary: string (pattern requiring a non-whitespace character), remaining_work?: string }`. Its
description tells the model that the conversation will continue in a fresh context containing only
the summary. The tool loop intercepts execution (it must end the turn); the executor exists for
registration in both dispatchers, schema validation and tool listing.

### `server/types.ts` / `src/types/chat.ts` — protocol

```ts
| { type: "chat.done"; requestId?: string; conversationId: string; steps: ConversationStep[];
    compaction?: { toolCallStepId: string; summary: string; remainingWork?: string } }
```

### `src/lib/use-chat-generation.ts` / `use-conversations.ts` — fork

When the original's generation resolves with a `compaction` payload: apply its steps to the
original as usual, append the harness step (`meta`, `metaEvent.kind: "compaction"`) to the original,
then create the fork (title `"<original title> (compacted)"`, `titleEdited: true`) containing the
original's system steps and one `compaction` step, and select it. Nothing is sent: the user's first
message in the fork carries the summary with it. Extend the sidebar visibility predicate.

## Stories

- **S1 — Context window resolution** — `/models/runtime`, resolver, OpenAI `include_usage`.
  Covers AC-CTX-1..9.
- **S2 — Context meter** — toggleable frontend meter showing tokens and percentage. Covers
  AC-UX-1..7.
- **S3 — Placement research** — default placement plus per-family exceptions, documented and
  mirrored as data. Covers AC-RES-1..4, MV-1.
- **S4 — Context-usage note** — shared note builder and placement transform, server injection,
  request-preview and token-view parity. Covers AC-NOTE-1..9.
- **S5 — `compact_context` tool** — executor, sole-call rule, compaction outcome on
  `chat.done`. Covers AC-TOOL-1..3, AC-TOOL-5..8.
- **S6 — Fork** — client fork, `compaction` step, back-link, sidebar visibility, transcript
  boundary; no auto-send. Covers AC-FORK-1..3, AC-FORK-5, AC-FORK-8..12.
- **S7 — Compaction integration properties** — order-sensitive composition properties across the
  tool loop, transport and fork flow. Covers AC-STRUCT-4..6.
- **S8 — Compaction harness event** — harness step on the original, wire omission, no
  auto-continue. Covers AC-TOOL-3, AC-FORK-4, AC-FORK-6, AC-FORK-7, AC-FORK-13, AC-FORK-14,
  AC-STRUCT-5, AC-STRUCT-6.

Dependencies: S2 → S1; S4 → S1, S3; S5 → S4; S6 → S3, S5; S7, S8 → S6. S3 should deliver its default quickly
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

## Amendments

- **2026-10-02** — Tightened `AC-TOOL-5`. Source: Stage-1 review of S5. Rationale: the budget
  check runs before the sole-call interception for every tool, so a mixed response that would
  exceed `maxToolCalls` ends with the budget `chat.error` rather than error `tool_result`s; the AC
  now states that ordering explicitly.
- **2026-10-02** — Tightened `AC-FORK-4` and `AC-STRUCT-1`. Source: Stage-1 review of S6.
  Rationale: every send appends the original's own `requestContexts` record (S4), which AC-FORK-4
  now allows; the frontend `ServerMessage` lives in `src/lib/backend-client.ts`, which AC-STRUCT-1
  now names.
- **2026-10-02** — Replaced the compaction `tool_result` with a client-side harness event
  (Design Decisions 11 and 12; rewrote `AC-TOOL-3`, `AC-FORK-4`, `AC-STRUCT-5`; added
  `AC-FORK-13`, `AC-FORK-14`; new story S8). Source: user review after manual testing.
  Rationale: a `tool_result` implies a response sent to the model, which never happens on
  compaction; the harness event makes the app's takeover visible and links to the fork.
  Supersedes the "no forward link" part of the original Design Decision 12.
- **2026-10-02** — Removed auto-continue (Design Decision 15, Solution item 3; rewrote
  `AC-FORK-6`, `AC-FORK-7`, `AC-STRUCT-6`; folded into S8). Source: user review. Rationale: an
  automatic fork request triggers an unnecessary model response; the summary is sent with the
  user's next message instead, as most harnesses do (Claude Code, Codex, Amp). The
  re-compaction guard (first fork request without `compact_context`) is dropped with it.
- **2026-10-02** — Tightened `AC-FORK-14` id-less pairing. Source: Stage-1 review of S8.
  Rationale: Ollama calls carry no id; a later rejected `compact_context` result must not answer
  an earlier honoured call, so results pair with the nearest preceding unpaired same-name call.
- **2026-10-02** — Fill and the note's used tokens come from the latest response only (Design
  Decision 5; Terminology "fill"; `AC-CTX-8`, `AC-UX-3`, `AC-NOTE-2`, `AC-NOTE-5`). Source: Codex
  review (raised twice), decided by an independent Fable review on the user's request. Rationale:
  the server loop already refused stale figures (AC-NOTE-5); the meter and a request's first note
  must not show an older response's count as current.

