<!-- Historical snapshot before R31 reconciliation; not the current backlog. -->

# Project Backlog

## Epics

- specs/epic-guided-tour-with-react-joyride/ — DONE — seeded by /base:backlog init 2026-05-12
- Epic: local-dev-and-onboarding-hardening — TODO
  Scope: make the documented startup path actually run the full app, fix broken dev scripts, and align README/dev ergonomics with the real frontend+backend architecture.
- Epic: backlog-and-spec-governance — TODO
  Scope: reconcile project status artifacts (`BACKLOG.md`, epic state files, story status files), define what "DONE" means, and ensure planning files reflect real completion state.
- Epic: guided-tour-follow-through — TODO
  Scope: close the gap between the completed guided-tour implementation and the remaining verification/documentation work, especially Playwright coverage and state reconciliation.
- Epic: provider-and-model-platform — TODO
  Scope: explicitly track the multi-provider model routing surface, provider capabilities, metadata behavior, and compatibility expectations that already exist in the codebase.
- Epic: tooling-and-mcp-productization — TODO
  Scope: track the built-in tool system, MCP bridge lifecycle, tool discoverability, failure handling, and operator-facing configuration/documentation as first-class product work.
- Epic: frontend-architecture-and-maintainability — TODO
  Scope: reduce `chat-workspace.tsx` complexity, carve out coherent subcomponents/hooks, and keep future features from accumulating in a single monolith.
- Epic: quality-and-release-safety — TODO
  Scope: restore a green local test baseline, define release gates, and add coverage for user-visible flows that are currently under-specified or only partially tested.

---

## Findings

- `README.md` documents a startup path that does not boot the full application stack.
  Evidence: `README.md` says to run `npm install` and `npm run dev`, then open `http://localhost:3000`.
  Evidence: the frontend expects a live WebSocket backend through `src/lib/backend-client.ts`.
  Evidence: `npm run dev` starts only Next.js; it does not start `server/index.ts`.
  Why this matters: a new user following the docs lands in a partially functional UI with no working chat transport.
  Follow-up:
  - update docs to the correct command path
  - decide which command is the canonical developer entrypoint
  - add a smoke check that the documented command actually supports a full chat roundtrip

- `dev:full` is miswired and likely unusable because frontend and backend both default to port `3000`.
  Evidence: `package.json` defines `dev:full` as concurrently running `npm run dev` and `npm run dev:server`.
  Evidence: `server/index.ts` binds to `process.env.PORT ?? process.env.WS_PORT ?? "3000"`.
  Why this matters: one of the advertised dev commands is broken by construction, which increases confusion and hides the actual supported path (`dev:auto`).
  Follow-up:
  - either remove `dev:full` or make it allocate distinct frontend/backend ports
  - align all scripts, docs, and test harness assumptions on one supported port strategy

- The planning artifacts disagree about the guided-tour epic state.
  Evidence: `BACKLOG.md` marks `specs/epic-guided-tour-with-react-joyride/` as `DONE`.
  Evidence: `specs/epic-guided-tour-with-react-joyride/epic-state.json` marks the epic `done` with all stories completed.
  Evidence: `specs/epic-guided-tour-with-react-joyride/stories.json` still marks `s1`, `s2`, and `s3` as `pending`.
  Why this matters: the backlog cannot be trusted as a control plane if status semantics drift between files.
  Follow-up:
  - define the source of truth for epic/story status
  - reconcile all guided-tour story statuses
  - add a consistency check for spec state files

- The guided-tour epic was closed without tracking its deferred verification work as a follow-up story/epic.
  Evidence: `stories.json` explicitly lists E2E / Playwright tests as future work outside Story 3 scope.
  Evidence: `spec.md` still lists concrete guided-tour Playwright scenarios that should exist.
  Why this matters: an implementation can look "done" while still missing the verification needed to keep it stable.
  Follow-up:
  - create a guided-tour verification story or follow-on epic
  - add Playwright coverage for auto-start, skip, replay, cleanup, and persistence behavior

- `BACKLOG.md` does not describe the actual breadth of the shipped product.
  Evidence: the backlog contains one completed tour epic and no planned work beyond it.
  Evidence: the codebase already includes multi-provider routing, OpenAI-compatible streaming, MCP integration, built-in tools, request previewing, persistence, and large frontend state management surfaces.
  Why this matters: meaningful work is happening outside the backlog, so planning is not useful for prioritization, review, or handoff.
  Follow-up:
  - add epics for provider/platform work
  - add epics for tooling/MCP work
  - add epics for frontend architecture and quality gates

