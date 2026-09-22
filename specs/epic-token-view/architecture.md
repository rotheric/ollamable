# Token View — Epic Architecture

*Derived from `exploration.json` (three parallel code-explorer passes, 2026-09-21). Living
document: the story planner populates `## Seams`; the implementation loop amends
`## Implementation Constraints` as contracts firm up.*

## Paradigm

Modular monolith with a hard, tooling-enforced split between two TypeScript projects that
share a duck-typed wire-format layer.

- `tsconfig.json` (frontend) **excludes** `server/` outright — the frontend project cannot
  typecheck against server code even if it tried.
- `tsconfig.server.json` includes `server/**` and `shared/**`, never `src/**`.
- `shared/` bridges the two by declaring **minimal structural interfaces** (`FormatStep`,
  `FormatTool` — `shared/openai-format.ts:11-23`) that both sides' concrete types satisfy
  structurally. Nothing is imported across the boundary.
- Consequently `server/types.ts` and `src/types/chat.ts` are **deliberately duplicated**
  definitions of the same payload shapes, independently maintained.

This epic follows that paradigm rather than amending it.

## Module Map

| Module | Location | Purpose | Owned data | New? |
|---|---|---|---|---|
| tokenizer | `server/tokenizer.ts` | Byte-level BPE over vocab fetched from Ollama; pre-tokenizer split; special-token handling | Vocab/merge table cache keyed by `(baseUrl, model)` | **new** |
| ollama-client | `server/ollama-client.ts` | Streaming chat, delta accumulation, usage capture | `assistantStep.content` / `.contentTokens`, `reasoningStep.*` | existing |
| llm-router | `server/llm-router.ts` | Provider resolution and type-gated capability routing | `modelProviderMap` | existing |
| ws-handler | `server/ws-handler.ts` | Message dispatch, tool-call loop | per-connection stream state | existing |
| wire types | `server/types.ts`, `src/types/chat.ts` | Duplicated payload + message unions | — | existing |
| backend-client | `src/lib/backend-client.ts` | Client-side WS correlation | `pending` (by conversationId) + **new** tokenize map (by requestId) | existing |
| token-view | `src/lib/token-view.ts` | Separator formatting, whitespace markers, boundary-source resolution | — | **new** |
| useTokenBoundaries | `src/lib/token-view.ts` (hook) | Debounced tokenize round trip, per-step boundary cache | per-step cache | **new** |
| chat persistence | `src/lib/chat.ts` | Sidebar prefs + conversation localStorage | `SidebarState`, conversations | existing |
| workspace | `src/components/chat-workspace.tsx` | All UI | sidebar state | existing |

## Boundary Rules

1. **No direct imports across `server/` ↔ `src/`.** Enforced by tsconfig exclusion, not just
   convention. Anything both sides need is either duplicated (payload types) or expressed as a
   structural interface in `shared/`.
2. **`server/tokenizer.ts` is server-only and needs no `shared/` type.** Only primitives
   (`string[]`, `number[]`) cross the WebSocket. `shared/openai-format.ts` is precedent for
   *wire-format builders consumed identically on both sides* — tokenization is not that, because
   the frontend never tokenizes (Design Decision 5).
3. **Server imports use explicit `.js` extensions** on `.ts` sources (NodeNext resolution).
   Frontend imports use the `@/*` path alias.
4. **Ollama-only capabilities gate on `ProviderConfig.type`**, never on provider *name*. Existing
   precedent: `llm-router.ts:112-126` (`showModelMeta`).
5. **The tokenizer must not reuse `fetchOllamaModelMeta`** (`ollama-client.ts:59-74`): it POSTs to
   `/show` without `verbose: true` and therefore returns no vocab. Do **not** add a `verbose` flag
   to that shared function — its existing caller (`llm-router.ts:172`) must stay non-verbose, as
   nothing else wants a 4.2MB response.
6. **Tests importing `server/*` live in `tests/integration/`** (node env,
   `vitest.server.config.ts`). The split is bundle-driven, not pyramid-driven —
   `ollama-client.test.ts:1-6` states this explicitly.

