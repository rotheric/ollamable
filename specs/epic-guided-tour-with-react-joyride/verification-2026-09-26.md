# Guided-tour record reconciliation — 2026-09-26

The epic and all three stories are **in progress against the original acceptance
criteria**. The old `done`/`COMPLETE` epic summary was unsupported by the pending
story records and the implemented scope. This audit does not amend the product
requirements to match the smaller implementation.

| Story | Verified current implementation | Remaining original contract |
| --- | --- | --- |
| s1-tour-data | Joyride v3 dependency is present; 11 valid tour steps, one tool-use example, lifecycle constants and marker exist; 15 data tests pass. | AC-3 requires 28 steps; AC-4 requires two examples; AC-5 requires a Fibonacci example; AC-6 places the tool-use example second. |
| s2-data-tour-attrs | Every target in the current 11-step tour is traversed by browser coverage. The first step targets the existing tools overview card. The replay control works. | AC-9–15 describe the original larger target set, tools chip and different replay-control placement/markup. These have not been implemented or formally amended as a group. |
| s3-joyride-integration | Auto-start, skip, replay, Finish, refresh/resume, modified-example retention, exact sidebar restoration, Strict Mode setup/cleanup and timer cancellation are verified. Orchestration belongs to `src/lib/use-tour.ts`. | AC-18/19/22 retain the original two-example, 28-step orchestration. AC-16 uses older Joyride API names and needs an explicit compatibility amendment before literal closure. |

The earlier Story 3 deferral of Playwright coverage is historical. The current
`tests/e2e/tour.spec.ts` supplies three real Joyride lifecycle scenarios:

- Automatic start, skip, untouched-example cleanup, restored sidebars and persisted completion.
- Manual replay through every current step and Finish, including delayed-work cancellation.
- Refresh/resume, editing/resending an example, skip and retained content after another reload.

`tests/unit/use-tour.test.tsx` adds eight lifecycle cases, including normal and
Strict Mode mounts, edits/additional messages/renaming, resume restoration and
pending-timer cleanup. These checks verify the current implemented scope, not all
28 original tour steps. Responsive behavior is implemented but was not added to
this browser suite; it remains part of the original epic's completion review.

The 2026-09-26 combined release gate passed 233 unit tests, 314 server integration
tests (two live-provider skips), both standalone typechecks, the static build and
50 browser tests. The integration total includes seven MCP bridge tests. See `docs/project-review-2026-09-26.md` for the
individual remediation records and commits.
