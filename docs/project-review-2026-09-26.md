# Project review and implementation issue register

Reviewed: **2026-09-26**  
Repository HEAD: `e3f2c51d16552b68e9186397dbedb2512e6b3aa1`  
Scope: current working tree, including the Next.js static frontend, Node/WebSocket backend, provider adapters, tools/MCP, persistence, tests, scripts, and selected project records.

This document records findings and implementation context, not an implementation plan. No application fixes were made during the review. R01–R12 correspond to the original review response; subsequent entries preserve additional findings and lower-priority observations. R13 separates the synthetic-assistant concern originally included in R07.

## How to continue

- The checklist below is the authoritative completion marker for this document. All findings start open.
- When claiming an item, add `Owner:` and `State: IN_PROGRESS` to its detail section. Use `BLOCKED` with a concrete reason when necessary.
- Check an item only after the fix and relevant verification are complete. Append a short resolution note with the changed files, test evidence, and commit if available.
- If investigation disproves an inspection finding, record `State: NOT_APPLICABLE` and the evidence instead of silently deleting it. Cross-reference duplicate fixes.
- **Reproduced** means a targeted runtime/browser probe demonstrated the behavior. **Inspection** means the code path was inspected but the scenario was not independently exercised. **Coverage gap** and **maintenance** are not claims of a reproduced runtime failure.
- P1: security/execution-control defect requiring prompt attention. P2: functional or reliability defect. P3: lower-priority UX, portability, documentation, or maintenance issue. Priorities are review judgments, not delivery ordering.
- File links are repository-relative. Line numbers are review-time hints and will drift; use the named function or code expression to locate the current implementation.

Repository constraints from [AGENTS.md](../AGENTS.md): package-manager guidance says `uv`; the frontend is a Next.js static site; transcript chat messages must contain authentic agent-authored assistant content rather than synthetic assistant placeholders or derived tool messages. Existing JavaScript scripts use npm; that inconsistency is recorded in R36 rather than silently resolved here.

## Issue checklist

- [x] **R01 — P1:** Static-file path traversal.
- [ ] **R02 — P1:** Unauthenticated backend and unrestricted WebSocket origins.
- [ ] **R03 — P1:** Disabled tools remain executable.
- [ ] **R04 — P1:** Stop does not stop subsequent tools.
- [ ] **R05 — P2:** Disconnect/reconnect leaves chat generation pending.
- [ ] **R06 — P2:** Initial model loading overwrites saved selections.
- [ ] **R07 — P2:** Assistant text disappears when the step also contains tool calls.
- [ ] **R08 — P2:** Split reasoning tags corrupt assistant/reasoning separation.
- [ ] **R09 — P2:** Curl byte limit does not bound downloads or allocations.
- [ ] **R10 — P2:** MCP initialization/disconnection leaks clients or subprocesses.
- [ ] **R11 — P2:** Tool loop has no execution budget.
- [ ] **R12 — P2:** Production start script is incompatible with static export.
- [ ] **R13 — P2:** Tool-only replies become synthetic assistant transcript steps.
- [ ] **R14 — P2:** Failed chat sends leave unresolved promises.
- [ ] **R15 — P2:** Overlapping generations share ownership and message correlation.
- [ ] **R16 — P2:** Malformed chat messages receive no correlated failure.
- [ ] **R17 — P2:** Invalid explicit provider IDs silently fall back to another provider.
- [ ] **R18 — P2:** Tokenization caches omit provider identity.
- [ ] **R19 — P2:** Discovery and tool network requests lack application deadlines.
- [ ] **R20 — P2:** Invalid final tool arguments become an executable empty object.
- [ ] **R21 — P3:** Tool-only/reasoning-only responses lose usage metadata.
- [ ] **R22 — P2:** MCP tool names collide across servers and built-ins.
- [ ] **R23 — P2:** Documented development startup and `dev:full` are miswired.
- [ ] **R24 — P2:** Handwritten environment loading preserves quoting syntax.
- [ ] **R25 — P3:** Standalone frontend typechecking fails on test globals.
- [ ] **R26 — P3:** Broadly named test commands omit integration checks; E2E mocks the backend.
- [ ] **R27 — P2:** Finishing the tour deletes modified example conversations.
- [ ] **R28 — P3:** Tour completion does not restore the original sidebar state.
- [ ] **R29 — P3:** Guided-tour lifecycle has no browser coverage.
- [ ] **R30 — P2:** Tour initialization guard conflicts with effect cleanup/replay.
- [ ] **R31 — P3:** Backlog findings and guided-tour status records are inconsistent or stale.
- [ ] **R32 — P3:** Workspace component concentrates too many responsibilities.
- [ ] **R33 — P3:** Default MCP configuration hardcodes a machine-specific browser path.
- [ ] **R34 — P3:** Persistence failures are inconsistently handled and not surfaced to users.
- [ ] **R35 — P3:** README promises exact Ollama JSON, but the main preview is OpenAI format.
- [ ] **R36 — P3:** Package-manager instructions disagree with the executable workflow.

