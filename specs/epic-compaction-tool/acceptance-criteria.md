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
- **fill** — `usage.inputTokens + usage.outputTokens` of the most recent step in a conversation
  that carries `usage`; `0` when no step carries `usage` and the conversation has no assistant
  response; `unknown` when the conversation has an assistant response but no step carries `usage`.
- **usage note** — the string returned by `buildContextUsageNote` in `shared/context-usage.ts`.
- **placement data** — the default placement plus per-family exceptions exported by
  `shared/context-usage.ts`, applied by `applyContextPlacement`.
- **fork** — the conversation created when a `chat.done` carries a `compaction` payload.
- **original** — the conversation in which `compact_context` was called.
- **mocked provider** — a test double installed via `vi.mock` of `streamOllamaResponse` /
  `streamOpenAIResponse`, as in `tests/integration/ws-handler.test.ts`.

## Context Window Resolution (S1)

**AC-CTX-1** — `resolveContextWindow` MUST return `source: "runtime"` with
`tokens === contextLength` when `/models/runtime` reports `{ loaded: true, contextLength }`.

**AC-CTX-2** — When the model is not loaded, `resolveContextWindow` MUST return
`source: "modelfile"` with the parsed value when `meta.parameters` contains a `num_ctx` line.

**AC-CTX-3** — When the model is not loaded and `meta.parameters` has no `num_ctx`,
`resolveContextWindow` MUST return `source: "estimated"` with `tokens === <arch>.context_length`.

**AC-CTX-4** — For a model whose metadata has no `*.context_length` key (including every
OpenAI-compatible model) and no runtime window, `resolveContextWindow` MUST return
`source: "assumed"` with `tokens === 8192`.

**AC-CTX-5** — `POST /models/runtime` for an Ollama model listed by a stubbed `GET /api/ps` MUST
return `{ loaded: true, contextLength }` from that entry, MUST return `{ loaded: false }` for an
unlisted model and for any OpenAI-compatible provider, and MUST NOT call `/api/generate`,
`/api/chat` or `/api/embed`.

**AC-CTX-6** — The OpenAI-compatible request body built by `server/openai-client.ts` MUST contain
`stream_options.include_usage === true` and MUST NOT contain `num_ctx`.

**AC-CTX-7** — `buildOllamaChatBody` MUST NOT set `options.num_ctx` for any `chat.send`, and no
UI control MUST set or display the window size.

**AC-CTX-8** — `computeContextFill` MUST return `{ unknown: true }` for a step list that contains
an `assistant` step but no step with `usage`.

## Context Meter (S2)

**AC-UX-1** — With `showContextMeter` false, `[data-testid="context-meter"]` MUST NOT be present
in the DOM.

**AC-UX-2** — With `showContextMeter` true and a known fill, the meter MUST display the fill
formatted with `en-US` grouping and the percentage `round(fill / tokens * 100)` followed by `%`,
including when the fill is `0`.

**AC-UX-3** — With `showContextMeter` true and an unknown fill, the meter MUST display `—` in
place of the token count and percentage.

**AC-UX-4** — The meter MUST display the new fill after a `chat.done` whose steps carry `usage`,
and MUST re-query `/models/runtime` after that `chat.done`, without a page reload.

**AC-UX-5** — The meter's `data-level` attribute MUST be `ok` below 80 %, `warn` from 80 % up to
below 100 %, and `error` at or above 100 %; when the resolved window's source is `estimated` or
`assumed`, the meter MUST display that word.

**AC-UX-6** — The value of `showContextMeter` MUST survive a page reload.

## Placement Research (S3)

**AC-RES-1** — `docs/research/compaction-placement.md` MUST exist with the sections `Method`,
`Candidates`, `Findings` and `Decision`, and `Method` MUST name the Ollama version and the
instrument used to observe rendered prompts and prefix-cache reuse (e.g. `OLLAMA_DEBUG=1` runner
logs, `prompt_eval_duration` deltas; `prompt_eval_count` is not a cache instrument).

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

**AC-NOTE-1** — `buildContextUsageNote({ usedTokens: 6120, windowTokens: 8192 })` MUST return a
string containing `6,120`, `8,192`, `75%` and the literal `compact_context`, independent of the
process locale.

**AC-NOTE-2** — `buildContextUsageNote({ windowTokens: 8192 })` (no `usedTokens`) MUST return a
string containing `compact_context` and no `%` character.

**AC-NOTE-3** — When `compact_context` is among the request's enabled tools, every model
invocation of the tool loop (mocked provider) MUST receive the usage note at the message index
`applyContextPlacement` yields for the request's `modelFamily`, including the default for an
absent `modelFamily`.

