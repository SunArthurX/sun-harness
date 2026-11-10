# Full product verification handoff

**Status 2026-11-10:** A1–A4 are complete. After the owner granted
Screen Recording and Accessibility, the final package passed the positive
Appshot, Computer Use and Keychain runs. See the [report](report.md).

Handoff date: 2026-11-10 (Asia/Shanghai). The owner requested a handoff
before the remaining implementation. Keep the audit open until the
completion check below. This file supersedes the older open-check columns
in the [working feature ledger](feature-ledger.md) where newer evidence is
listed here. The [original plan](plan.md) defines the full scope.

## Verified checkpoint

- The current checkout is `main` with extensive pre-existing tracked and
  untracked changes. Work in place, preserve all unrelated changes, and
  avoid staging, resetting, or cleaning the tree.
- D01–D12 have fixes and passing focused regressions. The [run log](run-log.md)
  maps each fix to its failure and rerun. A checkpoint of the full suite
  passed 333 tests in 45 files with Docker enabled. The CLI product fixture
  passed 21 tests. Both results precede the pending D13 repair.
  [Unit](evidence/final-unit.txt) · [CLI](evidence/final-cli.txt)
- The renderer passed the complete chat, Chromium takeover, knowledge,
  Intel, Evolution, automation, and worktree matrix before the ordinary
  attachment test was added. With the new case, Electron passed again and
  the gateway replay exposed D13. Preserve both logs.
  [Renderer matrix](evidence/renderer-header-regression.txt) · [D13 UI](evidence/renderer-attachments.txt)
- Fresh checkpoint evidence also covers [Settings](evidence/final-settings.txt),
  [pinned TLS](evidence/final-settings-remote.txt), [Chromium/noVNC](evidence/final-browser-backends.txt),
  [Docker execution](evidence/final-execution-docker.txt), [Docker hooks](evidence/final-hooks-docker.txt),
  [Linux Bubblewrap](evidence/linux-bwrap-network.txt), and
  [Matplotlib](evidence/python-real-figure.txt). Bubblewrap required network
  and namespace capabilities in a disposable Linux container. The earlier
  default-container refusals are valid environment evidence.
- Current-scope follow-up evidence includes the [smaller-model compaction test](evidence/context-budget.txt),
  [three MCP transports](evidence/mcp-transports.txt), [all bot adapters](evidence/bot-final-regression.txt),
  [search provider contracts](evidence/search-providers.txt), and
  [real terminal approval](evidence/cli-pty-regression.txt). Company knowledge,
  mail/calendar presets, voice fixtures, and real CLI gateway discovery are
  covered in the CLI checkpoint. Vendor accounts and the physical microphone
  were intentionally outside synthetic fixtures. Record that scope explicitly.

## A1. Fix D13 at the gateway boundary

**State:** Reproduced in the current tree. The implementation is pending.

1. Read `AGENTS.md`, `apps/desktop/AGENTS.md`, `specs/025-ux-from-competitors.md`
   (the heading is `## Images`), and the Appshot rules in spec 032. Review
   `packages/core/src/gateway.ts`, `packages/core/src/host.ts`, and
   `packages/core/test/gateway.test.ts`. Inspect the red logs first.
2. Reproduce with `pnpm exec vitest run packages/core/test/gateway.test.ts -t 'ordinary images'`.
   The user image reached the model and its reference was persisted. Rendering
   failed because a JSON argument array serializes absent metadata to `null`.
   `readAttachment` forwarded that value as present Appshot metadata, producing
   `APPSHOT_ATTACHMENT_UNAVAILABLE` for an ordinary PNG.
   [Focused red](evidence/gateway-image-first.txt)
3. Update the spec first with a Decision that gateway JSON `null` represents
   an absent optional metadata argument. The smallest intended fix is to
   normalize `null` to `undefined` in the gateway `readAttachment` handler.
   Preserve actual Appshot metadata and all owned-path and digest validation.
   Leave the existing regression and user-visible thumbnail assertion intact.
