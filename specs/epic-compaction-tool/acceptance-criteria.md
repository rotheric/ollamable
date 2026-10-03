# Compaction Tool — Acceptance Criteria

## Known TAGs

- **CTX** — context-window resolution, `num_ctx` propagation and usage reporting.
- **UX** — user-visible behaviour of the context meter.
- **RES** — research deliverables.
- **NOTE** — model-facing context-usage note and placement transform.
- **TOOL** — `compact_context` tool and server protocol.
- **FORK** — client-side fork and auto-continue.
- **STRUCT** — cross-cutting structural assertions.

## Terminology

- **resolved window** — the `{ tokens, source }` value returned by `resolveContextWindow`.
- **fill** — `usage.inputTokens + usage.outputTokens` of the most recent step carrying token
  `usage`, unless an `assistant` step without token `usage` follows it (a response whose provider
  reported none); in-flight steps are ignored. `none-yet` when the history contains no model
  response (no `assistant` step, no `tool_call` step, and no step carrying a `usage` object);
  `unknown` when a model response exists but no token value results.
- **remembered window** — the last `/models/runtime` `contextLength` observed for a
  `provider/model` pair, persisted by the client.
- **usage note** — the string returned by `buildContextUsageNote` in `shared/context-usage.ts`.
- **placement data** — the default placement plus per-family exceptions exported by
  `shared/context-usage.ts`, applied by `applyContextPlacement`.
- **fork** — the conversation created when a `chat.done` carries a `compaction` payload.
- **original** — the conversation in which `compact_context` was called.
- **mocked provider** — a test double installed via `vi.mock` of `streamOllamaResponse` /
  `streamOpenAIResponse`, as in `tests/integration/ws-handler.test.ts`.

## Context Window Resolution (S1)

**AC-CTX-1** — `resolveContextWindow` MUST return `source: "runtime"` with
`tokens === contextLength` and no `stale` flag when `/models/runtime` reports
`{ loaded: true, contextLength }`, and MUST then update the remembered window for that
`provider/model`.

**AC-CTX-2** — When the model is not loaded and a remembered window exists, `resolveContextWindow`
MUST return `source: "runtime"`, `stale: true` and the remembered value, regardless of
`meta.parameters`; the remembered window MUST survive a page reload.

**AC-CTX-3** — When the model is not loaded and no window is remembered, `resolveContextWindow`
MUST return `source: "modelfile"` with the parsed value when `meta.parameters` contains a
`num_ctx` line, else `source: "estimated"` with `tokens === <arch>.context_length`.

**AC-CTX-4** — With no runtime or remembered window and `modelMeta` undefined (failed or skipped
`/models/show`, including every OpenAI-compatible model) or without a `*.context_length` key,
`resolveContextWindow` MUST return `source: "assumed"` with `tokens === 8192`, and the frontend
MUST NOT log an error for a skipped `/models/show`.

**AC-CTX-5** — `POST /models/runtime` for an Ollama model listed by a stubbed `GET /api/ps` MUST
return `{ loaded: true, contextLength }` from that entry, MUST return `{ loaded: false }` for an
unlisted model and for any OpenAI-compatible provider, and MUST NOT call `/api/generate`,
`/api/chat` or `/api/embed`.

**AC-CTX-6** — The OpenAI-compatible request body built by `server/openai-client.ts` MUST contain
`stream_options.include_usage === true` and MUST NOT contain `num_ctx`.

**AC-CTX-7** — `buildOllamaChatBody` MUST NOT set `options.num_ctx` for any `chat.send`, and no
UI control MUST set or display the window size.

**AC-CTX-8** — `computeContextFill` MUST return `{ unknown: true }` whenever the most recent
`assistant` step carries no token `usage` — both with no usage anywhere and after an earlier step
with usage (e.g. `[user, assistant{6000,120}, user, assistant]`) — and MUST ignore in-flight
response steps.

**AC-CTX-9** — `validateChatRequest` MUST reject a `chat.send` whose `contextWindow` is present but
not a positive integer, whose `contextWindowSource` is present but not one of `runtime`,
`modelfile`, `estimated`, `assumed`, or whose `modelFamily` is present but empty.

## Context Meter (S2)

**AC-UX-1** — With `showContextMeter` false, `[data-testid="context-meter"]` MUST NOT be present
in the DOM.

