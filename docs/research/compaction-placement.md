# Compaction placement research

Where should the model-facing **context-usage note** and the **compaction summary** go in a
model's context? Researched on a live Ollama on 2026-10-02 for the compaction-tool epic (story
S3). The Decision at the end is mirrored as data in `shared/context-usage.ts`
(`CONTEXT_PLACEMENT`); `tests/unit/context-placement-decision.test.ts` keeps the two equal.

## Method

**Server.** Ollama **0.30.8** (`GET /api/version`), reached at `http://host.lima.internal:11434`.
Models (all small, loaded with `keep_alive: "30s"` and unloaded with `keep_alive: 0` afterwards):
`qwen3:1.7b` (family `qwen3`, the repo's default test model), `qwen2.5:3b-instruct` (`qwen2`),
`llama3.2:1b` (`llama`), `gemma3:4b` (`gemma3`) and `qwen3.5:2b` (`qwen35`). Probes used
`temperature: 0`, `think: false`, `options.num_ctx: 8192` and a few output tokens.

**Instruments.** The Ollama server's logs live on the host and were **not readable**, so
`OLLAMA_DEBUG=1` runner logs (the usual way to see rendered prompts and cache reuse) are
unavailable. Everything below comes from what the HTTP API exposes:

1. *Rendered prompt.* `POST /api/show` returns each model's Go chat `template`. For `qwen3`,
   `qwen2`, `llama` and `gemma3` the template was read and hand-rendered per candidate (note: Ollama
   first *collates* consecutive same-role messages joined by `"\n\n"`, and exposes **all** `system`
   messages joined as `.System`). The hand-rendering was then count-checked: the hand-rendered text
   sent through `POST /api/generate` with `raw: true` reported the same `prompt_eval_count` as
   `POST /api/chat` for the same messages in all 52 scenario/family checks (13 scenarios x 4
   families; the three tool-loop scenarios of `qwen3` first mismatched until tool-call rendering
   was added to the hand-renderer, then matched). Count equality only checks the hand-renderer's
   **token totals**; it does not pin where a paragraph sits. The positions follow from the template
   source and are corroborated by the cache ratio (a note in the tail leaves the prefix reusable,
   a note in the head does not). The three tool-loop scenarios were re-run for `qwen3`, `qwen2`
   and `llama` (9 of 9 equal) to support the "Tool-loop position" column. `qwen35` (and `gemma4`,
   `gpt-oss`) ship `template: "{{ .Prompt }}"`, i.e. a renderer compiled into Ollama, so
   they could only be observed through the other instruments, never hand-rendered.
2. *Template acceptance.* HTTP status / `error` of `/api/chat` and `prompt_eval_count` deltas
   against a no-note baseline (a merged or hoisted message costs fewer tokens than a separate turn).
3. *Prefix-cache reuse.* `prompt_eval_duration` over two consecutive calls: call A = history with
   note value 1, call B = the same history plus one more turn with note value 2 (the real per-
   invocation situation: the note is rebuilt every time and never accumulates). The reference
   `cold` is a call of the same size with unrelated filler (nothing to reuse). The ratio B/cold is
   about 1 when nothing was reused and about 0.05 when the prefix was reused. Prompts were about 2,500
   to 3,350 tokens; 3 trials per cell, medians. **`prompt_eval_count` is not a cache instrument**:
   it reports the *full* prompt even when almost all of it was served from the cache
   (e.g. `qwen3:1.7b` trailing-user: `prompt_eval_count` 3,353 with `prompt_eval_duration` 60 ms,
   against 1,216 ms cold).
4. *Behavioural probes* (supporting evidence only): ask the model to quote a figure from the note or
   the summary. Small models are noisy here, so these never decide a placement.

Tool-capable families were probed in the tool-loop shape
`[system, user, assistant tool_call, tool result, <note>]`; `gemma3:4b` has no `tools` capability
so it used `[system, user, assistant, user, <note>]`.

**Not probed: OpenAI-compatible providers.** Only Ollama was exercised. Strict OpenAI-compatible
servers (e.g. HF chat templates that raise "roles must alternate") may reject two adjacent
same-role messages; the Decision therefore defines the placements so that no two same-role
messages are ever adjacent on the wire, which is also what Ollama renders (see Decision).

**Overflow probe (research only).** The app never sets `num_ctx`; probes forced `num_ctx` to 2048
and 4096 (reloading the model) and compared the `prompt_eval_count` with the true length measured
at `num_ctx: 16384`.

**Reproduction.** Raw probe scripts and JSON output are kept outside the repo (scratchpad);
the core of the cache probe is:

```js
const a = await chat(model, build(P, filler, 1));            // history + note(2,100)
const b = await chat(model, build(P, filler, 2));            // + one turn, note(2,160)
const cold = await chat(model, build(P, otherFiller, 2));    // same size, nothing shared
// compare b.prompt_eval_duration / cold.prompt_eval_duration; ignore prompt_eval_count
```

## Candidates

Usage note (rebuilt on every invocation, injected into a per-invocation copy of the steps):

| Id | Candidate |
|----|-----------|
| `trailing-system` | A trailing `system`-role message after the last step |
| `first-system-append` | Appended to the content of the first `system` message |
| `trailing-user` | A trailing `user`-role message after the last step |

Compaction summary (seeds the fork):

| Id | Candidate |
|----|-----------|
| `system` | A `system`-role message after the system steps |
| `user` | A `user`-role message after the system steps |
| `bare-fork` | The bare fork shape: system steps + summary with **no prior `user` turn** (the fork's first request, before the user types anything), evaluated with the summary in the `system` and in the `user` role |

## Findings

### Note placement, per family

`n` is `prompt_eval_count` for the chat shape `[system, user, assistant, user, <note>]` (no-note
baseline in the header). **Cache is B/cold, measured in the tool-loop shape**
`[system, user, assistant tool_call, tool result, <note>]` for the tool-capable families (`qwen3`,
`qwen2`, `llama`, `qwen35`) and in the chat shape for `gemma3` (no `tools` capability, so its
"tool-loop" shape is the chat shape); about 1 = no reuse, about 0.05 = reused. Recall is the share
of behavioural probes that quoted the note's figure (chat shape / tool-loop shape; noisy,
supporting only). "Tool-loop position" is where the note renders in the tool-loop shape
(hand-renderings, count-verified; see Method).

| Family | Candidate | Chat-shape position (from template; count-checked) | Tool-loop position | n | Cache B/cold | Recall |
|--------|-----------|---------------------------------------------|--------------------|---|--------------|--------|
| qwen3 (base 60) | `trailing-system` | hoisted into the leading system block (same text and count as `first-system-append`) | hoisted | 90 | 0.95 | 4/4, 0/6 |
| qwen3 | `first-system-append` | leading system block | leading system block | 90 | 0.98 | 4/4, 0/6 |
| qwen3 | `trailing-user` | merged into the last user turn | its own user turn, after the tool result (itself a `<tool_response>` user turn) | 90 | 0.05 | 4/4, 6/6 |
| qwen2 (base 52) | `trailing-system` | hoisted into the leading system block | hoisted | 82 | 0.87 | 4/4, 0/6 |
| qwen2 | `first-system-append` | leading system block | leading system block | 82 | 0.95 | 4/4, 0/6 |
| qwen2 | `trailing-user` | merged into the last user turn | its own user turn after the `<tool_response>` user turn (same as qwen3, shown by the rendered tail and raw count 97) | 82 | 0.03 | 3/4, 0/6 |
| llama (base 64) | `trailing-system` | hoisted into the leading system block **and no assistant header is generated** (a last `system` message gets none), the model starts its reply with the literal word `assistant` | hoisted, same missing header | 85 | 1.02 | 4/4, 1/6 |
| llama | `first-system-append` | leading system block | leading system block | 89 | 1.00 | 4/4, 1/6 |
| llama | `trailing-user` | merged into the last user turn | its own `user` turn after the tool result, which renders in the `ipython` role | 89 | 0.05 | 1/4, 0/6 |
| gemma3 (base 56) | `trailing-system` | **positional**: rendered as its own `user` turn at the end (gemma3 has no system role) | no tool loop (shape = chat shape) | 93 | 0.04 | 4/4, 0/6 |
| gemma3 | `first-system-append` | content of the first (user-rendered) turn | no tool loop (shape = chat shape) | 88 | 1.00 | 3/4, 2/6 |
| gemma3 | `trailing-user` | merged into the last user turn | no tool loop (shape = chat shape) | 88 | 0.05 | 4/4, 0/6 |
| qwen35 (base 56) | `trailing-system` | not inspectable (compiled renderer); counts show a separate block | not inspectable | 91 | 0.32 | 1/4, 0/6 |
| qwen35 | `first-system-append` | not inspectable; counts show it inside the first block | not inspectable | 87 | 1.01 | 4/4, 1/6 |
| qwen35 | `trailing-user` | not inspectable | not inspectable | 91 | 0.32 | 2/4, 0/6 |

Notes on the table:

- No candidate was rejected by any template for any family (HTTP 200 everywhere); the
  differences are in *where the text lands* and *what the cache keeps*.
- `qwen3`, `qwen2` and `llama` templates read `.System`, which contains **every** `system` message,
  so a trailing `system` message is silently moved into the first system block: it is not a
  trailing message at all, it changes the start of the prompt every time the note changes, and the
  cache is lost (B/cold 0.87 to 1.02). `llama` additionally drops the generation header.
- Only `trailing-user` kept the prefix cache in **every** family; `qwen35` (hybrid recurrent
  model) reuses only part of the prefix whenever the tail changes (0.32), still three times better
  than `first-system-append`, which recomputes everything (1.01) in every family including gemma3.
- The recall probes are mixed and small-model noisy: `trailing-user` is best on `qwen3:1.7b`
  (6/6 against 0/6 in the tool-loop shape) but weakest on `llama3.2:1b` (1/4, chat shape) and
  `qwen3.5:2b`; `qwen2.5:3b` answered with the percentage or the tool result under every
  placement. No placement works across the board, so they never decide anything here.
- In the chat shape (last step is the user's message) the four inspectable templates merge
  `trailing-user` into that user turn (Ollama's collate rule), so on a request's first invocation
  the note is the last paragraph of the user's message; after a tool result it is its own `user`
  turn directly after the tool result's turn. Ollama renders the tool result as a user-like turn
  (`qwen3`/`qwen2`: `<tool_response>` in the `user` role) or in the `ipython` role (`llama`), and
  collates only *identical* roles, so on Ollama the two are not merged.

### Summary placement, per family

`n` is `prompt_eval_count`. "with turn" is `[system, <summary>, user "Continue..."]`;
"bare" is the fork shape `[system, <summary>]`.

| Family | Candidate | Rendered position | n with turn / bare | Behaviour |
|--------|-----------|-------------------|--------------------|-----------|
| qwen3 | `system` | hoisted into the leading system block | 55 / 42 | uses Lisbon and May 3 in both shapes |
| qwen3 | `user` | its own user turn (merged with a following user turn) | 55 / 51 | same |
| qwen2 | `system` | hoisted | 47 / 38 | same |
| qwen2 | `user` | user turn | 47 / 43 | same |
| llama | `system` | hoisted; in the bare shape the last message is `system`, so **no assistant header**: reply starts with the stray word `assistant` (also with no system prompt) | 59 / 46 | uses the summary but with the stray `assistant` prefix |
| llama | `user` | user turn, header present | 59 / 55 | clean |
| gemma3 | `system` | rendered as a `user` turn (no system role) | 50 / 40 | same |
| gemma3 | `user` | user turn | 50 / 45 | same |
| qwen35 | `system` | not inspectable | 56 / 47 | same |
| qwen35 | `user` | not inspectable | 56 / 47 | same |

Notes: the summary is static at the start of the fork, so prefix-cache behaviour is identical for
both roles (it is part of the stable prefix either way). Every family accepted the bare shape in
both roles, also without any system prompt (`[summary]` alone). `gemma4` and `gpt-oss` were not
loaded (too large for the host); their templates are compiled renderers or too elaborate to
verify here, so their behaviour is **untested**; a `user`-role message is the one role every chat
format accepts, which is the reason `user` is the default for the summary.

### Overflow: `prompt_eval_count` for a prompt longer than the loaded window

Research setting only: `options.num_ctx` forced small. True length is the `prompt_eval_count`
of the same prompt at `num_ctx: 16384`.

| Family | `num_ctx` | True prompt tokens | Reported `prompt_eval_count` | Reply to a question about the system prompt |
|--------|-----------|--------------------|------------------------------|---------------------------------------------|
| qwen3 | 2048 | 2,369 / 4,664 / 7,461 | **2047 / 2047 / 2047** | wrong (the system prompt was discarded) |
| qwen3 | 4096 | 4,727 / 9,358 / 14,933 | **4095 / 4095 / 4095** | wrong |
| qwen35 | 2048 | 2,344 / 4,672 / 7,421 | **2047 / 2047 / 2047** | wrong |
| qwen35 | 4096 | 4,712 / 9,312 / 14,891 | **4095 / 4095 / 4095** | wrong |
| llama | 2048 | 852 / 1,665 (fit) / 3,299 / 6,552 | 852 / 1,665 (exact) / **2047 / 2047** | not asked |
| gemma3 | 2048 | 942 / 1,861 (fit) / 3,670 / 7,387 | 942 / 1,861 (exact) / **2047 / 2047** | not asked |

So when the prompt exceeds the loaded window Ollama (0.30.8) **truncates silently and reports the
truncated length, which is the window minus one**, never the true length. Prompts that fit are
reported exactly, so `prompt_eval_count` equals `num_ctx - 1` if and only if the prompt did not fit (a prompt
of exactly `window - 1` tokens is indistinguishable).

## Decision

Evidence ranking: the rendering and cache measurements are hard evidence; the behavioural probes
are supporting only and do not discriminate. Per-placement reasoning:

- **Note: `trailing-user`.** It is the only candidate that preserves the prefix cache in every
  tested family; `trailing-system` is silently hoisted into the first system block on the
  families whose template reads `.System` (cache lost on every invocation, plus a missing
  generation header on `llama`), and `first-system-append` changes the head of the prompt every
  time. No family rejected it, so there is no exception. It is defined with collate semantics
  (below): appended to the last message when that message is user-role, otherwise a separate
  user message.
- **Summary: `user`.** Equal cache behaviour, and the only role that avoids the `llama`
  missing-generation-header defect in the bare fork shape and that every chat format accepts
  before any other turn. No family needed an exception.

**Placements are defined with collate semantics.** This is what makes the default safe where it was
not probed:

- `trailing-user`: append the note as a final paragraph (joined by a blank line) to the content of
  the last message when that message is user-role; otherwise (after an assistant or tool message)
  add a separate `user` message. This is exactly what Ollama renders (its collate rule), so the
  cache findings hold, and the note never creates two adjacent user messages by itself.
- `user` summary: a `user`-role message. When the next message is also a user message (the
  user's first turn in the fork), S6 must collate it onto the summary (or the summary onto it) so no
  two user messages are adjacent on the wire.
- **OpenAI-compatible providers were not probed.** The default applies to them on the strength of
  the collate definition alone: a strict server that requires alternating roles never sees
  `[..., user, user]` from the note or the summary. After a tool result the note is a separate
  `user` message (tool then user); a provider that rejects even that is unverified and would get
  an exception row.

The default is used by every family without an exception, including OpenAI-compatible models.
No family has an exception; an exception row would name the family string and either
placement, with `-` for "use the default".

| Family | Note placement | Summary placement |
|--------|----------------|-------------------|
| `default` | `trailing-user` | `user` |

Meaning of the meter's `error` band: the meter's fill is the last invocation's
`inputTokens + outputTokens`. Because Ollama reports `prompt_eval_count` capped at the window minus
one when the prompt does not fit, the reported fill is `window - 1 + outputTokens`, which is at least
the window as soon as the model produced one token. The `error` band (>= 100 %) therefore
**means "the prompt overflowed the loaded window and Ollama has already silently discarded the
oldest tokens"** (or filled it exactly), not "a number above the window was reported": it can only
exceed the window by the output tokens, and the true overflow size is not observable. This holds
only when the window behind the percentage is the **runtime (live)** loaded window; against a
configured or default window that differs from the loaded one, the band says nothing about
truncation. A cheap overflow signal, a future backlog idea and **not implemented**, is
`prompt_eval_count === window - 1` on the last invocation. `warn` (80 to
below 100 %) is the real early-warning zone, and it is the zone the usage note should act on.

Caveats carried to S4 and MV-1: the note's wording must survive being the last paragraph of the
user's message on a request's first invocation (small models answered the merged message
poorly in the chat-shape probe), and `gemma4`/`gpt-oss` were not exercised. Tool-loop recall of the
note under the default (`trailing-user`) is near zero outside `qwen3`: 0/6 on `qwen2`, `llama`,
`gemma3` and `qwen35`, against 6/6 on `qwen3`. S5 and MV must not assume that small models call
`compact_context` from the note alone.
