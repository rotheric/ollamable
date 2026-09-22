# Token View

## Problem

Ollamable's stated purpose is to expose what actually happens when a local LLM answers a
prompt. The transcript shows roles and steps, the right sidebar shows the outgoing request
as JSON, and streaming deltas assemble in real time. Every one of those layers is still
*text*. The model does not consume text — it consumes a sequence of integers produced by a
byte-level BPE tokenizer, and it emits one integer at a time. That layer is currently
invisible, which leaves the app unable to explain the questions learners most often arrive
with: why a model miscounts the letters in a word, why a German or code-heavy prompt costs
more than an English one of the same length, what a context window is actually full of, and
what the scaffolding around a chat message is.

The information is already in the building and being discarded. `server/ollama-client.ts:220-224`
reads `prompt_eval_count` and `eval_count` off the final stream chunk into `UsagePayload`, so
the transcript can display *how many* tokens a turn cost but never *which* ones. Worse, the
boundaries of the model's own output arrive over the wire on every generation and are thrown
away: the delta loop concatenates each chunk into `assistantStep.content`, after which the
split points are unrecoverable.

## Solution

Add a **token view** — a display toggle that re-renders conversation content with token
boundaries made visible, using a `│` (U+2502) separator between adjacent tokens rather than
colored chips or per-token DOM nodes. The toggle sits beside the existing `renderMarkdown`
switch in the right sidebar and applies to the whole transcript, because the lesson is "all
of this is tokens", not "this particular message is tokens".

The two halves of the feature have very different costs, and the spec treats them as separate
work:

- **Output boundaries arrive free with the stream.** Empirical check against Ollama 0.30.8: a
  `/api/chat` stream for a 6-token completion produced exactly 5 content deltas —
  `['red', ',', 'blue', ',', 'green']` — against `eval_count: 6`, the sixth being the EOS
  token, which is never emitted as content. For plain completions Ollama's deltas are 1:1
  with generated tokens. They are **not** universally 1:1: the runner buffers incomplete UTF-8
  sequences, holds stop-sequence prefixes, buffers around `<think>`/`</think>`, and consumes
  `<tool_call>` markup entirely. The feature therefore labels this source honestly as *stream
  boundaries* rather than claiming exact tokens, and scopes its count assertion to completions
  where the property holds.
- **Input tokens require a real tokenizer.** `POST /api/show` with `{"verbose": true}` returns
  the running model's own vocabulary and merge table in `model_info`
  (`tokenizer.ggml.tokens`, `tokenizer.ggml.merges`), so the app can tokenize with the exact
  vocabulary of the exact model the user is chatting with — no HuggingFace mapping table, no
  approximate-tokenizer disclaimer.

**The app does not reproduce the chat template.** `buildOllamaChatBody`
(`server/ollama-client.ts:101-115`) sends `{model, stream, messages, tools, options, think}`;
Ollama applies the model's Go template server-side. Reconciliation therefore compares the
tokenized *message contents* against `prompt_eval_count` and presents the difference as
labelled template overhead — an explained, expected quantity, not a mismatch. The model's raw
template string is available from `/api/show` and is displayed verbatim as a teaching artifact,
which delivers the special-token reveal without the app pretending to render Go templates.

## Scope

### In Scope

- Retention of per-delta stream boundaries from Ollama through the step model and localStorage
  persistence, including a quota-failure policy.
- A `showTokens` sidebar preference and separator-based rendering of step content.
- A server-side tokenizer for Ollama models: vocabulary/merge acquisition via `/api/show`, a
  per-(baseUrl, model) in-process cache, `qwen2`-family pre-tokenizer split, and byte-level BPE.
- A `tokenize` WebSocket request/response pair, its `backend-client.ts` client, and the
  `useTokenBoundaries` hook branch that consumes it.
- A committed vocabulary fixture and golden-segmentation fixture for `qwen3:1.7b`, plus the
  capture script that regenerates both, so the conformance suite proves correctness without a
  live host.
- Content-token counting for the request preview, reconciled against `prompt_eval_count` with
  template overhead shown as a labelled difference.
- Verbatim display of the model's chat template string as fetched from `/api/show`.
- Graceful degradation for providers, conversations, and turns that cannot supply boundaries.

### Out of Scope

- **A Go chat-template renderer.** Reproducing Ollama's server-side template rendering
  byte-exactly (message joins, tool-schema serialization order, think-tag injection, the
  trailing generation prompt) is a deliverable comparable in size to the tokenizer itself, with
  its own silent-wrongness failure mode. Without it, exact-zero reconciliation is impossible;
  the labelled-overhead presentation is the deliberate alternative.
- Tokenizer support for non-Ollama providers (`server/openai-client.ts`). Those report usage
  counts but expose no vocabulary; the toggle degrades per AC-ERR-2.
