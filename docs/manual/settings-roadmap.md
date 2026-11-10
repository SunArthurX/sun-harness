# Settings

Status: the settings slices through release qualification are shipped.
Family-account services and a hosted computer stay deferred. This page maps
each slice to its manual chapter. The [execution pack](../plans/settings-competitors/README.md)
keeps the project map, screenshot coverage and task evidence.

The shipped slices cover configuration validation, concurrent saves, searchable bilingual navigation, memory, voice, usage, browser grants, hooks, remote connections, worktrees, Appshots, Computer Use, website passwords and execution targets. Native Computer Use and Appshots run in the signed macOS app.

There is no sun subscription, family-account service or hosted computer. Existing API-provider costs remain the provider's responsibility; local usage totals are estimates.

To check the plan locally, run `node scripts/check-settings-plan.mjs`. The same check runs in `pnpm test`. Passing it confirms plan consistency, not feature availability. Future implementers should follow [the handoff protocol](../plans/settings-competitors/handoff.md).

## Fixture baseline

T01 added an offline compatibility baseline for legacy settings and session attachments. Run
`pnpm exec vitest run packages/core/test/settings-contract.test.ts` to reproduce it.
The tests use a temporary data directory, synthetic provider fields and a fake window capture.
See [T01 evidence](../plans/settings-competitors/evidence/T01.json) for the recorded checks.

Configuration saves now replace the complete file atomically. Existing settings and unknown
keys carry forward when a preference changes. A busy configuration file can be retried after
the other writer finishes. Use a regular file at the configuration path when saving through sun.
The validated settings API and user-facing revision conflict handling are tracked under T02.

## Browser permissions and transfers

Browser origin decisions and managed profile ownership are available from
**Settings → Browser permissions**. See [Browser](browser.md) for origin
review, takeover, one-time upload approval, and download staging. See the
[T10 acceptance evidence](../plans/settings-competitors/evidence/T10.json).

## Execution targets

[Execution targets](execution-targets.md) exposes reviewed shell jobs on
the current host, Local Docker and saved pinned gateways.

## Appshots

[Appshots](appshots.md) covers opt-in capture, private redaction, and
replay. See the [signed macOS acceptance](../plans/settings-competitors/evidence/T11.json).

## Private website credentials

[Website passwords](passwords.md) explains the macOS vault and isolated
sign-in window. See the [T13 acceptance evidence](../plans/settings-competitors/evidence/T13.json).

## Computer Use

[Computer Use](computer-use.md) explains app grants, the one-session
lease, and the stop control. See the [T12 signed acceptance](../plans/settings-competitors/evidence/T12.json).

## Repeating release verification

Run `pnpm test`, `pnpm build`, `pnpm typecheck`, and the signed and
cross-surface fixtures listed in the release evidence. The offline
handoff preflight checks the fixture judge. Live qualification runs
the public handoff prompt in three fresh copies of each fixture and
records the diff and fixed-test output. The [handoff protocol](../plans/settings-competitors/handoff.md)
defines the trial. The [T15 acceptance record](../plans/settings-competitors/evidence/T15.json)
lists the exact commands, signed fixture outcomes, and final live report.
