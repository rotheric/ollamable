# Bug Report: Stale usage after tool-only responses and unconditional include_usage

Source: Codex adversarial review of commit 3162836 (epic `specs/epic-compaction-tool/`), verified
by the lead on 2026-10-03.

## Defect 1 — stale token count after a tool-only response without usage

**Description.** `lastUsedTokens` (`shared/context-usage.ts`) scans steps backward and stops with
`undefined` only at an `assistant` step without numeric usage. When an OpenAI-compatible provider
omits token usage, `server/openai-client.ts` still attaches `usage: { stopReason }` (no token
counts) via `retainResponseUsage` to the response's first step. For a tool-only response that
step is a `tool_call` (`normalizeResponseSteps` keeps usage on the first `tool_call` when there is
no prose). `lastUsedTokens` skips it and returns an older invocation's tokens.

**Expected.** Fill and the note's used tokens come from the latest response only (spec Design
Decisions 5 and 7; AC-CTX-8, AC-NOTE-2, AC-NOTE-5). A step carrying a `usage` object without
numeric `inputTokens`/`outputTokens` marks a response that reported no usage → `undefined`
(meter `—`, number-free note).

**Actual.** The context meter (`computeContextFill`) and the next model-facing usage note (server
tool-loop first invocation, request preview, token view) show the earlier response's count as
current.

**Reproduction.** `lastUsedTokens([user, assistant{1000/50}, user, tool_call{usage:{stopReason:"tool_calls"}}, tool_result])`
returns `1050`; expected `undefined`.

**Impact.** Medium: misleading meter and model-facing note for OpenAI-compatible providers that
omit usage, on exactly the tool-loop path this feature targets. The docstring currently labels
the case an "accepted residual"; only responses that carry no usage object at all should remain
residual.

## Defect 2 — `stream_options.include_usage` sent unconditionally

**Description.** `server/openai-client.ts` adds `stream_options: { include_usage: true }` to every
streamed OpenAI-compatible request, even when the meter and compaction are off.

**Expected.** A provider that rejects the field still works: on an HTTP 4xx whose error body
mentions `stream_options` or `include_usage`, retry once without `stream_options` and remember
(per provider base URL, in-process) not to send it again; usage then stays unknown.

**Actual.** Such a provider fails every chat request with no fallback.

**Reproduction.** A stub OpenAI-compatible endpoint that answers 400
`{"error":{"message":"Unrecognized request argument supplied: stream_options"}}` when the body
contains `stream_options` → `chat.error` for every request.

**Impact.** Medium: total chat outage for strict OpenAI-compatible providers.
