# Token View — Acceptance Criteria

## Terminology

- **token view** — the display mode active when the `showTokens` sidebar preference is `true`.
- **separator** — the literal character `│` (U+2502, BOX DRAWINGS LIGHT VERTICAL) rendered between
  two adjacent tokens in token view. Deliberately not ASCII `|`, which can occur inside a token.
- **boundary source** — where a step's boundaries came from: `stream` (the `contentTokens` array
  captured from Ollama deltas), `computed` (a `tokenize` round trip), `pending` (a round trip is
  in flight), or `unavailable`.
- **stream boundaries** — the `stream` source's honest label. Ollama's runner buffers incomplete
  UTF-8 sequences, stop-sequence prefixes, think-tag parsing, and tool-call markup, so a delta is
  not guaranteed to be exactly one token.
- **plain completion** — a completion producing no `reasoning` step and no `tool_calls`. The
  delta-per-token property is asserted only for these.
- **raw-count oracle** — `prompt_eval_count` from `POST {OLLAMA_URL}/generate` with
  `{"raw": true, "stream": false, "options": {"num_predict": 1}}`, which reports how many tokens
  Ollama ingested for a string with no chat template applied. Verified against Ollama 0.30.8.
- **vocab fixture** — `tests/fixtures/qwen3-1.7b-vocab.json`, a committed snapshot of
  `model_info["tokenizer.ggml.tokens"]`, `["tokenizer.ggml.merges"]`, and the scalar
  `tokenizer.ggml.*` fields for `qwen3:1.7b`.
- **golden fixture** — `tests/fixtures/qwen3-1.7b-goldens.json`, committed expected `tokenIds`
  sequences for the fixture set, captured from a reference tokenizer.
- **fixture set** — the strings used by the conformance tests: at minimum `"Hello world"`
  (2 tokens), `"strawberry"` (3 tokens), and `"Die Verkehrsinfrastruktur"` (7 tokens) under
  `qwen3:1.7b`, plus one string containing a fenced code block, one containing consecutive
  newlines, and one containing a literal `|`.
- **live-gated** — an AC whose test compares against a value only a running Ollama can produce,
  and which therefore skips (never fails) when unavailable. Only AC-TOK-1 and AC-TOK-5 are
  live-gated.
- **join invariant** — `step.contentTokens.join("") === step.content`.
- **epic baseline SHA** — the commit recorded in `epic-state.json` at scaffold time, used as the
  diff base for AC-STRUCT-3. This repo commits directly to `master`, so no merge-base exists.

## Known TAGs

- **STRUCT** — structural assertions about files, schemas, types.
- **DEP** — dependency or integration assertions.
- **TOK** — tokenizer correctness assertions.
- **UX** — user-visible behavior assertions.
- **ERR** — error-handling and degradation assertions.
- **PERF** — performance assertions.

## Stream Boundary Retention (S1)

**AC-STRUCT-1** — `ConversationStep` in both `server/types.ts` and `src/types/chat.ts` MUST declare
`contentTokens?: string[]`. A step object omitting the field MUST still satisfy both type
declarations without a cast.

**AC-STRUCT-2** — After a streamed Ollama completion finishes, the resulting assistant step MUST
carry a `contentTokens` array whose length equals the number of stream chunks that contained
non-empty `message.content`, and the join invariant MUST hold. A `reasoning` step produced in the
same completion MUST carry its own `contentTokens` array satisfying the same invariant.

**AC-TOK-4** — For a **plain completion** whose final chunk reports `eval_count: N`, the assistant
step's `contentTokens.length` MUST equal either `N` or `N - 1`, the `N - 1` case occurring only
when the model terminated on an end-of-sequence token. This AC MUST NOT be asserted for
completions producing a `reasoning` step or `tool_calls`: `eval_count` there includes thinking
tokens, think-tag specials, and tool-call markup that are never emitted as content. A test for
this AC MUST exercise a stream whose chunk boundaries it did not itself author — a mock that emits
N chunks and reports `eval_count: N` asserts nothing about Ollama.

**AC-ERR-4** — When persisting conversations raises `QuotaExceededError`, `saveConversations` MUST
retry once with `contentTokens` stripped from every step, and MUST NOT propagate the error to the
caller on that retry path. After such a retry, reloading MUST yield conversations whose steps
render with boundary source `unavailable` rather than absent conversations. A quota failure on one
conversation MUST NOT prevent the others from persisting.

## Token View Toggle and Rendering (S2)

**AC-UX-1** — The right sidebar MUST render a labelled switch bound to the `showTokens` sidebar
preference. Toggling it MUST persist through the same `updateSidebar` path that persists
`renderMarkdown`, and the value MUST survive a page reload.

**AC-UX-2** — When `showTokens` is `true`, a step whose boundary source is `stream` or `computed`
MUST render its content as a single monospace text node in which adjacent tokens are separated by
`│` (U+2502). The rendered node MUST NOT contain one element per token. Given a step whose content
contains a literal `|`, the rendered output MUST contain that `|` as content and MUST NOT contain
`│` at that position, so content and boundary remain distinguishable. This AC is verified with a
`stream` source and with an injected fake `computed` source; it does not require S3.