## Verification already performed

| Check | Result | Limits/context |
| --- | --- | --- |
| Unit suite | 204 passed, 11 files | `node node_modules/vitest/vitest.mjs run` |
| Integration suite | 158 passed, 2 skipped, 11 files | `node node_modules/vitest/vitest.mjs run -c vitest.server.config.ts`; both live-Ollama checks skipped with `host_unreachable` |
| Production build | Passed | `node node_modules/next/dist/bin/next build`; installed Next.js reported 15.5.14; static export generated |
| Backend typecheck | Passed | `node node_modules/typescript/bin/tsc -p tsconfig.server.json --noEmit --incremental false` |
| Standalone frontend typecheck | Failed, 183 diagnostic lines | `node node_modules/typescript/bin/tsc --noEmit --incremental false`; examples are missing `vi`, `describe`, `it`, `expect`; production build nevertheless passed |
| Browser suite | 38 passed | Temporary configuration used the available Chromium binary and the built site; no tracked Playwright configuration was changed |
| Production `next start` | Failed as expected for R12 | Explicit error: `"next start" does not work with "output: export" configuration` |
| Targeted probes | Confirmed R01–R08 behavior described below, plus R13 protocol synthesis | Model/tool calls in targeted execution probes were mocked; no live provider generation or destructive tool actions were needed |

The initial browser run could not launch because Playwright expected `chromium_headless_shell-1208`. An installation attempt failed with EACCES under `/opt/playwright-browsers`. The suite passed using the already-installed executable at `/opt/playwright-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux-arm64/chrome-headless-shell` via temporary `use.launchOptions.executablePath`. This is environment-specific evidence, not a path to hardcode into the repository.

The review server used port 43199 with `MCP_CONFIG` pointing at a nonexistent temporary configuration, so probes did not launch configured MCP servers. It was shut down after verification. Build/test artifacts may have been refreshed; no application source was edited. Before review, the working tree already had modified `public/data/cats.html` and `tsconfig.tsbuildinfo`, and untracked `.claude/`, `BACKLOG.md`, and `CLAUDE.md`. Do not discard those as review cleanup.

No live-provider compatibility certification, mutation campaign, or dependency vulnerability audit was performed. Passing mocked suites is not evidence that the issues below are absent.

## Security and execution control

### R01 — Static-file path traversal

Owner: Codex
State: COMPLETE

Resolution: `server/static-files.ts` now resolves decoded URLs against the real export root and rejects traversal, invalid encodings, and escaping symlinks; `server/index.ts` uses it. Added configurable `STATIC_DIR` and actual ephemeral-port logging for isolated real-server verification. `tests/integration/http-server.test.ts`: 15 passed; backend TypeScript check passed. Restoring the vulnerable resolver caused five failures, including four outside-root disclosures. Existing unrelated worktree changes preserved.

**Priority:** P1. **Evidence:** Reproduced.  
**Location:** [server/index.ts](../server/index.ts), static candidates around lines 128–140.

The request path is joined directly to `STATIC_DIR`; normalized candidates are never checked for containment. Once `out/` exists, a raw HTTP request for `/../package.json` returns the repository's package file with status 200. The same probe returned 404 before the build because the entire static branch is gated on `existsSync(STATIC_DIR)`.

This exposes files readable by the backend process outside the export directory, potentially including credentials. The probe read only `package.json`, not secrets. A reproducer must preserve dot segments: use Node's `http.request` with a literal `path`, or curl's `--path-as-is`; URL-normalizing clients can conceal the bug.

**Implementation context:** Validate the resolved candidate against the static root before any read. Account for directory boundaries, encoded paths, and symlinks if allowed; a bare string-prefix comparison is insufficient. Retain normal asset, `.html`, and directory-index serving. Verification should include traversal rejection and ordinary exported-page loading.

### R02 — Unauthenticated backend and unrestricted WebSocket origins

**Priority:** P1. **Evidence:** Reproduced handshake; exposure confirmed by inspection.  
**Location:** [server/index.ts](../server/index.ts), CORS headers, `new WebSocketServer({ server: httpServer })`, and `httpServer.listen(PORT)` around lines 155–167.

A WebSocket connection declaring `Origin: https://untrusted.example` was accepted and received `pong`. No authentication or origin validation protects chat requests. The listener was confirmed as `*:43199`, despite the console advertising localhost. HTTP responses also allow `Access-Control-Allow-Origin: *`.

Any client able to reach the listener can submit provider requests and cause tools to run with server privileges/configuration. Actual cross-site browser reachability also depends on browser local-network/mixed-content restrictions; the server itself supplies no boundary.

**Implementation context:** Default loopback binding, an explicit origin policy, and authentication for remote access address different parts of this exposure. Preserve intentionally supported remote development through explicit configuration. CORS headers do not enforce WebSocket origin checks. MCP initialization happens on connection, before any chat request.

### R03 — Disabled tools remain executable

**Priority:** P1. **Evidence:** Reproduced with a mock router and mock fetch.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), `executableToolCalls` around line 267; [server/tool-executor.ts](../server/tool-executor.ts).

