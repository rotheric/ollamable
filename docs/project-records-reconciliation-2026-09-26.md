# Project-record audit — 2026-09-26

The former freeform `BACKLOG.md` is preserved verbatim below a historical-snapshot
notice in `history/backlog-before-review-2026-09-26.md`. The installed base-records
workflow reads `BACKLOG.json`, so its canonical `migrate-v3 --keep-md` helper was
used; no bootstrap/CLAUDE.md rewrite was needed. Subsequent mutations use the
canonical enrich, resolve and add-epic helpers. The readable Markdown view is
rendered from the canonical store.

The migration recognizes the seven planning topics as findings because they have
no scaffolded epic directories. Their scope and unfinished work remain in the
finding enrichment fields. The migration does not parse the ten freeform finding
paragraphs or the future-work breakdown; their complete text remains in the
historical snapshot, and each paragraph's disposition is recorded here:

| Historical finding | Current disposition / evidence |
| --- | --- |
| README startup does not run the full stack | Resolved by R23 / f3e5966; real development startup browser test. |
| dev:full uses conflicting ports | Resolved by R23 / f3e5966; validated ports, URL wiring and shutdown. |
| Tour epic and stories disagree | Reconciled to IN_PROGRESS. Original 28-step/two-example requirements remain unmet; see the tour verification audit. |
| Tour browser verification is deferred and untracked | Current lifecycle coverage supplied by R29 / 59fc679; larger original tour acceptance remains open. |
| Backlog has no planning beyond the tour | Obsolete claim: seven planning topics were already present; now represented in the canonical store. Token-view epic is also registered from its existing state. |
| Workspace complexity is unowned; 3,675 lines | Ownership already existed. R32 / 59fc679 extracts tour lifecycle. Remaining sidebar/transcript/composer ownership work stays open; use current source rather than an undated fixed line count. |
| Unit suite is red due to the model metadata label | Obsolete. The current gate passes 233 unit tests; no UI-label regression was reintroduced. |
| Integration environment requirements are undocumented | Resolved by R26 / ad39777; README distinguishes socket/browser prerequisites, live skips and assertion failures. |
| Provider behavior has no owner | Ownership claim obsolete. Provider/platform planning is retained with current implemented behavior and remaining compatibility-policy work. |
| MCP/tool behavior has no owner | Ownership claim obsolete. Tooling/MCP planning is retained, with lifecycle/configuration fixes credited and remaining UX work explicit. |

The original local-development, governance and quality-baseline planning outcomes
are supplied by the remediation contract in `specs/project-review-remediation.md`.
The tour follow-through, provider platform, tool productization and broader frontend
ownership topics remain open. They are not conflated with the finite review's
individual completed fixes.