**AC-UX-3** — When `showTokens` is `true`, a step of kind `assistant`, `user`, or `reasoning` MUST
NOT be rendered through `react-markdown`, regardless of `renderMarkdown`. Given a step whose
content is `` "# Heading\n\n**bold**" ``, the rendered output in token view MUST contain the literal
characters `#` and `**`, and MUST NOT contain an `h1` or `strong` element.

**AC-UX-4** — In token view, each `\n` character MUST render one `↵` glyph before its line break —
one per newline character, not one per token, so a single token containing `\n\n` yields two. Each
space in a run of two or more MUST render as one `·`. Token view MUST NOT apply the
leading/trailing-newline strip that `chat-workspace.tsx:2242,2246` applies outside token view: a
step whose content begins or ends with `\n` MUST show that newline's `↵`. With `showTokens` false,
neither `↵` nor `·` MUST appear in rendered step content.

**AC-UX-8** — A step rendered from the `stream` source MUST display the label "stream boundaries"
and a caveat stating that a delta may merge tokens. A step rendered from the `computed` source MUST
display a notice stating that boundaries were computed under the conversation's current model,
tokenizing the step's text as a standalone string. Neither label MUST claim the boundaries are the
model's exact emitted tokens.

**AC-ERR-1** — A step whose boundary source is `unavailable` — including any assistant step loaded
from localStorage without a `contentTokens` field — MUST render its content unseparated and MUST
render a visible notice naming the reason. The app MUST NOT substitute boundaries computed by
re-tokenizing that step's content. A step whose source is `pending` MUST NOT render that notice;
it renders unseparated content with no reason text until the round trip resolves, so toggling does
not flash a notice for every step.

## Server-Side Ollama Tokenizer and Client (S3)

**AC-DEP-1** — `server/tokenizer.ts` MUST obtain its vocabulary and merge table from
`POST {OLLAMA_URL}/show` with body `{"model": <model>, "verbose": true}`, reading
`model_info["tokenizer.ggml.tokens"]` and `model_info["tokenizer.ggml.merges"]`. The module MUST
NOT read a vocabulary from a bundled file, an npm package, or any host other than the configured
one. Asserted behaviorally: the test serves a **deliberately mutated** vocab fixture (one vocab
entry renamed and two merge ranks swapped) and MUST observe that mutation reflected in
`tokenize()` output. A module that issues the request but reads a committed fixture instead of the
response MUST fail this AC.

**AC-DEP-2** — `scripts/capture-vocab-fixture.mjs` MUST write both fixtures: a vocab fixture whose
`tokens`, `merges`, and scalar `tokenizer.ggml.*` fields are byte-identical to the corresponding
live `model_info` values, and a golden fixture mapping each fixture-set string to the `tokenIds`
sequence produced by the reference tokenizer. Running the script twice against an unchanged model
MUST produce identical output for both files. The reference tokenizer MUST NOT appear in
`dependencies` or be imported by anything under `server/`.

**AC-TOK-1** (live-gated) — For every string in the fixture set, the length of the array returned by
`tokenize(baseUrl, "qwen3:1.7b", s)` MUST equal the raw-count oracle for the same string and model.
When the gate is closed (AC-ERR-3), this AC's test MUST skip and MUST NOT fail.

**AC-TOK-7** (fixture-backed) — For every string in the fixture set, `tokenize()` against the vocab
fixture MUST return a `tokenIds` array exactly equal, element for element, to that string's entry
in the golden fixture. An implementation that splits pre-tokens into single bytes, or that greedily
longest-matches against the vocab without consulting the merge table, MUST fail this AC. This is
the assertion that makes a hostless run meaningful.

**AC-TOK-2** (fixture-backed) — `tokenize()` MUST return `tokens` and `tokenIds` arrays of equal
length, where `tokens.join("") === s` and each `tokenIds[i]` is the index of `tokens[i]` in the
vocabulary. Looking up `tokenIds[i]` in the vocab and applying byte-level decoding MUST yield
`tokens[i]`.

**AC-TOK-3** (fixture-backed) — Given text containing `<|im_start|>` or `<|im_end|>`, `tokenize()`
MUST return each as exactly one element of `tokens`, with the corresponding `tokenIds` entry
matching that token's vocabulary index. The sequence MUST NOT be split across multiple tokens.

**AC-PERF-1** — Two `tokenize` calls for the same `(baseUrl, model)` pair MUST issue exactly one
`POST /api/show`. Asserted for both orderings against a request-counting stub: two sequential calls,
and two calls started concurrently and awaited via `Promise.all`. The concurrent case MUST also
yield a count of 1 — a cache populated only on resolution would issue two.