## Seams

*(Populated by story-planner Mode 2. Listed here are the cross-story contracts already known
from exploration.)*

- **S1 → S2**: `ConversationStep.contentTokens?: string[]`, invariant
  `contentTokens.join("") === content`. S2 consumes it as the `stream` boundary source.
- **S3 → S2**: `useTokenBoundaries` `computed` branch. S2 is verified against an *injected fake*
  `computed` source so it does not block on S3 (AC-UX-2 states this explicitly).
- **S3 → S4**: `tokenize(model, text)` promise API on `backend-client`.
- **S1 → S4**: `assistantStep.usage.inputTokens` as the reconciliation oracle.

## Implementation Constraints

1. **`backend-client.handleServerMessage` drops `conversationId`-less messages.** Line 60 is
   `if (!msg.type || !msg.conversationId) return;`. `tokenize.result` / `tokenize.error` correlate
   by `requestId` and would be **silently discarded**. The tokenize branch must sit *ahead of* or
   *independent of* that guard, with its own `Map<requestId, {resolve, reject}>`. The existing
   `pending` map is keyed by conversation and assumes one in-flight stream per conversation; it
   cannot be extended for concurrent tokenize calls.
2. **`tokenize.error`'s typed `reason` enum is new protocol vocabulary.** The only existing error
   path is `chat.error`, an untyped message string (`ws-handler.ts:266-274`). No precedent to
   follow.
3. **Reasoning deltas accumulate on a separate step object.** `contentTokens` must be pushed in
   the `if (chunk.message?.thinking)` block (`ollama-client.ts:190-195`), independently of the
   assistant block at `:186-188`.
4. **Tool-loop turns frequently have no usage at all.** `compactSteps` (`ollama-client.ts:233-243`)
   drops an assistant step whose content is empty; `ws-handler.ts:163-171` then mints a synthetic
   replacement carrying `toolCalls` and **no** `usage`. Only the final loop iteration reliably
   carries usage. This is the mechanism behind AC-UX-6 declaring tool-loop turns unavailable for
   reconciliation.
5. **The displayed request preview is not the reconciled tokenization.**
   `requestJsonPreview` (`chat-workspace.tsx:918-935`) unconditionally uses
   `buildOpenAIRequestBody`/`toOpenAIMessages` even for Ollama conversations. Reconciliation must
   independently filter via `toOllamaMessages`' rules (`ollama-client.ts:245-301`). It is not
   "count the tokens in the box above".
6. **No debounce utility and no `requestId` pattern exist anywhere in the repo.** Both are
   greenfield for S3; there is no local idiom to mirror.
7. **`saveConversations` has exactly one caller** (`chat-workspace.tsx:821`), so the quota wrap
   touches one function body and needs no call-site changes.
8. **Large-fixture policy (lead decision).** The ~4.2MB vocab fixture is stored **gzipped** and
   inflated in test setup via node's builtin `zlib`. No new dependency; the full real vocab is
   preserved (a trimmed subset would silently weaken AC-TOK-7). This repo has no prior
   large-fixture or LFS convention — this epic establishes it.
8b. **Stream-transcript fixture convention (established S1).** Any test asserting against
   *Ollama-authored* stream boundaries replays a committed raw NDJSON transcript captured from a
   live `/api/chat`, never a hand-authored chunk array. Two exist, both plain completions (no
   thinking, no tool calls), capturing both AC-TOK-4 branches — verified against Ollama 0.30.8:
   - `tests/fixtures/plain-completion-stream.ndjson` — 7 content chunks, `eval_count: 8`,
     `done_reason: "stop"` → the **N-1** (EOS) case.
   - `tests/fixtures/plain-completion-stream-length-capped.ndjson` — 6 content chunks,
     `eval_count: 6`, `done_reason: "length"` → the **N** case.
   `eval_count` MUST be read from the recorded final line, never restated as a literal. This
   convention exists because AC-TOK-4 forbids self-authored boundaries but the epic originally
   defined no compliant path, making a hand-authored restatement the path of least resistance.