**AC-UX-2** — With `showContextMeter` true and a known fill, the meter MUST display the fill
formatted with `en-US` grouping and the percentage returned by `contextPercent` followed by `%`;
with fill `none-yet` it MUST display `0` tokens and `0%`.

**AC-UX-3** — With `showContextMeter` true and an unknown fill, the meter MUST display `—` in
place of the token count and percentage, including when an earlier response did carry `usage`;
the meter MUST NOT fall back to an older figure.

**AC-UX-4** — The meter MUST display the new fill after a `chat.done` whose steps carry `usage`,
and MUST re-query `/models/runtime` after that `chat.done`, without a page reload.

**AC-UX-5** — The meter's `data-level` attribute MUST be `ok` below 80 %, `warn` from 80 % up to
below 100 %, and `error` at or above 100 %.

**AC-UX-7** — When the resolved window's source is `estimated` or `assumed`, the meter MUST display
that word; when it is `runtime` with `stale: true`, the meter MUST display `stale`.

**AC-UX-6** — The value of `showContextMeter` MUST survive a page reload.

## Placement Research (S3)

**AC-RES-1** — `docs/research/compaction-placement.md` MUST exist with the sections `Method`,
`Candidates`, `Findings` and `Decision`, and `Method` MUST name the Ollama version and the
instrument used to observe rendered prompts and prefix-cache reuse (e.g. `OLLAMA_DEBUG=1` runner
logs, `prompt_eval_duration` deltas; `prompt_eval_count` is not a cache instrument). `Findings`
MUST also record the `prompt_eval_count` Ollama reports for a prompt deliberately longer than the
loaded window, and `Decision` MUST state the resulting meaning of the meter's `error` band.

**AC-RES-2** — `Candidates` MUST list, for the usage note: trailing `system` message, appended to
the first `system` message, trailing `user`-role message; and for the summary: `system`-role
message, `user`-role message, and the bare fork shape "system steps + summary with no prior
`user` turn".

**AC-RES-3** — `Findings` MUST contain a row per candidate for at least three model families,
one of which MUST be the family of the repo's default test model.

**AC-RES-4** — `Decision` MUST name one default placement for the note and one for the summary
plus zero or more family exceptions, and a unit test MUST assert that the placement data exported
by `shared/context-usage.ts` equals the `Decision` table parsed from the document.

## Context-Usage Note (S4)

**AC-NOTE-1** — `buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192, source: "runtime" })`
MUST return a string containing `6,120`, `8,192`, `75%` and the literal `compact_context`,
independent of the process locale, where `75` equals `contextPercent(6120, 8192)`.

**AC-NOTE-2** — `buildContextUsageNote` without `usedTokens` MUST return a string containing
`compact_context`, no digit and no `%`; and the first invocation of a request whose incoming steps'
latest response carries no `usage` (no step with token usage, or an `assistant` step after the
last such step) MUST receive that number-free note.

**AC-NOTE-7** — `buildContextUsageNote` with `source: "assumed"` MUST contain the used token count
but neither the window nor a `%`; with `source: "estimated"` it MUST contain the word
`approximately`.

**AC-NOTE-3** — When `compact_context` is among the request's enabled tools, every model
invocation of the tool loop (mocked provider) MUST receive the usage note at the message index
`applyContextPlacement` yields for the request's `modelFamily`, including the default for an
absent `modelFamily`.

**AC-NOTE-4** — When `compact_context` is not among the request's enabled tools, no model
invocation MUST receive a usage note.

**AC-NOTE-5** — On the second and later invocations within one tool loop, the note's
`usedTokens` MUST equal `inputTokens + outputTokens` of the previous invocation's response (a
previous invocation that reported no usage yields the number-free note, never an earlier figure).

**AC-NOTE-6** — For a conversation with `compact_context` enabled, the request JSON preview's
`messages` MUST contain the identical usage note string at the identical index as the messages
the server sends to the mocked provider for the same steps, and the transcript MUST NOT render
the note as a step.

**AC-NOTE-8** — For the same conversation on an Ollama model, the outgoing-message list returned by
`toOllamaFilteredMessages` MUST equal the messages the server sends to the mocked provider, and
`useReconciliation`'s preceding messages MUST include the note.

**AC-NOTE-9** — No step in any `chat.delta`, `chat.steps` or `chat.done` of a request MUST contain
the usage note text or be a step produced by `applyContextPlacement`, and `applyContextPlacement`
MUST NOT mutate its input array (the input is deep-equal before and after the call).

## `compact_context` Tool (S5)

