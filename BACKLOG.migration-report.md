# BACKLOG migration report

Generated 2026-09-26 by `plugins/base/skills/backlog/scripts/migrate-v3.sh`.

The v2 `BACKLOG.md` contained rows under `## Epics` that did not fit v3's
`specs/epic-<slug>/` shape. Best-effort interpretation made the calls below.
Edit `BACKLOG.json` directly (via `scripts/*.sh`) to override; this report is
informational and is not consulted by any /base: surface.

## Demoted to findings (7)

These rows pointed at a path that was not a v3-shape epic dir but were
interpretable as work-we-know-about. They have been demoted into
`findings[]` and can be promoted via `/base:feature backlog:<slug>` or
closed via `/base:backlog resolve <slug>`.

- BACKLOG.md:6 — `Epic: local-dev-and-onboarding-hardening` → finding `epic-local-dev-onboarding-hardening` (v2 status: `TODO`)
- BACKLOG.md:8 — `Epic: backlog-and-spec-governance` → finding `epic-backlog-spec-governance` (v2 status: `TODO`)
- BACKLOG.md:10 — `Epic: guided-tour-follow-through` → finding `epic-guided-tour-follow-through` (v2 status: `TODO`)
- BACKLOG.md:12 — `Epic: provider-and-model-platform` → finding `epic-provider-model-platform` (v2 status: `TODO`)
- BACKLOG.md:14 — `Epic: tooling-and-mcp-productization` → finding `epic-tooling-mcp-productization` (v2 status: `TODO`)
- BACKLOG.md:16 — `Epic: frontend-architecture-and-maintainability` → finding `epic-frontend-architecture-maintainability` (v2 status: `TODO`)
- BACKLOG.md:18 — `Epic: quality-and-release-safety` → finding `epic-quality-release-safety` (v2 status: `TODO`)
