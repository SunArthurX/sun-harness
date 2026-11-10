# Full product verification report

Date: 2026-11-10 (Asia/Shanghai). Scope: the `main` worktree with its
pre-existing uncommitted changes, all 33 numbered specs, the documented CLI,
desktop, gateway web and bot surfaces, and Settings AC-01–AC-16. Plan:
[plan.md](plan.md). Per-feature evidence: [feature-ledger.md](feature-ledger.md).
Defects and observations: [run-log.md](run-log.md).

## Result

Every required check passed on the final build and its signed package.
The owner granted Screen Recording and Accessibility to the final bundle,
`apps/desktop/release/full-product-d17/mac-arm64/sun-harness.app` (cdhash
`3658f97b6d8daadb8b40342203dda962bd1cb582`). On that bundle, the positive
Appshot, Computer Use and Keychain fixtures passed. Before the grants, the
same bundle passed its ungranted boundary and preflight checks. No open
checks remain.

| Suite (final run, `evidence/signoff-*`) | Result |
| --- | --- |
| `pnpm build`, `pnpm typecheck` | exit 0, exit 0 |
| `SUN_TEST_DOCKER=1 pnpm test --reporter=verbose` | 45 files, 337 tests passed, none skipped (the real Docker sandbox case ran) |
| `node --test packages/cli/e2e/product.mjs` | 23/23 passed |
| `node apps/desktop/e2e/chat-product.mjs` | Electron and gateway web each passed four scenario groups (chat, browser, pages, worktree). No managed Chromium survived quit, and one `SIGTERM` quit a fresh app |
| `node apps/desktop/e2e/settings.mjs` | 30 cross-surface checks passed, exit 0 |
| `node apps/desktop/e2e/settings-remote.mjs` | Pinned TLS gateway: 4 checks passed |
| `node apps/desktop/e2e/browser-backends.mjs` | External and Docker Chromium passed |
| `node apps/desktop/e2e/execution-docker.mjs`, `hooks-docker.mjs` | Passed with a real Docker engine |
| `node apps/desktop/e2e/smoke.mjs` | Passed and captured every screen |
| `node scripts/check-settings-plan.mjs` and its tests | 29 screenshot entries and 15 tasks; 12/12 tests |
| `sun eval validate`, `settings-qualification.mjs --validate` | 36/36 coding tasks; 3/3 Settings fixtures |
| `git diff --check` | exit 0 |
| Final package | Ad-hoc signed, `codesign --verify --deep --strict` valid, asar identical to the build, and both native helpers present |
| Appshot `--boundary-only`, Computer Use `--preflight-only` on the final package | exit 0; Screen Recording `permission-required`; Accessibility `false`, so control is denied |
| Leftover process check after all fixtures | No fixture app, Electron or Chromium process remained |
| Positive native runs on the granted final package | [Appshot](evidence/signoff-appshot.txt): capture, crop and mask, cancel, prepared-only send. [Computer Use](evidence/signoff-computer.txt): Accessibility `true`; approved press and edit, receipts, stale, foreground, stop and revocation denials. [Keychain](evidence/signoff-credentials.txt): persistence across restart, request-only fill, no leak. All exit 0 |

Reproduce with the commands in [Verify a local build](../../manual/verification.md).
Each `.txt` log under `evidence/` starts with the exact command and its
start time; the matching `.exit` file holds the exit status.

## Defects

D01–D12 were fixed before the handoff, and no regression reopened them. The
final suites include each of their regression cases.

| ID | Kind | Summary | Status |
| --- | --- | --- | --- |
| D13 | Product | Gateway JSON `null` was treated as Appshot metadata, so ordinary image thumbnails failed on gateway web. | Fixed at the gateway boundary; Appshot validation unchanged. |
| D14 | Fixture | An isolated `HOME` made headless Chrome wait for a login keychain, and navigation timed out. | Fixture uses a test-only `--use-mock-keychain` launcher; product flags unchanged. |
| D15 | Product | A failing CLI chat slash command (for example `/reflect`) ended the chat process with exit 1. | Fixed: the error is printed and the session continues. |
| D16 | Product | Quitting the desktop app could orphan its managed Chromium, and browser disposal released the profile before Chromium exited. | Fixed: quit waits for bounded disposal; disposal waits for the process to exit, then kills it. |
| D17 | Product (introduced by the first D16 fix) | One `SIGTERM` closed the windows but left the app running. | Fixed: the quit after disposal is requested in a later task. |
| D18 | Product | A Chromium that missed the 10-second DevTools startup wait was left running. | Fixed: the launch error stops the spawned process first. |

Each defect links its first failure, cause and passing rerun in the
[run log](run-log.md). Spec Decisions were added in 025 (D13, D15), in 004
(D16, D17) and in 022 (D16, D18).

## Coverage added in this audit

The audit compared every plan row with source and test names before adding
tests. The new cases are:

- Built CLI: all chat slash commands in one session, and the management
  commands that had no process-level test.
- Eval: persisted per-task telemetry for a scripted run.
- Bot bridge: every documented chat command.
- Compatibility skills: `.claude/skills` and `.agents/skills` precedence.
- Renderer (Electron and gateway web): Deny, Always allow, Deliverables,
  Review, Undo, and process cleanup after quit. Electron also checks that one
  `SIGTERM` quits.
- Core: browser disposal leaves no process on the profile, and a stalled
  launch is stopped.

## Native package

The QA bundle path is fixed at
`apps/desktop/release/full-product-d17/mac-arm64/sun-harness.app`. Later
native runs should rebuild in place at that path rather than in a new
directory. macOS ties an ad-hoc signature's grants to its code hash, so a
rebuilt bundle may still need Screen Recording and Accessibility granted
again. Record the cdhash with every native result.

## Scope limits

These limits are deliberate and are not counted as failures:

- No live vendor accounts were used. Provider, search, bot, mail/calendar
  and company-knowledge behavior is verified against loopback fixtures that
  follow vendor contracts and published test vectors. The Settings live
  qualification is the dated T15 DeepSeek run; the plan checker confirms that
  its prompt and suite hashes still match.
- No physical microphone was used; a controlled audio source stands in.
- Linux Bubblewrap ran only in a disposable container with namespace
  capabilities; the host is macOS.
- The renderer Export menu's OS download and the opening of a deliverable
  with `openPath` were not clicked. Their data paths are verified through
  RPC and CLI.
