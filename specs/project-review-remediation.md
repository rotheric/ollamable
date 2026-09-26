# Project-review remediation contract

This records the startup, release and record-governance behavior implemented for
`docs/project-review-2026-09-26.md`. It does not replace feature epic acceptance
criteria or close unrelated product planning work.

## Startup

All combined development aliases start the frontend and backend with distinct
ports and a matching WebSocket URL/origin. Both stop when the runner stops.
Production serves the Next.js static export and backend through one process/port.
The documented entrypoints are exercised in `tests/e2e/startup.spec.ts`, including
a real local-provider/tool round trip through production.

## Release verification

`node scripts/run-checks.mjs`, the package `test`/`check` commands and `make test`
run project-record consistency, unit tests, server integration tests, both
standalone typechecks, the production build and browser tests. Every stage must
pass before calling the release gate green. Live-provider skips and environment
launch failures are reported separately. Focused checks are not release passes.

## Record governance

`BACKLOG.json` is the canonical backlog, mutated through the installed base
backlog helpers. `BACKLOG.md` is its readable generated view. The original
freeform Markdown is retained in `docs/history/backlog-before-review-2026-09-26.md`;
its dated claims are historical, not open-defect assertions.

Story `status` values reflect the original acceptance criteria and evidence. An
epic may say `done`/`COMPLETE` only if all its stories are done, and its
`completed_stories` must agree with the story list. The backlog epic status must
agree with that state. Partial implementation is `in_progress`/`IN_PROGRESS`, even
when the currently implemented subset has green tests. Deferred verification must
be recorded explicitly; tests added later do not silently waive other criteria.

`node scripts/check-project-records.mjs` checks these status invariants in the
release gate. Findings leave the backlog only through canonical resolve helpers;
substantive unfinished product planning stays open. Routine record corrections do
not require rewriting product requirements.
