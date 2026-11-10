# Verification run log

This is the running record for the [full product verification plan](plan.md).
The feature-by-feature result and remaining coverage are recorded separately
from the exit status of a suite.

## Initial baseline

| Command or fixture | Observed result | Evidence |
| --- | --- | --- |
| `pnpm test --reporter=verbose` | 43 files, 317 tests passed, 1 skipped. The Docker sandbox unit case is opt-in. | [Assertions](evidence/baseline-tests.txt) |
| `pnpm build` and `pnpm typecheck` | Core, built and bundled CLI, desktop renderer and native helpers built. All workspace typechecks passed. | [Build](evidence/baseline-build.txt), [types](evidence/baseline-typecheck.txt) |
| Plan checker and negative tests | 29 screenshot dispositions, 15 tasks and 12 checker tests. | [Integrity](evidence/baseline-plan-integrity.txt) |
| `sun eval validate`, Settings offline validator | Coding fixtures 36/36. All three Settings reference patches pass and untouched workspaces fail. | [Coding](evidence/offline-coding-eval.txt), [Settings](evidence/offline-settings-eval.txt) |
| Desktop and web Settings, pinned gateway | Bilingual forms, validation and recovery, durable storage, grants, reviewed jobs and TLS revocation/recovery. | [Settings](evidence/e2e-settings.txt), [pinned gateway](evidence/e2e-settings-remote.txt) |
| Browser and Docker | Real external and Docker Chromium, reviewed transfers, cancelled container and hook cleanup. | [Browser](evidence/e2e-browser-backends.txt), [jobs](evidence/e2e-execution-docker.txt), [hooks](evidence/e2e-hooks-docker.txt) |
| `SUN_TEST_DOCKER=1 pnpm exec vitest run packages/core/test/sandbox.test.ts --reporter=verbose` | Nine passed, including real Docker and Seatbelt. Bubblewrap argument construction also passed. | [Sandbox](evidence/sandbox-real-docker.txt) |
| Authorized native packages | Actual Accessibility actions and refusals, private Keychain and HTTPS session, actual Appshot capture, masking and replay. | [Computer](evidence/e2e-computer.txt), [credentials](evidence/e2e-credentials.txt), [Appshot](evidence/e2e-appshot.txt) |
| Appshot attempt in the Computer Use bundle | macOS required a separate screen-recording grant for this bundle. Appshot succeeded in its previously authorized bundle. The operating-system permission differs by signed app. | [Permission refusal](evidence/e2e-appshot-current.txt) |

## Defects and corrections

