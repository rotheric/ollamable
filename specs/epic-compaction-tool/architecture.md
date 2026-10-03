# Compaction Tool — Architecture

## Paradigm

Modular monolith split into two TypeScript projects. `tsconfig.json` (frontend) excludes
`server/`; `tsconfig.server.json` covers `server/**` and `shared/**`. `shared/` is the only code
both sides import: pure functions over structural types (`FormatStep`), importing only other
`shared/` files, with `.js` import suffixes. Server layering: transport (`index.ts`,
`ws-handler.ts`) → router (`llm-router.ts`) → provider clients (`ollama-client.ts`,
`openai-client.ts`) → tools (`tool-executor.ts`, `tools/*`). Frontend: composition root
(`src/components/chat-workspace.tsx`) composing hooks (`src/lib/use-*.ts`) and pure helpers
(`src/lib/*.ts`), with presentational components.

## Module Map

| Module | Location | Purpose | Owned data |
|---|---|---|---|
| context-usage | `shared/context-usage.ts` (new) | `contextPercent`, `buildContextUsageNote`, placement data, `applyContextPlacement` | placement default + per-family exceptions |
| context-window | `src/lib/context-window.ts` (new) | `resolveContextWindow`, `computeContextFill` (pure; fill = latest response's usage) | none |
| model-name | `shared/model-name.ts` (new) | `withDefaultTag` (default-tag normalisation shared by both sides) | none |
| sidebar-prefs | `src/lib/chat.ts`, `src/lib/use-sidebar-state.ts` | `showContextMeter`, remembered runtime window per `provider/model` | persisted `SidebarState` |
| backend-http-client | `src/lib/ollama.ts` | `fetchModelRuntime` next to `fetchModelMeta` | none |
| runtime-route | `server/index.ts`, `server/llm-router.ts` (`runtimeInfo`), `server/ollama-client.ts` (`/api/ps` fetch) | `POST /models/runtime` | none |
| compact-context-tool | `server/tools/compact-context.ts` (new) | `ToolExecutor` definition; registered in both dispatchers | none |
| tool-loop | `server/ws-handler.ts` | note injection, placement per invocation, `compact_context` interception, sole-call rule, `chat.done.compaction` | none |
| provider-clients | `server/openai-client.ts` | `stream_options.include_usage` | none |
| wire-types | `server/types.ts`, `src/types/chat.ts`, `server/request-validation.ts` | `compaction` kind, `chat.send` fields, `chat.done.compaction`, `forkedFrom` | n/a |
| transport-client | `src/lib/backend-client.ts` | carry new `chat.send` fields and the `compaction` payload of `chat.done` | pending streams |
| transcript-model | `src/lib/transcript.ts` | `compaction` as visible turn boundary | none |
| fork-flow | `src/lib/fork.ts`, `src/lib/use-chat-generation.ts`, `src/lib/use-conversations.ts`, wired in `chat-workspace.tsx` | build fork, append harness step to the original, select the fork; no send | `forkedFrom` |
| meter-ui | `src/components/context-meter.tsx` (new) + settings preference row | render meter | none |
| compaction-card-ui | `src/components/transcript-step.tsx`, `step-card.tsx` | render `compaction` card with back-link (fork) and the harness event card with a link to the fork (original) | none |
| preview-parity | `src/components/request-json-dialog.tsx`, `src/lib/token-view.ts`, `src/components/request-preview-extras.tsx` | apply the same placement + rebuilt note | none |
| research | `docs/research/compaction-placement.md` (new) | S3 findings and decision | n/a |

## Boundary Rules

1. No direct imports across `server/` and `src/`. Wire types stay duplicated in
   `server/types.ts` and `src/types/chat.ts` (existing convention).
2. `shared/` imports only `shared/`. Server imports it as `../shared/x.js`; frontend as
   `@/shared/x` or `../../shared/x`.
3. Provider-type gates on the server use `ProviderConfig.type`, never the provider id.
4. No meter or percentage *display* logic under `server/` (AC-STRUCT-2); the only shared
   arithmetic is `contextPercent` in `shared/context-usage.ts`.
5. `applyContextPlacement` returns a new array and is applied only to the per-invocation copy
   passed to `router.streamResponse`; the tool loop's accumulator (`steps`) and everything sent in
   `chat.delta`/`chat.steps`/`chat.done` stay untransformed.
6. Composition of hooks (fork creation + harness step + selection; nothing is sent) happens in the composition root or a hook it
   calls; components do not import each other's internals.

## Seams

- **S-PLACEMENT** — `applyContextPlacement(steps, { note?, family? }) → steps` and
  `buildContextUsageNote({ usedTokens?, windowTokens, source })` in `shared/context-usage.ts`.
  Producer: S3/S4. Consumers: tool loop (S4/S5), request preview + token view (S4), fork
  serialisation (S6). `omitCompactionArtifacts` (same file) drops the harness step and
  unanswered `compact_context` calls (paired by id, or nearest preceding id-less pair) from every
  wire request.
- **S-WINDOW** — `resolveContextWindow(...) → { tokens, source, stale? }` (S1). Consumers: meter
  (S2), `chat.send` fields (S4).
- **S-RUNTIME** — `POST /models/runtime` → `{ loaded: boolean, metadata: boolean, contextLength? }`
  (S1). `metadata` is false for non-Ollama provider types and tells the client to skip
  `/models/show`.
- **S-COMPACTION-WIRE** — `chat.done.compaction: { toolCallStepId, summary, remainingWork? }`
  (S5 producer, S6 consumer); `StepKind "compaction"` (S5/S6).

## Implementation Constraints

- The app never sets `options.num_ctx`.
- Built-in tool failures in the loop currently throw into `chat.error`; the sole-call rule needs
  explicit per-call error `tool_result` creation and explicit `toolCallCount` increments.
- Every `compact_context` call, honoured or rejected, counts against `maxToolCalls`.
- Register `compact_context` after `web-search` and `curl` (tour picks `builtinTools[0]`) and
  before `McpBridge` construction.
- Fill = the latest response's usage (`lastUsedTokens`); an assistant step without usage → unknown.
- New test files import from `vitest` explicitly; server tests use relative `.js` imports.
- Vitest stays on 3.x.

## Order-Sensitive Composition

Yes — two flows depend on ordering:

1. **Compaction → harness step → fork (no send).** Modules: tool-loop (`server/ws-handler.ts`),
   transport-client (`src/lib/backend-client.ts`), fork-flow (`src/lib/fork.ts`,
   `src/lib/use-chat-generation.ts`, `src/lib/use-conversations.ts`,
   `src/components/chat-workspace.tsx`). Guarantees: the original's `chat.done` steps are applied
   first, then the harness meta step is appended to the original, then the fork is added and
   selected; nothing is sent for the fork until the user writes (the first user send collates the
   summary and the user's text into one user-role wire message); the original settles once, in its
   own `finally`; no fork on stop, supersession or error.
2. **Tool loop per-invocation placement.** Modules: tool-loop, context-usage
   (`shared/context-usage.ts`). Guarantees: the note for invocation *k* uses invocation *k−1*'s
   usage; placement never leaks into accumulated or emitted steps regardless of how many
   invocations or tool rounds run; rejected sole-call responses still advance budgets
   monotonically.