The execution filter checks only `dispatcher.canHandle(name)`. It does not intersect calls with the request's enabled `tools`. A request with `tools: []` still executed a model-returned `curl` call to a harmless mock URL. Previously enabled tools can also remain visible to a model through history after the user disables them.

**Implementation context:** Enforce the request's enabled tools at execution time, not only when constructing the provider prompt. Decide how a rejected/unknown call becomes a protocol result or explicit error; silently leaving outstanding calls can invalidate the next provider request. Keep this authorization fix distinct from argument validation (R20) and name collisions (R22).

### R04 — Stop does not stop subsequent tools

**Priority:** P1. **Evidence:** Reproduced.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), tool loop around lines 298–327; [server/tool-executor.ts](../server/tool-executor.ts), executor interface.

Cancellation is checked at the top of the outer model loop, not between individual tool calls. Executors receive no request abort signal. In the probe, the first mock curl waited on a promise; `chat.stop` was sent; releasing the first call still caused the second curl to execute. A browser disconnect has the same missing propagation issue.

**Implementation context:** Pass cancellation through the dispatcher/executor boundary and check it before each subsequent action and after awaits. Curl currently owns a separate 20-second timeout controller; combine timeout and caller cancellation. Already completed external actions cannot be undone. Reuse delayed-tool probes to verify that no new action starts after cancellation. See R15 for generation ownership during immediate resume.

### R09 — Curl byte limit does not bound downloads or allocations

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/tools/curl.ts](../server/tools/curl.ts), `response.arrayBuffer()` around line 117.

`max_bytes` is applied after the entire body has been read into an ArrayBuffer. The advertised 2 MiB hard cap bounds returned content, not memory or downloaded bytes. A fast, large response can allocate far more before the 20-second timer fires; even binary responses are fully loaded before being replaced with a short description.

**Implementation context:** Consume the body incrementally and cancel it when the limit is reached. Define whether the reported byte count is observed bytes or a known total: after early cancellation the current exact `totalBytes` claim is no longer generally possible. Exercise a response substantially larger than the requested limit without downloading an enormous real file.

### R11 — Tool loop has no execution budget

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), `while (true)` around line 215.

`loopIteration` is logged but never used as a limit. A model that repeatedly requests an executable tool, including one returning the same configuration error, can continue indefinitely. `maxOutputTokens` limits a model response, not the number of responses or actions in a user turn.

**Implementation context:** A terminal budget outcome should resolve the frontend request and preserve already completed steps. The appropriate bounds can include iterations, tool calls, or elapsed time. Verify with a router that always returns a tool call, and make cancellation still work while the budget is being consumed.

## Chat transport, model selection, and transcript integrity

### R05 — Disconnect/reconnect leaves chat generation pending

**Priority:** P2. **Evidence:** Browser reproduction.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), WebSocket wiring around line 779; [backend-client.ts](../src/lib/backend-client.ts), pending streams and `cancelPendingTokenize`; [ws-handler.ts](../server/ws-handler.ts), socket-close handler.

The close callback cancels only tokenization. The server aborts chat work on that connection, but the frontend retains its chat promise. A browser probe received a partial delta, closed the socket, and waited for reconnect: two connections had occurred, but the Stop button was still displayed and generation remained pending.

**Implementation context:** Interrupted chats need a terminal connection-error outcome; reconnect alone cannot resume them because there is no server replay/resumption protocol. Existing comments and a unit test deliberately assert the tokenize-only cancellation path to avoid mislabeling a drop as `Generation stopped.` Update that contract with a distinct error rather than blindly calling `cancelAll()` and conflating user cancellation with connection failure. Decide how genuine partial content is retained and whether retry is manual.

### R06 — Initial model loading overwrites saved selections

**Priority:** P2. **Evidence:** Browser reproduction.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), initial `models` state around line 365, `availableModels`, and selection-repair effect around lines 1003–1038.

The repair effect runs against `fallbackModels` before `/models` finishes. A saved conversation using `saved-model` was changed to `qwen3:latest` while the model response was delayed 700 ms. The eventual response included both names, yet localStorage retained the fallback choice.

**Implementation context:** Distinguish loading, successful discovery, and failed discovery before mutating persisted selections. A temporarily unreachable provider does not prove the saved model is invalid. Test a non-fallback saved model and a delayed response; also preserve provider identity when names overlap.

### R07 — Assistant text disappears when the step also contains tool calls

**Priority:** P2. **Evidence:** Browser reproduction.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), `hasToolCalls` branch around line 2233.

The tool-call branch replaces the content-rendering branch. A seeded assistant step containing `Authentic assistant explanation` and one tool call displayed the tool name but no explanation. The text remains in state and provider history, so the visible transcript no longer matches the actual conversation. Streaming text can appear and then vanish when stable steps gain `toolCalls`.

**Implementation context:** Render authentic assistant content independently from call metadata, retaining Markdown/token-view behavior. Verify a response with both nonempty content and calls, not just tool-only or text-only fixtures. R13 covers synthetic assistant records and is related but independently observable.