| ID | Reproduction and cause | Correction | Regression |
| --- | --- | --- | --- |
| D01 | A loopback provider returns HTTP 400. The CLI emits `error`, then exits with `3` for `resume`. The run and resume commands used different status mappings. | Share one mapping. The runtime spec now records the public CLI contract. | [Failure](evidence/cli-first.txt), [passing CLI cases](evidence/cli-regression-final.txt) |
| D02 | `sun mcp` opens the fixture stdio server and fails a 15-second process deadline. The 30-second handshake timer remained active after the connection settled. | Clear the timer in `finally`. Close a client on failed initialization or tool discovery and retain only ready clients. | [Timeout](evidence/mcp-first.txt), [fast CLI exit](evidence/cli-regression-final.txt), [stdio, HTTP and SSE](evidence/mcp-transports.txt) |
| D03 | A normal pointer click on an armed gateway approval times out. The sticky plan inside the transcript intercepts the pointer in a short window. | Keep the plan pinned in a bounded scroll area above the transcript on both renderer surfaces. | [Pointer interception](evidence/chat-product-fourth.txt), [passing desktop and web clicks](evidence/chat-product-regression.txt) |
| D04 | Two synchronous webhook requests to the same chat share and overwrite one collector. The second request waits rather than reporting a conflict. | Return 409 for other authorized requests while a synchronous request owns a chat's replies. | [Failure](evidence/webhook-first.txt), [bot regression](evidence/bot-final-regression.txt) |
| D05 | A denied generic webhook or DingTalk callback replaces a previously authorized reply destination. Both isolated callback fixtures received an authorized synthetic reply at the denied endpoint. | Produce the identity response before touching stored routing. Send it only to the current request. | [Generic callback](evidence/webhook-denied-first.txt), [DingTalk callback](evidence/dingtalk-denied-first.txt), [bot regression](evidence/bot-final-regression.txt) |
| D06 | Piped CLI chat through a real gateway could reach stdin EOF during attachment and throw `readline was closed`. The iterator and the EOF listener were initialized after asynchronous connection work. | Install both before awaiting the gateway. | [Failure](evidence/cli-gateway-regression.txt), [passing real gateway chat and isolated launch-agent metadata](evidence/cli-gateway-confirmed.txt) |
| D07 | The authenticated report RPCs accepted date arguments with parent-directory components. A fixture outside the report folders was readable and re-analysis could replace it. | Validate actual `YYYY-MM-DD` dates before resolving any report path, and list only date-named regular Intel reports. | [Failure](evidence/daily-reports-first.txt), [passing gateway, Intel and assistant cases](evidence/daily-reports-regression.txt) |
| D08 | A completed Intel report existed for the briefing date but the first model request did not reference it. The prompt checked an obsolete directory. | Resolve the report with the shared Intel path builder. | [Failure](evidence/daily-reports-first.txt), [passing model request check](evidence/daily-reports-regression.txt) |
| D09 | At a fixed time when the UTC and local dates differed, `sun intel analyze` opened the UTC raw filename and failed. | Use the same local-day helper as Intel report creation. | [Wrong-date failure](evidence/cli-intel-worktree-first.txt), [passing CLI date and worktree cases](evidence/cli-intel-worktree-regression.txt) |
| D10 | At the gateway's narrow viewport, the session controls overlapped the worktree chip. A real click hit the controls instead of opening the diff. | Let the header controls wrap and constrain long title and workspace chips. | [Pointer interception](evidence/renderer-pages-third.txt), [passing desktop and gateway worktree actions](evidence/renderer-header-regression.txt) |
| D11 | A Python cell passed an already-aborted signal still wrote a file. The abort listener only observed future events. | Check for cancellation before starting or writing to the kernel. Clear each settled cell's pending entry. | [Unexpected file effect](evidence/python-cancellation-effect.txt), [passing pre-abort, timeout, and active-abort checks](evidence/python-cancellation-regression.txt) |
| D12 | The CLI shell self-test exited `0` when the shell returned an error before either probe ran. | Require successful completion and both expected observations. Quote the probe path, use a unique test ID, and clean temporary resources. | [False success](evidence/cli-sandbox-first.txt), [passing success and failure probes](evidence/cli-sandbox-regression.txt) |
| D13 | Gateway web persisted and sent a normal PNG but could not render its thumbnail. The gateway treated serialized `null` as Appshot metadata. | The gateway `readAttachment` handler maps `null` to an absent argument (spec 025 Decision). Appshot digest and ownership checks are unchanged; wrong metadata is still rejected. | [Renderer failure](evidence/renderer-attachments.txt), [focused failure](evidence/gateway-image-first.txt), [reproduced at takeover](evidence/d13-repro.txt), [focused pass](evidence/d13-focused-green.txt), [gateway, capture and import suites](evidence/d13-gateway-suite.txt), [Electron and gateway thumbnails](evidence/post-d13-chat-product-third.txt) |
| D14 (fixture) | After D13, the chat fixture failed twice with `CDP Page.navigate timed out` in Electron. The fixture launches Electron with an isolated `HOME`; headless Chrome 156 then waits for a login keychain before its first request. With the real `HOME` the same navigation succeeds in milliseconds. | The fixture launches Chrome through a test-only wrapper that adds `--use-mock-keychain`. Product launch flags are unchanged because the flag would weaken cookie encryption for real profiles. | [First](evidence/post-d13-chat-product.txt), [second](evidence/post-d13-chat-product-second.txt), [isolation probe](evidence/d14-keychain-probe.txt), [pass](evidence/post-d13-chat-product-third.txt) |
| D15 | A new built-CLI test drove every chat slash command. When `/reflect` received a reply without JSON proposals, the error escaped the chat loop and the process exited 1, dropping the remaining input and `/exit`. | A failing slash command prints `✗ /<command> failed: …` and keeps the session (spec 025 Decision). | [First observation](evidence/d15-slash-reflect-first.txt), [handled error transcript](evidence/d15-slash-commands.txt), [pass](evidence/d15-slash-commands-regression.txt) |
| D16 | Quitting the desktop app could leave its managed Chromium running under `launchd`, and host disposal returned before Chromium exited. The orphan kept writing to its profile; Settings and chat fixture cleanup failed with `ENOTEMPTY`. Electron's `before-quit` did not wait for `host.dispose()`, and browser disposal sent `SIGTERM` and released the profile immediately. | `before-quit` waits for disposal (bounded to five seconds) before quitting. Browser disposal waits for the process to exit, then escalates to `SIGKILL`, before releasing the profile (spec 004 and 022 Decisions). A unit case and the chat fixture assert that no process still uses the profile. See D17 for a follow-up. | [Observed orphans](evidence/d16-orphan-observed.txt), [Settings teardown](evidence/post-d13-settings.txt), [gateway profile teardown](evidence/release-chat-product.txt), [intermittent pre-fix pass](evidence/d16-orphan-chromium-first.txt), [unit failure with old disposal](evidence/d16-dispose-first.txt), [unit pass](evidence/d16-dispose-regression.txt), [Settings pass](evidence/closing-settings.txt) |
| D17 | Introduced by the first D16 fix. After the Computer Use preflight on the final package, the signed app was still running: one `SIGTERM` no longer quit it. Logging showed that the quit request issued right after disposal closed the windows, then Electron emitted `window-all-closed`, which does not quit on macOS, instead of `will-quit`. The pre-D16 package exited normally. | Request the quit again in a later event-loop task (spec 004 Decision). The chat fixture now sends one `SIGTERM` to a fresh app and requires it to exit. | [Observation and probes](evidence/d17-sigterm-first.txt), [probe script](evidence/d17-sigterm-probe.mjs), [fixed probe](evidence/d17-sigterm-probe-fixed.txt), [final chat run](evidence/signoff-chat-product.txt), [no leftover processes](evidence/signoff-leftover-processes.txt) |
| D18 | A headless Chrome from the first post-D13 unit run was still running about 32 minutes later under `launchd`. When a launch misses the 10-second DevTools port wait, `startLocal` threw without stopping the spawned process, and a retry replaced the only reference to it. | Stop the spawned Chromium (bounded `SIGTERM`, then `SIGKILL`) before reporting the launch error, sharing the disposal helper (spec 022 Decision). A unit case uses a stalled fake launcher. | [Orphan](evidence/d18-orphan-observed.txt), [unit failure](evidence/d18-stalled-launch-first.txt), [browser suite pass](evidence/d18-regression.txt) |