4. Run `pnpm exec vitest run packages/core/test/gateway.test.ts packages/core/test/settings-capture.test.ts packages/core/test/settings-import.test.ts`.
   Verify exact PNG bytes over gateway JSON and rejection of incorrect Appshot
   metadata. Build before running `node apps/desktop/e2e/chat-product.mjs`.
   Require a visible ordinary image thumbnail and a durable attachment on
   both Electron and gateway web. The script also exercises chat, Chromium,
   portal actions, and worktrees. Save the actual exits and output.

## A2. Rerun release checks on the repaired worktree

**Depends on A1.** Run these commands from the repository root. Put each
captured result and exit status under `evidence/` with distinct post-D13 names.

```sh
pnpm build
pnpm typecheck
SUN_TEST_DOCKER=1 pnpm test --reporter=verbose
node --test packages/cli/e2e/product.mjs
node apps/desktop/e2e/chat-product.mjs
node apps/desktop/e2e/settings.mjs
node apps/desktop/e2e/settings-remote.mjs
node apps/desktop/e2e/browser-backends.mjs
node apps/desktop/e2e/execution-docker.mjs
node apps/desktop/e2e/hooks-docker.mjs
node scripts/check-settings-plan.mjs
node --test scripts/check-settings-plan.test.mjs
node packages/cli/dist/index.js eval validate
node scripts/settings-qualification.mjs --validate
git diff --check
```

Run GUI and native foreground fixtures serially. Inspect what each run
actually executed, including any self-reported skip. Where a case fails,
preserve the first failure, isolate the cause, fix it, and repeat the affected
checks. The previously recorded Settings live run is usable as dated evidence
only after `handoffFixtureInputs()` and `qualifiedRelease()` confirm the
current public prompt and frozen fixture suite match its nine first-attempt
passes. Keep the earlier unsuccessful runs. A fresh paid run is unnecessary
when the report hashes still match and the audit records its scope.

## A3. Verify the final signed app

**Depends on A1 and a clean A2 build.** Create a new disposable package
directory. Use `electron-builder --mac --dir --publish never` via the
desktop package. Ad-hoc sign and verify with `codesign --verify --deep --strict`.
Compare the built main, preload, and renderer files with the files in
`Contents/Resources/app.asar`. Verify both bundled native helpers exist.
Preserve the prior permission identities and installed user app.

1. Run `node apps/desktop/e2e/appshot.mjs <final-app-path> --boundary-only`
   and `node apps/desktop/e2e/computer.mjs <final-app-path> --preflight-only`
   where the new signature is ungranted. Record the actual OS results.
2. Earlier exact authorized bundles have positive [Appshot](evidence/e2e-appshot.txt),
   [Computer Use](evidence/e2e-computer.txt), and [Keychain](evidence/e2e-credentials.txt)
   evidence. Positive checks on the final signature require the owner to
   authorize that exact package in macOS. No response to the earlier QA
   package request was observed at handoff. A grant for another path or
   signing identity does not prove readiness for this package.
3. Once the owner authorizes the final package, rerun the Appshot and
   Computer Use scripts without preflight flags and the credentials script
   with the final app path. Keep the synthetic window and credential scope.
   Record exact bundle, signature, OS grants, and positive outcomes. If a
   system grant remains unavailable, preserve the positive earlier evidence
   and report that exact final-package check as unverified.

## A4. Reconcile coverage and deliver the report

**Depends on A1–A3.** Complete all independent work even if a grant is
pending. Update `feature-ledger.md` against each V01–V24 row, all 33 numbered
specs, and the Settings AC-01–AC-16 requirements. For each behavior, cite
the exact test assertion or executable result and its level (mock protocol,
real local, or signed native). Audit remaining open rows against source and
existing test names before adding new fixtures. In particular, inspect the
CLI flags and slash-command inventory, the focused Settings acceptance
cases, and the actual renderer entry points. Preserve qualified limitations
for external accounts, operating systems, and signature-specific grants.

Publish `docs/plans/full-product-test/report.md` in English with the final
test counts, reproducible commands, evidence links, defect table, and open
checks. Update the run log, relevant specs and manual, linked teaching page
46, roadmap, and changelog. Preserve the baseline and red logs. Verify links
and `git diff --check`. Keep the roadmap and goal open if a required behavior
still lacks evidence. Close the goal only after the requirements are audited
against current files and terminal test results.