- A context-window budget visualization. It depends on this epic's tokenizer but is a separate
  display concern.
- Token-level color, heatmaps, density-per-word views, or hover cards exposing token ids.
- A standalone tokenizer playground route decoupled from a conversation.
- Detokenization (entering token ids and seeing text).

## Design Decisions

1. **Separator rendering with `│` (U+2502), not chips and not ASCII `|`.** Token boundaries
   render as a separator inside a single monospace text node, not as per-token elements with
   backgrounds: a paragraph tokenizes into hundreds of tokens, and hundreds of styled spans per
   step card is both a layout cost and a maintenance liability for a component already at 3675
   lines. The separator is U+2502 rather than ASCII `|` because a token may itself *contain* a
   pipe, and an ASCII separator would make `a|b` as one token indistinguishable from two — a
   confident falsehood in an app whose purpose is the opposite. U+2502 is visually equivalent at
   text size and effectively absent from real content. Refs: `src/components/chat-workspace.tsx:2245`.

2. **Token view suppresses markdown.** `react-markdown` reflows and restructures text, so
   boundaries computed over the source string cannot be placed inside rendered markdown output.
   In token view, content renders as raw monospace text. The raw string is precisely what was
   tokenized, so showing it is the more honest display. Token view also does **not** apply the
   existing leading/trailing-newline strip (`chat-workspace.tsx:2242,2246`), which would
   silently delete a leading or trailing newline token. Refs: `chat-workspace.tsx:2240-2243`.

3. **Output boundaries come from the stream and are labelled as such.** Re-tokenizing assistant
   output would produce boundaries that are *plausible* but not necessarily the ones the model
   emitted (tokenizers are not guaranteed to round-trip a decoded string to the same sequence).
   The deltas are what actually arrived and are already in hand. But they are not always one
   token each — Ollama's runner buffers incomplete UTF-8, stop-sequence prefixes, think-tag
   parsing, and tool-call markup — so the UI names this source **stream boundaries** and carries
   a one-line caveat, rather than asserting exact tokens. The 1:1 count claim is asserted only
   where it holds (AC-TOK-4). Refs: `server/ollama-client.ts:~190`.

4. **Delta retention is additive and versioned by absence.** `ConversationStep` gains an optional
   `contentTokens?: string[]`. Steps persisted before this epic will not have it, and no
   migration can reconstruct it. Absence is a first-class state meaning "boundaries unknown",
   rendered per AC-ERR-1 rather than silently substituted with a re-tokenized guess. Refs:
   `src/types/chat.ts:52-64`.

5. **Tokenization runs on the server, never in the browser.** The verbose `/api/show` payload for
   `qwen3:1.7b` is 4.2 MB (151936 vocab entries plus 151387 merges) against 49 KB for the
   non-verbose call. That table stays in the Node process, cached per `(baseUrl, model)` pair —
   keyed by both because the same model name can resolve to different vocabularies across hosts.
   Only computed boundaries cross the WebSocket. This also keeps the frontend a static Next.js
   build with no tokenizer dependency.

6. **The pre-tokenizer split is mandatory, not an optimization.** `model_info` reports
   `tokenizer.ggml.model: "gpt2"` (byte-level BPE) and `tokenizer.ggml.pre: "qwen2"`. Running BPE
   merges across the whole string without first applying the `qwen2` split regex yields
   boundaries that look reasonable and are wrong — the single most likely way this feature ships
   a confident lie.

7. **Reconciliation compares contents, and names the remainder.** Ollama independently reports
   how many tokens it ingested. Since the app cannot reproduce the template, the computed figure
   is the tokenization of the *message contents that preceded the assistant step in question* —
   `steps[0..i)` filtered exactly as `toOllamaMessages` filters them — and the difference against
   that step's `prompt_eval_count` is displayed as labelled template overhead. Comparing against
   the live preview instead would be wrong: `requestJsonPreview` (`chat-workspace.tsx:931`) is
   built from `selectedConversation.steps`, which after a completion *includes* the new assistant
   step, so a naive comparison would report a mismatch on every turn. Turns containing
   `tool_call` steps carry `usage` from the last of several `/api/chat` calls and are declared
   unavailable for reconciliation. Refs: `server/ollama-client.ts:220-224`, `server/ws-handler.ts`.

8. **The toggle follows the existing sidebar-preference pattern.** `showTokens` is added to the
   sidebar preference object alongside `renderMarkdown`, using the same `updateSidebar` write path
   and persistence. Refs: `chat-workspace.tsx:385`, `:2854-2855`.