The intermediate CLI rerun after the MCP fix exited promptly but the fixture
expected the literal word `ready`. The CLI displays a status mark and the
discovered tool names. The corrected assertion checks the tool list and still
fails when the process misses its deadline. [Intermediate run](evidence/cli-regression-mcp.txt)

The desktop chat fixture initially collided with its Electron profile on the
case-insensitive file system. It now separates workspace and profile names.
The Changes and Terminal checks scope their selectors to the file tree, diff,
and command output. Initial output is preserved under `evidence/chat-product-*`.
The browser fixture grants the origin through Settings in addition to
approving its tool call. Its wait includes browser startup and protocol
timeouts. The real PTY fixture relays through Python because macOS `script`
refuses the Node child-process socket used by this test harness.

The first CLI gateway fixture tried to probe an authenticated health route
without a token. The corrected fixture verifies that unauthenticated health
is rejected and then uses only its disposable owner's token. It does not
print that token. The current native package passed [signature and build](evidence/package-post-fixes.txt),
[Appshot denial and masking](evidence/package-preflight-appshot.txt), and
[Accessibility denial](evidence/package-preflight-computer.txt). Positive
native acceptance on the new signing identity requires separate OS grants.

## Post-handoff observations

These failures were preserved and investigated but did not reproduce as
product defects.

- In the first post-D13 unit run, three managed-Chrome cases in
  `browser.test.ts` failed with `Chrome did not open a DevTools port` after
  the 10-second startup wait. The full parallel suite, including Docker, was
  loading the machine. The file passed alone (12/12) and in every later full
  run. [Failure](evidence/post-d13-unit.txt), [isolated pass](evidence/post-d13-browser-unit-isolated.txt).
  The slow start itself was environmental, but the Chrome left behind by the
  timed-out launch was a product leak, fixed as D18.
- One closing chat run timed out on the hover-only pin button in a visible
  Electron window. Later runs passed the same step.
  [Failure](evidence/closing-chat-product.txt), [rerun](evidence/closing-chat-product-second.txt)
- `sun <unknown>` prints help and exits 0. No spec defines this case, so it
  is recorded without a change.

## Coverage added during the audit

- Built CLI: every chat slash command in one piped session, and the
  management commands (`evolve reflect|list|accept|reject`, `context --format
  html`, `metrics`, `gateway token create|list|revoke`, `browser status`,
  `browser permissions set`, `hooks list`, `trigger list`, `remote list`,
  `doctor`). The eval case now checks persisted per-task telemetry.
- Bots: every documented chat command through the bridge, including denial,
  quota pause and `/resume`, custom commands and an unauthorized user.
- Skills: project, `.claude/skills` and `.agents/skills` precedence, and
  compatibility disabled.
- Renderer: Deny and Always allow on approval cards, Deliverables, the Review
  button, Undo, and the absence of a managed Chromium after quit.

## Remaining work

None. After the owner's grants, the final package passed the positive
[Appshot](evidence/signoff-appshot.txt), [Computer Use](evidence/signoff-computer.txt)
and [Keychain](evidence/signoff-credentials.txt) runs. See the [report](report.md).