**AC-NOTE-4** — When `compact_context` is not among the request's enabled tools, no model
invocation MUST receive a usage note.

**AC-NOTE-5** — On the second and later invocations within one tool loop, the note's
`usedTokens` MUST equal `inputTokens + outputTokens` of the previous invocation's response.

**AC-NOTE-6** — For a conversation with `compact_context` enabled, the request JSON preview's
`messages` MUST contain the identical usage note string at the identical index as the messages
the server sends to the mocked provider for the same steps, and the transcript MUST NOT render
the note as a step.

## `compact_context` Tool (S5)

**AC-TOOL-1** — `tools.update` MUST include `compact_context` with an input schema requiring a
non-empty string `summary` and allowing an optional string `remaining_work`.

**AC-TOOL-2** — When a response's only tool call is a valid `compact_context`, the server's
`chat.done` MUST carry `compaction.summary`, `compaction.remainingWork` and
`compaction.toolCallStepId`, and the server MUST NOT invoke the model again in that request.

**AC-TOOL-3** — The `chat.done` of AC-TOOL-2 MUST contain the `tool_call` step and a `tool_result`
step with `toolResult.name === "compact_context"`; when the call carries an id (OpenAI-compatible
mocked provider), `toolResult.id` MUST equal it.

**AC-TOOL-4** — *removed*

**AC-TOOL-5** — When a response contains `compact_context` together with other tool calls, the
server MUST execute none of them, MUST return an error `tool_result` for every call in that
response, MUST NOT attach `compaction` to any `chat.done`, and MUST invoke the model again.

**AC-TOOL-6** — A `compact_context` call with an empty or missing `summary` MUST yield an error
`tool_result` and no `compaction` payload.

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
`maxToolCalls` and `activeToolIds`.

**AC-FORK-3** — The fork's steps, before its first response, MUST be exactly the original's
`system` steps followed by one `compaction` step whose content contains the `summary` and, when
present, the `remainingWork`.

**AC-FORK-4** — The original's steps after compaction MUST equal its steps before the request
plus the steps of the request's `chat.done`; no other field of the original MUST change except
`updatedAt`.

**AC-FORK-5** — The fork MUST be the selected conversation and MUST appear in the sidebar list
returned by `orderVisibleConversations`.

**AC-FORK-6** — The client MUST send a `chat.send` for the fork without user input, and only after
the original's `chat.done` has been applied to the original.

**AC-FORK-7** — The fork's first `chat.send` MUST NOT include `compact_context` in `tools`; the
fork's next user-initiated `chat.send` MUST include it when it is active.

**AC-FORK-8** — The `compaction` step MUST render as a card labelled with the authoring model and
`compact_context`, MUST NOT render as an assistant message, and the fork MUST render a link whose
activation selects the original conversation.

**AC-FORK-9** — `validateChatRequest` MUST accept a `chat.send` whose steps contain a
`compaction` step.

**AC-FORK-10** — `applyContextPlacement` MUST map a `compaction` step onto the wire position named
by the placement data for the request's `modelFamily`, and the serialised messages of
`shared/ollama-format.ts` and `shared/openai-format.ts` MUST both contain the summary text.

## Cross-Cutting Invariants

**AC-STRUCT-1** — `StepKind` in `server/types.ts` and `src/types/chat.ts` MUST both include
`"compaction"`, `server/request-validation.ts` `STEP_KINDS` MUST include `"compaction"`, and the
`chat.done` variant of `ServerMessage` on both sides MUST declare the optional `compaction` field.

**AC-STRUCT-2** — `src/lib/context-window.ts` MUST export `resolveContextWindow` and
`computeContextFill`, and `grep -rn "computeContextFill\|showContextMeter" server/` MUST return no
matches.

**AC-STRUCT-3** — `npm run lint`, the unit suites and the release gate MUST pass.

## Manual Validation

| MV id | Behavioral intent | Gap evidence | Owner | Blocked on | Adjudicated |
|-------|-------------------|--------------|-------|------------|-------------|
| MV-1  | The `Findings` in `docs/research/compaction-placement.md` reflect what the named Ollama version actually renders and caches for each family. | Observations come from live models and debug logs on a specific host; a recorded-fixture test would only replay what the author already wrote down and cannot discriminate a wrong observation. Cheapest automated alternative — a live-gated test asserting the default placement renders without template errors for the default test model — checks one family, not the per-family claims. | Markus | AC-RES-3 | |