### R08 — Split reasoning tags corrupt assistant/reasoning separation

**Priority:** P2. **Evidence:** Reproduced with a mocked SSE response.  
**Location:** [server/openai-client.ts](../server/openai-client.ts), `routeContent` around lines 240–267.

The parser searches each content fragment independently for complete `<think>` and `</think>` strings. Fragments `<thi`, `nk>private reasoning</thi`, and `nk>final answer` yielded one assistant step containing `<think>private reasoning</think>final answer`. A split closing tag after a recognized opening tag can instead keep the final answer inside reasoning.

**Implementation context:** Track partial delimiters across content fragments, not just transport lines. Cover every delimiter split point, multiple tags in one fragment, ordinary text containing `<`, and EOF with a partial prefix. No live provider call is required to reproduce this.

### R13 — Tool-only replies become synthetic assistant transcript steps

**Priority:** P2. **Evidence:** Reproduced protocol output; rendering path inspected.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), assistant creation around lines 250–264; [chat-workspace.tsx](../src/components/chat-workspace.tsx), `isVisibleTranscriptStep` and `hasToolCalls` rendering.

When the model returns calls without assistant prose, the handler constructs a new empty `kind: "assistant"` record and sends/persists it with embedded `toolCalls`. The frontend treats it as a transcript step, although its header is relabeled `tool call requests`; it is not an ordinary text bubble labeled Assistant. This distinction matters when reproducing the issue.

The record also participates in logic that counts or locates assistant messages. It conflicts with the repository instruction against synthetic assistant placeholders/derived tool messages as chat messages.

**Implementation context:** Provider wire protocols may legitimately require an assistant-role envelope for tool calls. Preserve that envelope in protocol conversion without inventing agent-authored chat content. Shared formatters already handle standalone `tool_call` records; inspect both formats and migration of persisted merged records before changing representation. Keep tool inspection available separately from authentic chat content.

### R14 — Failed chat sends leave unresolved promises

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [backend-client.ts](../src/lib/backend-client.ts), `startStream` around lines 171–191; [use-websocket.ts](../src/lib/use-websocket.ts), `send`.

`startStream` registers a pending promise and ignores the boolean result of `send`. A close between the UI's `wsConnected` check and the actual send leaves a promise for a request that never reached the server. A throwing send also bypasses normal stream cleanup; `startStream` is called before the workspace's `try/await promise` block.

**Implementation context:** The adjacent `tokenize` implementation already cleans up false returns and thrown sends. Apply equivalent chat lifecycle handling with chat-appropriate errors, without introducing an arbitrary short timeout for valid long generations. Verify false and throwing send callbacks independently of R05's midstream disconnect.

### R15 — Overlapping generations share ownership and message correlation

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), `abortControllers.set` around line 204 and unconditional `delete` around line 366; [backend-client.ts](../src/lib/backend-client.ts), pending map keyed by conversation ID.

Two requests for the same conversation overwrite each other's controller and pending-stream entries. An older request's `finally` can delete a newer request's controller. Responses carry only `conversationId`, so late events from an old generation can be applied to its replacement. Stop followed by immediate resume while a tool is still finishing is a realistic trigger, even though the normal UI disables simultaneous sends.

**Implementation context:** Enforce single-generation ownership or introduce per-generation correlation end to end. At minimum, cleanup must verify that it owns the map entry. Test out-of-order completion and cancellation of two requests for the same conversation; existing different-conversation concurrency coverage does not exercise this.

### R16 — Malformed chat messages receive no correlated failure

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/ws-handler.ts](../server/ws-handler.ts), `handleMessage` around lines 93–122 and `handleChatSend` before its `try`.

Parsed JSON is cast to `ClientMessage` without runtime validation. Accesses such as `msg.type`, `(msg.tools ?? []).map`, `msg.steps.length`, and spreading `msg.steps` can throw before the chat error handler. The outer WebSocket listener logs the rejection, so this is **not** the previously fixed unhandled-rejection process crash; the defect is that the requester gets no terminal response. Tokenize has stronger validation than chat.

**Implementation context:** Validate the discriminated message shape and required field types before logging or allocating controllers. Reply with a correlated error when an identifiable chat request is invalid. Define behavior for malformed JSON and uncorrelatable messages. HTTP `/models/show` also collects an unbounded request body and needs an explicit input-size boundary if exposed beyond trusted clients.

### R17 — Invalid explicit provider IDs silently fall back

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/llm-router.ts](../server/llm-router.ts), `resolveProvider` around lines 175–185.

An explicit but unknown provider ID falls through to the model-name map or first provider. That is different from the documented backward-compatible case where the caller omits a provider. A stale/mistyped selection can route chat, metadata, or tokenization to another configured provider; this can affect privacy, cost, and vocabulary identity.

**Implementation context:** Preserve legacy fallback only for an omitted provider if still required. Explicit unknown IDs should fail clearly. Test duplicate model names across provider configs and a removed provider; frontend model repair in R06 should not mask routing errors.