9. **Pre-existing red state, not to be "fixed" by this epic.**
   - `npm run lint` is non-functional: no ESLint config exists; `next lint` prompts interactively.
     No verification step may claim a green lint.
   - `npx tsc --noEmit -p tsconfig.json` is already red — **181 errors across three files**
     (`tests/unit/chat-workspace.test.tsx` 115, `tour-data.test.ts` 47,
     `openai-format.test.ts` 19), all from missing `"types": ["vitest/globals"]`. **All are in
     `tests/unit/`; zero in `src/` or `server/` production code.**
     *Amended at epic close (was ~201 across four files, including `chat.test.ts`).* The
     pre-ship mutation gate's remediation round had to add
     `import { describe, it, expect, beforeEach } from "vitest"` to `tests/unit/chat.test.ts`
     for its own 10 new test blocks — without it they contributed ~28 NEW errors, breaking the
     binding zero-net-new rule, and there was no option that both added the tests and preserved
     201. The same import incidentally resolved that file's 20 pre-existing errors of the
     identical kind, which is why the baseline fell rather than rose. Every sibling test file
     already uses explicit imports, so this follows the repo's own convention. Machine-readable
     source of truth: `epic-state.json#frontend_typecheck_baseline`.
     **Always measure this with `--incremental false`.** The original exploration reported "17
     errors in one file" because it read a stale `tsconfig.tsbuildinfo`, which was already dirty
     at epic start (it is in `pre_existing_dirty_files`). Corrected during S1.
     `tsconfig.server.json` is clean (exit 0) and MUST stay clean.
   - `tests/integration/*.test.ts` are typechecked by **neither** tsconfig.
   - `tests/unit/chat-workspace.test.tsx:175` fails against `chat-workspace.tsx:1759`
     (`"Open model settings for …"` vs expected `"Open metadata for …"`). Epic tests must avoid
     that button so they neither collide with nor mask it.
10. **Verified anchors** (conflicting explorer reports resolved against the file): step-content
    render branch `chat-workspace.tsx:~2240`; `renderMarkdown` checkbox `~2854`; sidebar state
    initializer `~385`; destructure `~418`; request preview memo `~918-935`; transcript region for
    AC-UX-7's innerHTML capture `[data-tour="transcript"]` at `~2003`.

## Order-Sensitive Composition

This epic **does** compose order-sensitive behavior. Recorded conservatively per FR-A1.

**Flow 1 — concurrent vocab acquisition.**
Participating modules: `tokenizer` (`server/tokenizer.ts`), `llm-router` (`server/llm-router.ts`).
Two `tokenize` requests for the same `(baseUrl, model)` arriving before the first `/api/show`
resolves must issue exactly one HTTP request (AC-PERF-1's `Promise.all` case). A cache populated
only on resolution issues two. Candidate whole-flow guarantee: *for any interleaving of N
concurrent first-calls on one key, exactly one `/api/show` is issued and all N resolve to the same
vocab table.*

**Flow 2 — delta accumulation ordering.**
Participating modules: `ollama-client` (`server/ollama-client.ts`), `wire types`
(`server/types.ts`, `src/types/chat.ts`).
`contentTokens` is appended in stream order in the same block that appends to `content`. Candidate
whole-flow guarantee: *for any chunk sequence, including interleaved `content` and `thinking`
chunks, each step's `contentTokens.join("") === content` holds at every observation point, not only
at `done`.*

**Flow 3 — persistence under quota failure.**
Participating modules: `chat persistence` (`src/lib/chat.ts`), `workspace`
(`src/components/chat-workspace.tsx`).
The retry-with-`contentTokens`-stripped path must not partially write. Candidate whole-flow
guarantee: *a quota failure on one conversation leaves every other conversation persisted, and a
reload after the retry yields steps whose boundary source is `unavailable` rather than missing
conversations.*