**AC-TOOL-1** — `GET /tools` MUST list `compact_context` with an input schema requiring a string
`summary` containing a non-whitespace character and allowing an optional string `remaining_work`,
and a connection's dispatcher MUST `canHandle("compact_context")` with a definition whose `id`
equals the listed `id`.

**AC-TOOL-2** — When a response's only tool call is a valid `compact_context`, the server's
`chat.done` MUST carry `compaction.summary`, `compaction.remainingWork` and
`compaction.toolCallStepId`, and the server MUST NOT invoke the model again in that request.

**AC-TOOL-3** — The `chat.done` of AC-TOOL-2 MUST contain the `tool_call` step whose id equals
`compaction.toolCallStepId`, and MUST NOT contain any `tool_result` step for that call (Ollama and
OpenAI-compatible mocked providers).

**AC-TOOL-4** — *removed*

**AC-TOOL-5** — When a response contains more than one tool call and at least one is
`compact_context` (including two `compact_context` calls), and all are enabled, the server MUST
execute none of them, MUST return an error `tool_result` for every call in that response, MUST NOT
attach `compaction` to any `chat.done`, and MUST invoke the model again unless
`maxModelInvocations` or `maxToolCalls` is exhausted. A response whose calls would exceed
`maxToolCalls` MUST instead end the request with the existing budget `chat.error` (no error
`tool_result`s, no `compaction`), as for any other tool.

**AC-TOOL-6** — A `compact_context` call with an empty, whitespace-only or missing `summary` MUST
yield an error `tool_result` and no `compaction` payload.

**AC-TOOL-7** — A `compact_context` call when the tool is not enabled for the request MUST end
the request with a `chat.error` whose message contains `Tool is not enabled for this request`,
and no `compaction` payload.

**AC-TOOL-8** — Every `compact_context` call, including those rejected under AC-TOOL-5, MUST
count as one tool call against `maxToolCalls`.

## Fork and Auto-Continue (S6)

**AC-FORK-1** — On a `chat.done` carrying `compaction`, the client MUST create exactly one new
conversation whose `forkedFrom` equals `{ conversationId: <original id>, stepId:
<toolCallStepId> }`.

**AC-FORK-2** — The fork MUST have the original's `model`, `provider`, `systemPrompt`,
`temperature`, `maxOutputTokens`, `reasoningEffort`, `maxModelInvocations`,
`maxToolCalls`, `availableTools` and `activeToolIds`, MUST be titled `"<original title> (compacted)"`
with `titleEdited: true`, and the title MUST be unchanged after the fork's next user send.

**AC-FORK-3** — The fork's steps, before its first response, MUST be exactly the original's
`system` steps followed by one `compaction` step whose content contains the `summary` and, when
present, the `remainingWork`.

**AC-FORK-4** — The original's steps after compaction MUST equal its steps before the request
plus the steps of the request's `chat.done` plus exactly one harness step (`kind: "meta"`,
`metaEvent.kind: "compaction"`, `metaEvent.data.forkConversationId` equal to the fork's id); no
other field of the original MUST change except `updatedAt` and the request's own
`requestContexts` record.

**AC-FORK-5** — The fork MUST be the selected conversation and MUST appear in the sidebar list
returned by `orderVisibleConversations`.

**AC-FORK-6** — The client MUST NOT send any `chat.send` for the fork until the user sends a message
in it; the original's request MUST settle normally (`streaming` false, `settledCount` incremented
exactly once) after its `chat.done` has been applied to the original.

**AC-FORK-7** — The fork's first `chat.send` MUST be the one triggered by the user's first message in
the fork, MUST carry the steps `[system, compaction, user]`, MUST include `compact_context` in
`tools` when it is active (as for any user send), and its messages to the mocked provider MUST
contain the summary and the user's text in a single user-role message.

**AC-FORK-8** — The `compaction` step MUST render as a card labelled with the authoring model and
`compact_context`, MUST NOT render as an assistant message, and the fork MUST render a link whose
activation selects the original conversation.

**AC-FORK-9** — `validateChatRequest` MUST accept a `chat.send` whose steps contain a
`compaction` step.

**AC-FORK-10** — `applyContextPlacement` MUST map a `compaction` step onto the wire position named
by the placement data for the request's `modelFamily`, and the serialised messages of
`shared/ollama-format.ts` and `shared/openai-format.ts` MUST both contain the summary text.