### R18 — Tokenization caches omit provider identity

**Priority:** P2. **Evidence:** Inspection; conditional on providers sharing a model name.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), `TokenViewStepContent` around line 2271; [request-preview-extras.tsx](../src/components/request-preview-extras.tsx), cache suffixes around lines 103–110; [token-view.ts](../src/lib/token-view.ts), `useTokenBoundaries` and `useTokenizedMessages`.

Requests correctly pass the selected provider, but cache suffixes contain only the model name. The hooks intentionally ignore callback identity changes. Switching provider while keeping the same model name/text can therefore retain boundaries computed by the previous provider. The preview panel is currently gated to the built-in `ollama` provider, which narrows that panel's present exposure; the transcript callback is still provider-dependent.

**Implementation context:** Use a stable composite provider/model identity for cache invalidation. Test identical text/model names with different provider identities, including a switch from supported to unsupported tokenization. Keep the existing debounce and stale-result protections.

### R19 — Discovery and tool requests lack application deadlines

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/llm-router.ts](../server/llm-router.ts), `listAllModels` and model fetches; [server/ollama-client.ts](../server/ollama-client.ts), `fetchOllamaModelMeta`; [server/tokenizer.ts](../server/tokenizer.ts), `fetchVocab`; [server/tools/web-search.ts](../server/tools/web-search.ts), Brave fetch.

These requests have no explicit application timeout/caller cancellation. Model discovery waits for all provider tasks and all Ollama `/show` calls, so one stalled endpoint delays otherwise available models. Web search can hold the tool loop pending. Tokenize's frontend 10-second timeout does not cancel the server's vocabulary fetch; pending vocabulary promises are deliberately protected from eviction.

**Implementation context:** Transport/runtime defaults are not a deliberate application deadline. Define finite discovery/tool behavior and preserve successful providers when another fails. Shared vocabulary fetches require ownership care: cancellation of one waiting request should not necessarily abort work still needed by others. This is separate from R04's missing tool cancellation propagation.

### R20 — Invalid final tool arguments become an executable empty object

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/openai-client.ts](../server/openai-client.ts), `materialiseToolSteps` around lines 330–349; [server/ws-handler.ts](../server/ws-handler.ts), dispatch.

Argument JSON parse failures are mapped to `{}` during streaming, which is reasonable for incomplete fragments, but the same conversion is used at finalization. A truncated/malformed final call can therefore execute with empty arguments. Successfully parsed primitives/null are also merely cast to `Record<string, unknown>`; no tool-schema validation occurs at the execution boundary.

**Implementation context:** Distinguish provisional stream display from executable final calls. Validate the completed object and selected tool's required arguments before execution. Test incomplete JSON at a length-limited finish and syntactically valid non-object JSON. Preserve an actionable error rather than quietly substituting defaults.

### R21 — Tool-only/reasoning-only responses lose usage metadata

**Priority:** P3. **Evidence:** Inspection.  
**Location:** [server/ollama-client.ts](../server/ollama-client.ts), done handling and `compactSteps`; [server/openai-client.ts](../server/openai-client.ts), final usage assignment and compaction.

Both adapters attach usage to an assistant step that is omitted when its text is blank. The handler's replacement assistant envelope, when one is synthesized, does not inherit that usage. Token accounting therefore disappears for tool-only turns and reasoning-only/length-capped replies, despite provider counters being present.

**Implementation context:** Model invocation/turn metadata should survive independently of assistant prose. Do not fix accounting by displaying a synthetic assistant message, which would worsen R13. Test a final chunk with usage plus calls or reasoning and no visible assistant text.

## MCP lifecycle and naming

### R10 — MCP initialization/disconnection leaks clients or subprocesses

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/tools/mcp-bridge.ts](../server/tools/mcp-bridge.ts), `connect` around lines 51–73 and `disconnect` around line 180; [server/ws-handler.ts](../server/ws-handler.ts), async initialization and socket-close cleanup.

Clients are added to `this.servers` only after both `client.connect` and `listTools` complete. A close during either await runs `disconnect` before the client is registered; initialization can subsequently append it to a dead connection. Failure during connection/discovery enters a catch that emits metadata but does not close the partially initialized client/transport. The server creates a separate bridge per WebSocket, so repeated reconnects can accumulate resources.

**Implementation context:** Track resources from acquisition, close on failure, and make disposal prevent late initialization from registering resources or discovering more servers. Verify disconnect during a delayed handshake, failure after transport connection, and multiple configured servers. A successful normal disconnect test alone is insufficient.

### R22 — MCP tool names collide across servers and built-ins

**Priority:** P2. **Evidence:** Inspection; conditional on duplicate names.  
**Location:** [server/tools/mcp-bridge.ts](../server/tools/mcp-bridge.ts), `toolToServer.set(tool.name, server)` around line 76; [server/tool-executor.ts](../server/tool-executor.ts), first matching executor.

UI IDs include the MCP server name, but wire tool names and dispatch lookup do not. Two MCP servers exposing the same tool name overwrite the lookup while both definitions remain discoverable. A name matching a built-in can be intercepted by the earlier registered built-in executor. The user can select one tool and invoke another implementation.