- The main workspace component has grown far beyond the size the guided-tour spec itself warned about.
  Evidence: `specs/epic-guided-tour-with-react-joyride/spec.md` notes that `chat-workspace.tsx` was already about 2500 lines and should avoid further bloat.
  Evidence: `src/components/chat-workspace.tsx` is now 3675 lines.
  Why this matters: ongoing feature work is likely to get slower, riskier, and harder to review; the backlog currently ignores this maintainability cost.
  Follow-up:
  - extract tour state/orchestration into a dedicated hook
  - split sidebar, transcript, composer, and settings areas into focused components
  - define acceptable component-size/ownership boundaries

- The current unit test baseline is red due to a drift between implementation and test expectations around the model metadata chip.
  Evidence: `tests/unit/chat-workspace.test.tsx` looks for a button named `Open metadata for qwen3:latest`.
  Evidence: `src/components/chat-workspace.tsx` currently exposes `aria-label="Open model settings for ..."`.
  Evidence: `npm run test:unit` fails on this mismatch.
  Why this matters: the repo does not currently have a clean baseline for validating future changes.
  Follow-up:
  - decide whether the UI language should be "metadata" or "settings"
  - update either the implementation or the tests to match the intended contract
  - restore a passing unit suite before additional feature work

- Integration test results depend on the execution environment, and this is not captured anywhere in the backlog.
  Evidence: `npm run test:integration` failed under sandbox restrictions because the suite opens a listening socket.
  Evidence: the same suite passed when rerun outside the sandbox.
  Why this matters: contributors can misclassify environment failures as product regressions, and CI/local expectations are not clearly described.
  Follow-up:
  - document integration-test runtime requirements
  - decide whether tests should bind to loopback more explicitly or be structured to degrade more clearly in restricted environments
  - make the release/test checklist distinguish environmental failures from app failures

- Provider/platform behavior exists as product surface but is not planned as such.
  Evidence: `server/provider-config.ts` already supports Ollama plus optional OpenAI-compatible providers such as MiniMax.
  Evidence: `server/llm-router.ts` performs provider resolution, model listing, capability plumbing, and metadata routing.
  Why this matters: provider support now affects UX, documentation, compatibility, error handling, and test coverage, but no epic owns it.
  Follow-up:
  - define supported-provider policy
  - track capability differences across providers
  - add tests/docs for provider-specific behavior, especially metadata and reasoning support

- MCP and built-in tool execution are substantial product areas with no corresponding backlog ownership.
  Evidence: `server/tools/mcp-bridge.ts` manages stdio MCP connections, dynamic tool discovery, and delegated execution.
  Evidence: `server/tools/web-search.ts` and other server tool executors expose operational behavior, env requirements, and failure states to end users.
  Why this matters: tool UX, configuration, and reliability are central to the demo value proposition, but they are effectively unplanned.
  Follow-up:
  - define tool configuration/documentation tasks
  - define MCP connection lifecycle and observability improvements
  - add backlog items for tool discovery, disabled-state UX, and error reporting

## Future Work Breakdown

### local-dev-and-onboarding-hardening

- Make one command the canonical local entrypoint.
- Ensure the canonical command starts both frontend and backend successfully.
- Remove or repair misleading dev scripts.
- Align README, package scripts, and any test harness assumptions on the same ports and URLs.
- Add a developer smoke test for startup plus one successful chat exchange.

### backlog-and-spec-governance

- Define the authoritative status source for epics and stories.
- Reconcile all existing guided-tour status files.
- Decide how deferred work from a completed epic must be represented.
- Add a lightweight audit/check so status files cannot silently contradict each other.

### guided-tour-follow-through

- Add the missing Playwright scenarios called for in the spec.
- Verify tour cleanup, replay, persistence, and responsive behavior in automation.
- Review the tour copy/open questions and either resolve or explicitly archive them.
- Decide whether the guided-tour epic should remain closed or be reopened until verification work lands.

### provider-and-model-platform

- Document supported providers and configuration paths.
- Define expected behavior for model listing, metadata, reasoning support, and request preview across providers.
- Add coverage for provider resolution fallback behavior and provider-specific UX differences.
- Review whether model metadata UI language and behavior are correct for non-Ollama providers.

### tooling-and-mcp-productization

- Document required environment variables and failure modes for built-in tools.
- Improve disabled/unconfigured tool UX so users understand why a tool is unavailable.
- Define how MCP servers are configured, surfaced, retried, and debugged.
- Add tests for tool discovery updates and failure reporting.

### frontend-architecture-and-maintainability

- Break `chat-workspace.tsx` into owned subcomponents and hooks.
- Reduce coupling between transcript rendering, transport state, sidebar state, and guided-tour state.
- Establish guardrails for future growth so new features do not keep expanding a single file.
- Add focused unit tests around extracted modules to reduce regression blast radius.

### quality-and-release-safety

- Restore a fully green local unit-test baseline.
- Define required checks before calling backlog items complete.
- Expand coverage for user-visible transcript behavior, transport behavior, and settings interactions.
- Document environmental prerequisites for integration and E2E execution.

---

## Archive

- _no rejections yet_