**AC-ERR-2** — A `tokenize` client message whose resolved provider has
`ProviderConfig.type !== "ollama"` MUST produce a `tokenize.error` with
`reason: "unsupported_provider"`. Routing MUST key on `ProviderConfig.type`, not on the provider's
configured name. A message whose model reports an unsupported `tokenizer.ggml.pre` MUST produce
`reason: "vocab_unavailable"`. Neither case MUST produce a `tokenize.result` carrying boundaries
derived from a different model's vocabulary.

**AC-ERR-3** — The live gate MUST be closed when `OLLAMA_URL` is unreachable **or** when
`GET {OLLAMA_URL}/tags` does not list the fixture model. With the gate closed, the live-gated tests
(AC-TOK-1, AC-TOK-5) MUST report as skipped, with the reason distinguishing "host unreachable" from
"model not pulled", and MUST NOT report as failed or passed. Every fixture-backed test in the same
suite MUST still execute and report a real verdict. Asserted by running the suite with `OLLAMA_URL`
pointed at a closed port: the run MUST exit zero with a non-zero skip count. The tokenizer suite
MUST run under `vitest.server.config.ts` (node environment), not the jsdom `vitest.config.ts`.

**AC-TOK-6** (fixture-backed) — Against the `qwen3:1.7b` vocab fixture, over strings drawn from a
generator producing **well-formed Unicode scalar values only** (no lone surrogates — e.g.
`fc.fullUnicodeString`) with mixed scripts, emoji, consecutive whitespace runs, empty strings, and
strings of length 1, `tokenize(baseUrl, "qwen3:1.7b", s).tokens.join("")` MUST equal `s`. The
assertion MUST be phrased as a property over the generator and MUST fail on any counterexample. The
property-testing library MUST be added as a dev dependency by this story.

## Content Reconciliation and Template Display (S4)

**AC-UX-5** — When `showTokens` is `true`, the request-preview panel MUST render the outgoing
message contents with `│` separators at token boundaries. The panel MUST additionally display the
model's chat template string verbatim as returned in the `template` field of `POST /api/show`. The
panel MUST NOT present a reconstructed or app-rendered template as the wire format.

**AC-UX-6** — After a completion whose final chunk reported `prompt_eval_count`, the panel MUST
display three figures: the computed content-token count, the reported `prompt_eval_count`, and
their difference labelled as chat-template overhead. The difference MUST NOT be presented as a
mismatch, error, or warning. For a turn whose steps include any `tool_call`, the panel MUST instead
report reconciliation as unavailable and name the reason, because that step's `usage` describes the
last of several requests.

**AC-TOK-5** (live-gated) — For a conversation of one system message and one user message with no
tool calls, the computed content-token count MUST be strictly less than the `prompt_eval_count`
Ollama reports for the chat request built from those same steps, and the difference MUST equal the
token count of that model's rendered template scaffolding. The computed figure MUST be derived from
`steps[0..i)` — the steps preceding the assistant step carrying the `usage` — filtered exactly as
`toOllamaMessages` filters them, never from the live `requestJsonPreview`, which includes the
assistant step itself.

## Cross-Cutting Invariants

**AC-UX-7** — Toggling `showTokens` on and then off MUST return the transcript region to an
`innerHTML` string byte-identical to its value before the first toggle, for both
`renderMarkdown: true` and `renderMarkdown: false`. Token view MUST NOT mutate `step.content`.

**AC-STRUCT-3** — The separator formatting, boundary-source resolution, whitespace-marker logic, and
debounced tokenize round trip MUST live in `src/lib/token-view.ts` and a `useTokenBoundaries` hook,
not inline in `src/components/chat-workspace.tsx`. The net line count added to
`chat-workspace.tsx` by this epic MUST NOT exceed 60, measured against the epic baseline SHA
recorded in `epic-state.json` as
`git diff --numstat <epic baseline SHA> -- src/components/chat-workspace.tsx | awk '{print $1-$2}'`
— insertions minus deletions, not the combined figure `--stat` reports.

## Manual Validation

None. Every AC in this file is discriminated by an automated check: rendering assertions run in
jsdom, and tokenizer conformance is adjudicated against the golden fixture or, for the two
live-gated ACs, the raw-count oracle — a computed comparison in every case, never a human
judgement.

On the live dependency: this epic is the **first** in this repo to require a reachable Ollama host
for any test. The existing integration suite deliberately does the opposite —
`tests/integration/ws-handler.test.ts:13-14` states that `streamOllamaResponse` is mocked "so these
tests exercise the handler logic without needing a running Ollama", and
`tests/integration/ollama-client.test.ts` makes no network calls. There is no CI config in this repo
to pin an environment against. The live surface is therefore confined to AC-TOK-1 and AC-TOK-5,
which compare against Ollama's own count and cannot be satisfied otherwise; AC-TOK-7's golden
fixture is what makes a hostless run prove segmentation correctness rather than merely
well-formedness. AC-ERR-3 asserts the skip behavior that keeps a hostless run honest rather than
falsely green. None of this is an automation gap, and none of it is a manual-validation claim.