**Implementation context:** The actual name sent to the model and used for dispatch must disambiguate servers, or collisions must be rejected explicitly. UI IDs alone are insufficient. Account for persisted enabled-tool IDs/history when changing names. Test same-named tools from two MCP servers and a collision with `curl`.

### R33 — Default MCP configuration hardcodes a browser installation

**Priority:** P3. **Evidence:** Inspection.  
**Location:** [server/mcp-config.json](../server/mcp-config.json).

The default Playwright MCP command points at `/home/mrother.linux/.cache/ms-playwright/chromium-1208/chrome-linux/chrome`, which is specific to another machine. The same command resolves `@playwright/mcp@latest`, so a newly started connection can also acquire different server behavior without a repository change. This default configuration is initialized for each WebSocket connection.

**Implementation context:** Prefer a portable/configurable executable selection and an intentional versioning policy. Existing `MCP_CONFIG` support can provide an operator-owned configuration. The browser override used for this review is evidence of local availability, not a portable replacement path.

## Startup, configuration, and verification workflow

### R12 — Production start script is incompatible with static export

**Priority:** P2. **Evidence:** Reproduced.  
**Location:** [package.json](../package.json), `scripts.start`; [next.config.ts](../next.config.ts), `output: "export"`; [Makefile](../Makefile), `start`.

The package start script runs `next start`, which exits with an explicit static-export incompatibility error after a successful build. The Makefile already contains the working architectural entrypoint: `node --import tsx server/index.ts`, serving both the export and backend.

**Implementation context:** Align the advertised production entrypoint with that unified server rather than changing the frontend away from static export. Verify root assets and a backend endpoint through the same production process. Ensure runtime dependencies required by the chosen launch command are available in the deployment installation.

### R23 — Documented development startup and `dev:full` are miswired

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [README.md](../README.md), Getting Started; [package.json](../package.json), `dev`, `dev:full`, `dev:auto`; [scripts/run-dev.mjs](../scripts/run-dev.mjs); [backend-client.ts](../src/lib/backend-client.ts), URL selection.

The README starts only `next dev`, but chat and model/tool HTTP requests require the backend. `dev:full` starts Next and the backend with default port 3000, causing a port collision; just selecting different ports is not enough unless the frontend also receives the backend URL. `dev:auto` already sets the backend to frontend port + 1 and supplies `NEXT_PUBLIC_WS_URL`; `make dev` uses it.

**Implementation context:** Reuse the existing working URL/port wiring as evidence. Document backend/provider configuration as well as frontend startup. Environment-supplied ports can change the exact collision, so the finding concerns default behavior. The unused `getFreePort` helper in `run-dev.mjs` does not make the current fixed-port strategy automatic.

### R24 — Handwritten environment loading preserves quoting syntax

**Priority:** P2. **Evidence:** Inspection.  
**Location:** [server/index.ts](../server/index.ts), `.env`/`.envrc` parsing around lines 16–28.

The parser strips a leading `export`, splits at the first `=`, and assigns the remaining trimmed text verbatim. `MINIMAX_API_KEY="example"` retains the quotes; quoted URLs likewise cease to be valid fetch targets. It is described as picking up the same environment as Next.js but does not implement equivalent quoting/comment semantics. Leading whitespace before `export` is another discrepancy because stripping precedes trimming.

**Implementation context:** Use a defined environment-file format/parser. Do not shell-evaluate arbitrary `.envrc` content merely to support shell syntax. Preserve environment precedence intentionally and test quoted values, comments, equals signs inside values, and an already-set variable. No real credentials need to appear in fixtures or output.

### R25 — Standalone frontend typechecking fails on test globals

**Priority:** P3. **Evidence:** Reproduced.  
**Location:** [tsconfig.json](../tsconfig.json), broad `include`; [vitest.config.ts](../vitest.config.ts), `globals: true`; [tests/unit/chat-workspace.test.tsx](../tests/unit/chat-workspace.test.tsx); [tests/unit/tour-data.test.ts](../tests/unit/tour-data.test.ts).

The standalone command produced 183 diagnostic lines, including missing `vi`, `describe`, `beforeEach`, `it`, and `expect`, plus downstream typing errors. Vitest makes globals available at runtime but their type declarations are not supplied to this TypeScript compilation. The production build passed, so do not describe this as a reproduced build failure.

**Implementation context:** Explicit test imports or an appropriately scoped test type configuration can make the standalone check meaningful. Avoid simply excluding all tests without retaining a way to typecheck them. Re-run both frontend and backend TypeScript commands; their configurations differ.

### R26 — Broad test commands omit integration checks; E2E mocks the backend

**Priority:** P3. **Evidence:** Coverage/configuration inspection.  
**Location:** [package.json](../package.json), `test`; [Makefile](../Makefile), `test`; [scripts/run-playwright.mjs](../scripts/run-playwright.mjs); [tests/e2e/backend.spec.ts](../tests/e2e/backend.spec.ts).