9. **The conformance suite runs off committed fixtures; only the oracle is live.** This epic is
   the first in the repo to want a live Ollama host in a test. The existing integration suite
   deliberately does the opposite — `tests/integration/ws-handler.test.ts:13-14` mocks
   `streamOllamaResponse` "so these tests exercise the handler logic without needing a running
   Ollama" — and there is no CI config to pin an environment against. The vocab and merge tables
   are captured once into a fixture and the conformance ACs run against it on any machine. Only
   AC-TOK-1 and AC-TOK-5 stay live; they skip rather than fail when the host is unreachable *or*
   the fixture model is not pulled (AC-ERR-3). The tokenizer suite lives under `tests/integration`
   (`vitest.server.config.ts`, node environment) — not `tests/unit`, which runs under jsdom.

10. **Goldens make the hostless suite mean something.** Vocab-and-join assertions alone do not
    pin down segmentation: a tokenizer that splits every pre-token into single bytes satisfies
    round-trip, vocab-membership, and special-token handling without ever consulting the merge
    table. The capture script therefore also records expected `tokenIds` sequences from a
    reference tokenizer (llama.cpp `llama-tokenize`, or HF `tokenizers` against the model's
    `tokenizer.json`), committed beside the vocab. AC-TOK-7 asserts exact sequence equality
    against them. The reference tokenizer is a capture-time dependency only and is never shipped
    or imported by `server/`.

## Technical Approach

### `server/types.ts`

Extend `ConversationStep` with `contentTokens?: string[]`. Extend the `ClientMessage` union with
`{ type: "tokenize"; requestId: string; model: string; provider?: string; text: string }` and the
`ServerMessage` union with
`{ type: "tokenize.result"; requestId: string; tokens: string[]; tokenIds: number[] }` and
`{ type: "tokenize.error"; requestId: string; reason: "unsupported_provider" | "vocab_unavailable" | "internal"; message: string }`.
The same `ConversationStep` extension is mirrored in `src/types/chat.ts`.

### `server/ollama-client.ts`

In the delta loop that appends chunk content to `assistantStep.content` (around line 190), push
the same chunk string onto `assistantStep.contentTokens`. The invariant is
`contentTokens.join("") === content`; content stays authoritative and the array is a parallel
record of how it arrived. Reasoning steps get the same treatment.

### `server/tokenizer.ts` (new)

```ts
// Acquire once per (baseUrl, model); cache in-process, keyed by both.
async function loadVocab(baseUrl: string, model: string): Promise<VocabTable>
// -> POST {baseUrl}/show {model, verbose: true}   // OLLAMA_URL already ends in /api
//    model_info["tokenizer.ggml.tokens"]  : string[]
//    model_info["tokenizer.ggml.merges"]  : string[]   (index == merge rank)
//    model_info["tokenizer.ggml.pre"]     : "qwen2" | ...

export async function tokenize(baseUrl: string, model: string, text: string):
  Promise<{ tokens: string[]; tokenIds: number[] }>
// 1. match special tokens (<|im_start|>, <|im_end|>, bos/eos ids) before splitting
// 2. split remaining text with the pre-tokenizer regex named by tokenizer.ggml.pre
// 3. map each piece through the GPT-2 byte->unicode table (space -> "Ġ")
// 4. apply BPE merges within each piece, lowest rank first
// 5. look up each merged symbol in the vocab for its id
// 6. decode symbols back to display strings (Ġ -> " ") before returning
```

Concurrent first calls for the same key must share one in-flight `/api/show` promise rather than
issuing two requests. Unknown or unsupported `pre` values fail closed with `vocab_unavailable`
rather than falling back to a generic split.

### `scripts/capture-vocab-fixture.mjs` (new) and `tests/fixtures/`

Calls `POST {OLLAMA_URL}/show` with `{"model": <arg>, "verbose": true}` and writes `tokens`,
`merges`, and the scalar `tokenizer.ggml.*` fields to `qwen3-1.7b-vocab.json.gz`, dropping the
`modelfile`, `license`, and `tensors` bulk. It then runs each fixture-set string through a
reference tokenizer and writes the expected id sequences to `qwen3-1.7b-goldens.json`. Both are
committed. `server/tokenizer.ts` never reads either file — they exist so tests can serve a stubbed
`/api/show` carrying real vocab data, keeping AC-DEP-1's "no bundled vocabulary at runtime"
constraint intact while removing the live-host requirement.

### `server/ws-handler.ts`

Add a `tokenize` case alongside `chat.send` / `chat.stop`, routing by
`ProviderConfig.type === "ollama"` (not by provider *name*) to `server/tokenizer.ts`, and replying
`tokenize.error` with `unsupported_provider` otherwise. Responses correlate by `requestId`; the
handler does not assume one in-flight request.

### `src/lib/backend-client.ts`

Add a promise-returning `tokenize(model, text)` that mints a `requestId`, sends the message, and
resolves on the matching `tokenize.result`.

### `src/lib/token-view.ts` and `useTokenBoundaries` (new)