**AC-FORK-11** — For a `chat.send` whose `tools` do not include `compact_context` and whose steps
contain a `compaction` step, the messages the server sends to the mocked provider (Ollama and
OpenAI-compatible) MUST contain the summary text.

**AC-FORK-12** — Regenerating the fork's first assistant response and deleting its last exchange
MUST both leave the `compaction` step in the fork's steps.

**AC-FORK-13** — The harness step of AC-FORK-4 MUST render in the original as an event card (not an
assistant message) whose text names the fork's title and whose link, when activated, selects the
fork; when the fork no longer exists the card MUST render without a link.

**AC-FORK-14** — `placeStepsForModel` MUST omit every `compact_context` `tool_call` step that has no
`tool_result` with the same call id (or, for an id-less call, a same-name result after it that is not
paired with a later unpaired same-name call), and MUST omit
the AC-FORK-4 harness step; a `chat.send` continuing the original after compaction MUST reach the
mocked Ollama and OpenAI-compatible providers with no `compact_context` call and no harness text in
the messages, while rejected `compact_context` calls that have error `tool_result`s MUST still be
sent.

## Cross-Cutting Invariants

**AC-STRUCT-1** — `StepKind` in `server/types.ts` and `src/types/chat.ts` MUST both include
`"compaction"`, `server/request-validation.ts` `STEP_KINDS` MUST include `"compaction"`, and the
`chat.done` variant of `ServerMessage` on both sides (`server/types.ts` and the frontend copy in
`src/lib/backend-client.ts`) MUST declare the optional `compaction` field.

**AC-STRUCT-2** — `src/lib/context-window.ts` MUST export `resolveContextWindow` and
`computeContextFill`, and `grep -rn "computeContextFill\|showContextMeter" server/` MUST return no
matches.

**AC-STRUCT-3** — `npm run lint`, the unit suites and the release gate MUST pass.

**AC-STRUCT-4** — Property: for every generated tool-loop run (generator: invocation count 1–6,
interleaved tool rounds, `modelFamily` drawn from the placement data's families plus absent,
`compact_context` enabled or not, per-invocation `usage` drawn from non-negative integers), the
usage note passed to invocation *k* MUST be built from invocation *k−1*'s
`inputTokens + outputTokens`, the loop's accumulated `steps` and every emitted
`chat.delta`/`chat.steps`/`chat.done` step MUST contain neither the note text nor any step produced
by `applyContextPlacement`, and the accumulated `steps` MUST deep-equal the concatenation of the
untransformed provider responses.
Spans modules: tool-loop, context-usage

**AC-STRUCT-5** — Property: for every generated sequence of provider responses (generator: each
response holds 0–3 tool calls drawn from valid `compact_context`, invalid `compact_context`,
`web_search`, `curl`; `maxModelInvocations` and `maxToolCalls` drawn from 1–6), `toolCallCount`
MUST be non-decreasing across invocations, MUST increase by exactly the number of calls in every
response (executed or rejected), the number of model invocations MUST NOT exceed
`maxModelInvocations`, `compaction` MUST appear on a `chat.done` only when the final response's
sole call was a valid `compact_context`, and that final call MUST receive no `tool_result`.
Spans modules: tool-loop, context-usage

**AC-STRUCT-6** — Property: for every generated client-event interleaving for one original request
(generator: ordering of `chat.delta`, `chat.done` with or without `compaction`, user stop,
supersession by another send, and the original's `finally` cleanup), a fork MUST exist if and only
if a `chat.done` carrying `compaction` was applied without a preceding stop or supersession; when
it exists, the original's `chat.done` steps MUST be applied to the original before the fork is in
state, no stream MUST be started for the fork, and the original's `finally` cleanup MUST settle
the original exactly once (`streaming` false, `settledCount` +1).
Spans modules: tool-loop, transport-client, fork-flow

## Manual Validation

| MV id | Behavioral intent | Gap evidence | Owner | Blocked on | Adjudicated |
|-------|-------------------|--------------|-------|------------|-------------|
| MV-1  | The `Findings` in `docs/research/compaction-placement.md` reflect what the named Ollama version actually renders and caches for each family. | Observations come from live models and debug logs on a specific host; a recorded-fixture test would only replay what the author already wrote down and cannot discriminate a wrong observation. Cheapest automated alternative — a live-gated test asserting the default placement renders without template errors for the default test model — checks one family, not the per-family claims. | Markus | AC-RES-3 | 2026-10-02 |