`test` runs unit tests only. `make test` runs unit and browser tests, not the integration suite. The browser runner serves the export through Python, and browser specs intercept WebSockets and model/tool endpoints. Despite its filename, `backend.spec.ts` does not exercise a real backend/provider/tool round trip. Those boundaries explain why the full existing suites pass alongside R01–R08.

**Implementation context:** Make check scope explicit and include server integration coverage in the intended release gate. Preserve fast deterministic browser mocks, but do not call them real backend coverage. Live tokenizer checks remain gated and were skipped here. Document browser installation and network/socket prerequisites; environment launch failures are distinct from application assertion failures.

### R36 — Package-manager instructions disagree with the executable workflow

**Priority:** P3. **Evidence:** Maintenance/configuration inspection.  
**Location:** [AGENTS.md](../AGENTS.md), [package.json](../package.json), [Makefile](../Makefile), [README.md](../README.md), and [scripts/run-dev.mjs](../scripts/run-dev.mjs).

The repository instruction says the package manager is `uv`, while this JavaScript application and its launch/test scripts invoke npm/npx. The inspected project has no Python package manifest establishing a uv-based installation workflow. Agents following the prose literally and contributors following the README receive incompatible guidance.

**Implementation context:** Clarify the intended tooling contract rather than mechanically replacing npm with uv commands: uv is not a JavaScript dependency-manager substitute. Until the instruction is clarified, preserve its authority and avoid inventing a migration. Review commands used installed Node entrypoints directly; no dependency migration was attempted.

## Guided tour and project records

### R27 — Finishing the tour deletes modified example conversations

**Priority:** P2. **Evidence:** Inspection against an explicit spec requirement.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), `finishTour` around line 613; [guided-tour spec](../specs/epic-guided-tour-with-react-joyride/spec.md), Tour conversations lifecycle around lines 392–394.

The implementation removes every conversation with `_tourExample`, regardless of edits or extra user messages. The spec explicitly requires keeping modified examples. A user who interacts with an example can lose that work when finishing or skipping the tour.

**Implementation context:** Distinguish untouched seed data from user-modified conversations and clear/transition the example marker on preserved chats as appropriate. Selection and persisted order must remain valid after cleanup. Verify both untouched removal and retention after editing/sending messages.

### R28 — Tour completion does not restore original sidebar state

**Priority:** P3. **Evidence:** Inspection against the spec.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), `handleStartTour`, automatic-start effect, and `finishTour` around lines 627–637; [guided-tour spec](../specs/epic-guided-tour-with-react-joyride/spec.md), sidebar-state section.

Manual start saves the previous sidebar state, but finish explicitly overwrites both saved open flags with `false`. Automatic start never captures the original state and also collapses both sidebars. This differs from the spec's promise to save and restore the user's original state.

**Implementation context:** Restore the actual captured state for both automatic and manual entry, or explicitly reconcile the product requirement if collapse-on-finish is intentional. Verify a user who begins with either sidebar open, not just the default collapsed layout.

### R29 — Guided-tour lifecycle has no browser coverage

**Priority:** P3. **Evidence:** Coverage gap.  
**Location:** [tests/e2e/app.spec.ts](../tests/e2e/app.spec.ts) and [tests/e2e/backend.spec.ts](../tests/e2e/backend.spec.ts), setup marking `ollamable.tourCompleted=true`; [guided-tour stories](../specs/epic-guided-tour-with-react-joyride/stories.json); [guided-tour spec](../specs/epic-guided-tour-with-react-joyride/spec.md), E2E tests section.

Both browser suites suppress the tour. Story 3 explicitly defers Playwright work to a future story, while the epic is marked done. The spec lists auto-start, skip, replay, persistence, and cleanup scenarios. Tour-data unit tests do not establish lifecycle correctness; R27–R30 sit in the untested orchestration.

**Implementation context:** Record deferred verification explicitly and exercise the actual tour instead of inheriting the global completed flag in those scenarios. Keep ordinary chat tests isolated from tour overlays.

### R30 — Tour initialization guard conflicts with effect cleanup/replay

**Priority:** P2. **Evidence:** Inspection; development Strict Mode scenario not independently reproduced.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), auto-start effect around lines 523–568.

The effect sets `tourInitRef.current = true` before scheduling its 500 ms timer. Cleanup clears that timer. If React replays effect setup/cleanup while retaining the ref, the second setup returns immediately and no replacement timer is installed. This suppresses automatic startup in effect-replay scenarios, notably development Strict Mode.

**Implementation context:** Make initialization and cleanup idempotent without treating a cancelled schedule as completed initialization. Verify with a Strict Mode mount and fake timers as well as a normal mount; do not remove cleanup and leave orphan timers. The missing tour coverage in R29 explains why the current suite would not reveal this.

### R31 — Backlog and tour records are inconsistent or stale

**Priority:** P3. **Evidence:** Rechecked document contents and current test results.  
**Location:** [BACKLOG.md](../BACKLOG.md), [guided-tour epic state](../specs/epic-guided-tour-with-react-joyride/epic-state.json), [guided-tour stories](../specs/epic-guided-tour-with-react-joyride/stories.json).