Own separator formatting, whitespace markers, boundary-source resolution, and the debounced
`tokenize()` round trip with a per-step cache. Boundary source per step: `stream` when
`contentTokens` is present; `computed` via the hook for `user` and `system` steps; `pending` while
a round trip is in flight; `unavailable` otherwise.

### `src/lib/chat.ts`

`saveConversations` (line 146) currently calls `window.localStorage.setItem` unguarded.
`contentTokens` inflates stored size roughly 2–4× for assistant and reasoning steps, making
`QuotaExceededError` plausible on long reasoning traces — and an uncaught throw there stops *all*
conversations from persisting. Wrap the write: on quota failure, retry once with `contentTokens`
stripped from every step, so boundaries degrade to `unavailable` rather than persistence failing.

### `src/components/chat-workspace.tsx`

- Add `showTokens: false` to the sidebar preference initializer (near line 385) and a switch beside
  the `renderMarkdown` switch (near line 2854).
- In the step content renderer (line 2240), add one branch ahead of the markdown branch delegating
  to `token-view.ts`. When `showTokens` is on, the markdown branch is not taken regardless of
  `renderMarkdown`.
- In the request-preview panel, add the content-token count, the reconciliation readout, and the
  verbatim template display.

Per AC-STRUCT-3 this file grows by at most 60 net lines; the logic lives in the new modules.

## Stories

- **S1 — Stream boundary retention** — Persist per-delta boundaries through
  `ConversationStep.contentTokens` on both server and client types, with the join invariant
  enforced and the localStorage quota policy in place. Covers AC-STRUCT-1, AC-STRUCT-2, AC-TOK-4,
  AC-ERR-4.
- **S2 — Token view toggle and separator rendering** — `showTokens` preference, sidebar switch,
  raw-text rendering with `│` separators and whitespace markers, markdown suppression, source
  labelling and caveat, unavailable/pending handling. Verified with `stream` boundaries plus an
  injected fake `computed` source; does not depend on S3 landing first. Covers AC-UX-1, AC-UX-2,
  AC-UX-3, AC-UX-4, AC-UX-8, AC-ERR-1.
- **S3 — Server-side Ollama tokenizer and its client** — `server/tokenizer.ts`, the fixtures and
  capture script, the `tokenize` WebSocket round trip, `backend-client.tokenize()`, the
  `useTokenBoundaries` `computed` branch, and the live-gate skip guard. Covers AC-DEP-1, AC-DEP-2,
  AC-TOK-1, AC-TOK-2, AC-TOK-3, AC-TOK-6, AC-TOK-7, AC-PERF-1, AC-ERR-2, AC-ERR-3.
- **S4 — Content-token reconciliation and template display** — Content-token counting for the
  request preview, the reconciliation readout with labelled template overhead, and verbatim
  template display. Covers AC-UX-5, AC-UX-6, AC-TOK-5.

## Acceptance Criteria

See [`acceptance-criteria.md`](./acceptance-criteria.md).

## Relationship to Other Epics

- **frontend-architecture-and-maintainability** (BACKLOG epic) — This epic adds UI to
  `chat-workspace.tsx`, already flagged at 3675 lines. AC-STRUCT-3 caps its growth at 60 net lines
  so this epic reduces rather than worsens that pressure.
- **provider-and-model-platform** (BACKLOG epic) — Token view is Ollama-only in v1. The degradation
  path (AC-ERR-2) is the provider-capability question that epic owns.
- **quality-and-release-safety** (BACKLOG epic) — The unit baseline is red on a pre-existing
  `chat-workspace.test.tsx` label mismatch (test expects `"Open metadata for…"`, implementation
  renders `"Open model settings for…"`); measured 43 passed / 1 failed at epic start. That failure
  is unrelated to this epic and is not fixed here. This epic also introduces the repo's first
  live-service test gate (AC-ERR-3), which that epic's "document environmental prerequisites" item
  should absorb.
- **sequence-diagram branch (unmerged)** — The cards↔sequence view transition lives on the
  `sequence-diagram` branch, not `master`. Toggling token view changes rendered text length and
  therefore card height, conflicting with that branch's FLIP geometry measurement. When merged, the
  toggle must be disabled while a view transition is in a non-idle phase. A known merge obligation;
  this epic targets `master` and does not implement it.

## Non-Goals

- Ollamable will not become a general-purpose tokenizer playground. Every token view is anchored to
  real conversation content or a real outgoing request.
- Token boundaries will never be approximated *silently*. Where the app cannot know exact
  boundaries — a merged stream delta, a pre-epic persisted step, a non-Ollama provider, a tool-loop
  turn — it says so in the UI and names the reason. It never substitutes a plausible guess from a
  different vocabulary or a re-tokenization presented as ground truth. An educational tool that
  teaches a convincing falsehood is worse than one that declines to teach.
- The token view will not add per-token interactivity (hover cards, click-to-inspect, selection
  semantics). The display stays text.