The epic state says `done`/`COMPLETE` and lists all stories completed, while all three story entries still say `pending`. The backlog also says the unit baseline is red due to an accessibility-label mismatch; this review ran all 204 unit tests successfully. Other finding text says no relevant ownership epics exist, although the same backlog now lists those epics. Its workspace size is stale (3,675 versus the current 3,735 lines).

**Implementation context:** Reconcile records using current evidence and the project's canonical record workflow. Do not reintroduce a fixed UI-label problem to satisfy stale text. Preserve historical observations as history if useful, but distinguish them from outstanding defects. Existing untracked backlog content was not edited during this review/documentation task.

## Maintainability, persistence, and documentation

### R32 — Workspace component concentrates too many responsibilities

**Priority:** P3. **Evidence:** Maintenance inspection.  
**Location:** [chat-workspace.tsx](../src/components/chat-workspace.tsx), 3,735 lines at review time.

The component owns transport callbacks, generation lifecycle, transcript projection, model repair, persistence, tour orchestration, sidebars, settings, editing, and modal rendering. The guided-tour spec already warned against further growth when this file was approximately 2,500 lines. Bugs in unrelated areas now share a large stateful surface and broad integration-style component tests.

**Implementation context:** Existing `BackendClient`, token-view hooks, and request-preview components provide natural seams. Separate coherent ownership as fixes touch these areas; do not make a wholesale rewrite a prerequisite for security fixes. This is a maintenance finding, not a claim that line count alone is a functional defect.

### R34 — Persistence failures are inconsistently handled and not surfaced

**Priority:** P3. **Evidence:** Inspection.  
**Location:** [chat.ts](../src/lib/chat.ts), `saveConversations`, `saveSidebarState`, `saveConversationOrder`, and `saveSelectedConversationId`; [chat-workspace.tsx](../src/components/chat-workspace.tsx), persistence effects.

Conversation saves retry quota errors after stripping `contentTokens`, but a second quota failure only emits a console warning while the UI continues normally. Users can believe new messages are saved when they are not. Other localStorage writers lack the quota handling and can throw from effects/event handlers once storage is full or unavailable. Conversation saving rethrows non-quota storage errors as well.

**Implementation context:** Keep the useful token-stripping fallback and expose persistent save failure without deleting existing data. Share safe storage behavior across settings/order/selection writes. Verify both quota exhaustion and unavailable storage; passing conversation quota tests does not establish that all storage paths are safe. Partial streamed steps are also persisted during generation; recovery semantics after refresh remain worth checking while working here.

### R35 — README promises exact Ollama JSON, but preview is OpenAI format

**Priority:** P3. **Evidence:** Documentation and code inspection.  
**Location:** [README.md](../README.md), request/response inspection description; [chat-workspace.tsx](../src/components/chat-workspace.tsx), `requestJsonPreview` around line 952 and modal subtitle around line 3096; [server/ollama-client.ts](../server/ollama-client.ts), `buildOllamaChatBody`.

The README promises the exact payload sent to Ollama. The main JSON preview always uses `buildOpenAIRequestBody` and is explicitly labeled `OpenAI-compatible format` in the UI. Ollama actually receives different fields, including `options.num_predict`, `options.temperature`, and `think`; the separate token/template preview does not make the main JSON an exact wire representation.

**Implementation context:** Either make preview generation provider-specific using shared request builders or narrow the documentation's promise. Preserve the existing explicit UI label. This is not a claim that the modal currently pretends to be Ollama format; the discrepancy is between documentation and actual preview semantics.

## Notes for verification and issue closure

The most useful existing test locations are [ws-handler.test.ts](../tests/integration/ws-handler.test.ts) for handler behavior, [backend-client-tokenize.test.ts](../tests/unit/backend-client-tokenize.test.ts) for pending-request cleanup patterns, [chat-workspace.test.tsx](../tests/unit/chat-workspace.test.tsx) for frontend state, and [backend.spec.ts](../tests/e2e/backend.spec.ts) for scripted WebSocket browser flows. Ollama adapter/format/tokenizer tests are comparatively extensive. The inspected test inventory contains no dedicated OpenAI streaming-client test file, so format-conversion tests alone do not cover R08/R20.

Targeted probes used harmless mock network responses and deterministic delayed promises. Retain that approach for execution/cancellation regressions. Validate the production HTTP/static boundary with the actual server because the usual browser runner's Python server cannot catch R01 or R02.

The following observations should not be misreported as confirmed current failures: the old unit-test accessibility-label mismatch (suite now passes), production build failure (build passed), a malformed-message process crash (the outer rejection guard exists), universally blocked browser execution (the suite passed after an environment override), or live-provider/tokenizer conformance (live checks were skipped). The uncertain ordering race between HTTP tool loading and WebSocket discovery was noticed during inspection but not established as a user-visible loss; conversation tool merging may preserve the definitions, so it is not promoted to a confirmed issue here.
