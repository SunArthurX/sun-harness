# Feature evidence ledger

This ledger tracks the [verification plan](plan.md) against current files
and the final regression set of 2026-11-10 (`evidence/signoff-*`). The
verbose unit log names every executed case by file and title. Each row lists
its evidence level separately, so an offline protocol test never stands in
for an account or operating-system result.

Evidence levels:

- **Mock**: scripted provider or loopback protocol fixture in a unit test.
- **Local**: a real local process or surface. This covers the built CLI, the
  Electron and gateway web renderers, real Chromium, Git, Docker, Python, or
  Seatbelt.
- **Signed**: an ad-hoc signed macOS bundle with the OS grants it requires.
- **Vendor**: a live third-party account. This level is used only where stated.

Final suites: [unit](evidence/signoff-unit.txt),
[CLI](evidence/signoff-cli.txt), [chat renderer](evidence/signoff-chat-product.txt),
[Settings](evidence/signoff-settings.txt), [pinned gateway](evidence/signoff-settings-remote.txt),
[browser backends](evidence/signoff-browser-backends.txt), [Docker jobs](evidence/signoff-execution-docker.txt),
[Docker hooks](evidence/signoff-hooks-docker.txt), [smoke](evidence/signoff-smoke.txt),
[package](evidence/signoff-package.txt). The [run log](run-log.md) lists defects.

| ID | Evidence (test level) | Disposition |
| --- | --- | --- |
| V01 | Mock: `agent`, `log`, `providers` cover tool sequencing, paired replay, torn-tail recovery, quota/auth/network classification, backoff and fallback for both preset protocol groups (OpenAI-compatible and Anthropic). Local: CLI `run reads stdin…`, `quota pauses with exit 3…`, `a terminal provider error returns exit 1…`, `interactive command loop…`, and `serve owns CLI sessions…` (real gateway discovery). Chat renderer: streaming, Stop closes the provider request, quota pause, then **Switch & resume** on Electron and gateway web. | Verified. Live vendor accounts are outside the synthetic scope. |
| V02 | Mock: `context` covers sections, budgets, and [smaller-model compaction](evidence/context-budget.txt), as well as titles, pins and archive. `ux` covers cost and cache. Local: CLI `context --json`, `context --format html` and `/context`, plus `pin/archive/search`. Renderer: context panel, `contextReportHtml`, pin and unpin, and sidebar search on both surfaces. | Verified. |
| V03 | Mock: `extensions` covers the AGENTS/CLAUDE hierarchy, `.sun/rules`, `.cursor/rules`, specs, plugins and fail-closed hooks. `ux` covers `.claude/commands` and the new `.claude/skills`/`.agents/skills` precedence case. `mcp-http` covers HTTP and SSE with reconnect. Local: CLI custom commands, skills, `mcp` stdio, mail/calendar presets and `hooks list`. Settings covers hook review, preview and cancel, and plugin drain on both surfaces. Docker hooks verify the real sandbox. | Verified. |
| V04 | Mock: `extensions`, `hybrid`, `assistant`, `assist-manus` and `settings-preferences` cover CJK BM25, mocked embeddings and fusion, memory, profile and daily notes. Local: CLI CJK `kb`/`memory`, company KB bearer token and remote denial, and `evolve accept` writing memory. Renderer: knowledge write and CJK search, plus the memory route on both surfaces. | Verified. |
| V05 | Local: chat renderer visits all seven rail screens, the four dock panes, ⌘K, EN/zh-CN, and both window sizes (gateway at 920×630). Settings covers bilingual search, deep links, Back, keyboard navigation, remapped shortcuts and layout at 1440 and 800 px. Mock: `i18n`, `settings-navigation`. Smoke screenshots every screen. | Verified on macOS. |
| V06 | Mock: `intel` and `extensions` cover parsing, dedup, quota, local dates, ranking, Mermaid and launch-agent metadata. Local: CLI intel list/show/retry and `evolve reflect/list/accept/reject`. Renderer: Intel listing and analysis, Evolution accept/reject. | Verified. Real feeds are out of scope. |
| V07 | Mock: `agent`/`gateway` cover suggest, deny, allow_always, stale and duplicate replies, and plan read-only. Local: CLI noninteractive denial and the [real PTY guard](evidence/cli-pty-regression.txt). Renderer: Allow, **Deny** and **Always allow** with the follow-up call running unprompted, on both surfaces. Seatbelt and Docker are [real](evidence/sandbox-real-docker.txt). Bubblewrap ran in a [disposable Linux container](evidence/linux-bwrap-network.txt). | Verified. Bubblewrap is verified only in a container with namespace capabilities. |
| V08 | Mock: `worktree`, `coding`, `cursor-coding`. Local: CLI worktree list/status/diff/merge/preview/cleanup in real Git. Renderer: diff, squash merge and discard on both surfaces. Settings: protected dirty worktree, stale cleanup and one-time setup. | Verified. |
| V09 | Mock: `jobs`, `execution-targets` cover durable delivery, ordering, orphans and stop. Local: Docker job cancellation, pinned remote job recovery, and a renderer-launched reviewed job (Settings). | Verified. |
| V10 | Mock and loopback: `gateway`, `remote` cover tokens, TLS pins, RPC allowlist, receipts, revoked streams and the D13 `null` argument. Local: CLI `serve` discovery, automatic attachment and launch-agent metadata, plus `gateway token create/list/revoke`. Pinned TLS gateway covers revocation, reconnect and output recovery. | Verified. |
| V11 | Local: build, typecheck and the bundled CLI entry. Signed: a disposable package from the final build, ad-hoc signed and verified with `--deep --strict`. Its asar `out/main`, `out/preload` and `out/renderer` are identical to the build, and both native helpers are present ([package](evidence/signoff-package.txt)). | Verified for structure and signature. OS grants: see V21–V22. |
| V12 | Mock and loopback: `bots`, `bots-cn` cover all six adapters, signatures, vendor test vectors, retries, allowlists and reply isolation (D04/D05). The new bridge case answers every documented command. | Verified without external recipients. |
| V13 | Local: 36/36 coding fixtures and all three Settings fixtures are valid. The CLI eval case runs a hidden check and compares runs; persisted per-task telemetry is asserted. Mock: best-of-N in real worktrees. The T15 live qualification is enforced by `qualifiedRelease()` against the current prompt and suite hashes ([plan check](evidence/signoff-plan-integrity.txt)). | Verified. The live result is the dated T15 DeepSeek run; it was not re-paid. |
| V14 | Mock: `edit`, `coding`, `verify`, `cursor-coding`, `lsp`, `worktree`. Local: CLI `/changes`, `/diff`, `/revert`, `/undo`, `/review` (an invalid reply is recorded as `failed`, with no findings accepted). Renderer: Review button and Undo. Settings: structured findings and staleness. | Verified. |
| V15 | Local: `browser` uses real headless Chrome (navigation, refs, redirects, subframes, takeover, transfers, D16 disposal, and the D18 stalled launch). Backends cover external and Docker Chromium with noVNC/RFB. The renderer live view covers takeover and handback on both surfaces. | Verified. |
| V16 | Mock and local: `research` and `search-providers` cover every adapter's request and fallback, HTML/PDF, taint and deliverables. The [real Matplotlib figure](evidence/python-real-figure.txt) and the D11 cancellation are verified. Renderer: Deliverables panel lists the produced file. | Verified. Opening a deliverable is an OS `openPath` call and was not clicked. |
| V17 | Mock: `assistant`, `automation`, `voice-cancellation`, `settings-preferences`. Local: CLI automations, mail/calendar presets without accounts, voice with a controlled audio source, and `metrics`, `trigger list`. Renderer: automation create/run/history/delete. | Verified with synthetic connectors. Real mail and calendar accounts and a physical microphone are out of scope. |
| V18 | Local: CLI piped chat, run, stream JSON, exit codes, image bytes, JSONL and bundle, every chat slash command (D15), and custom commands and skills. Renderer: `@` file mention and image attachment with thumbnail on both surfaces (D13). | Verified. The renderer **Export…** menu calls `exportSession`, which is verified through RPC and CLI; the browser download was not exercised. |
| V19 | Settings E2E and contract tests cover AC-01–AC-04 (below), rerun after every fix. | Verified. |
| V20 | AC-05–AC-10 below. | Verified. |
| V21 | Browser grants and transfers: Local on both renderers and real backends. Appshot, Signed: on the granted final package ([run](evidence/signoff-appshot.txt)), capture of one fixture window, opaque crop and mask, cancel without persistence, and prepared-only send. The same bundle passed the [ungranted boundary check](evidence/signoff-appshot-boundary.txt). | Verified on the final signature (cdhash `3658f97b…`). |
| V22 | Signed, on the granted final package: [Computer Use](evidence/signoff-computer.txt) covers Accessibility, approved press and edit, receipts, and denials after stale observation, foreground change, emergency stop and grant revocation. [Keychain](evidence/signoff-credentials.txt) covers persistence across restart, request-only fill, and no password in other surfaces. The [ungranted preflight](evidence/signoff-computer-preflight.txt) denied control. Settings E2E confirms web excludes native methods. | Verified on the final signature. |
| V23 | Mock: `execution-targets`. Local: Docker isolation and cancellation, pinned remote recovery, and the reviewed renderer job. | Verified. |
| V24 | Plan checker (29 screenshots, 15 tasks), 12 checker tests, offline qualification validator, linked manuals and teaching pages. | Verified. |

## Settings acceptance (spec 032)

| AC | Evidence (test level) |
| --- | --- |
| AC-01 | Mock: `settings-contract` (legacy fixtures), `settings-store`, `settings-service` (unknown keys survive, invalid edits return field errors). Local: Settings shows configuration recovery and preserves malformed bytes. |
| AC-02 | Mock: `settings-store` (same-revision writers, interrupted save, stale lock ownership). Local: Settings conflict and discard handling. |
| AC-03 | Mock: `settings-service` (redacted DTOs, origins, audit of key names). Local: Settings shows that CLI, Electron and gateway share capability IDs and reject version mismatch and native-only routes. |
| AC-04 | Local: Settings covers bilingual search, keyboard selection, direct routes and Back at 1440 and 800 px. Mock: `settings-navigation`. |
| AC-05 | Mock: `settings-preferences` (quiet hours, repeated and skipped hours, shortcuts, unknown pricing). Local: notification dedupe, denied audio, shortcut remap failure, and preference survival across restart ([pinned gateway](evidence/signoff-settings-remote.txt)). |
| AC-06 | Mock: `settings-import`, `settings-storage`. Local: JSONL and bundle import, archive restore, stale cleanup rejection, and trash on both surfaces. CLI: bundle round trip. |
| AC-07 | Mock: `settings-hooks`, `settings-capabilities`, `extensions`. Local: hook preview, cancel and stale trust; plugin manifest and drain; real Docker timeout and process-tree kill. |
| AC-08 | Loopback TLS: certificate pin, revocation, reconnect without duplicate sends, and local-versus-remote preferences ([pinned gateway](evidence/signoff-settings-remote.txt)). |
| AC-09 | Mock: `cursor-coding` review digests. Local: persisted review, findings filter and staleness. CLI `/review` records an invalid reply as `failed` with no findings. |
| AC-10 | Mock: `worktree`. Local: protected dirty worktree, stale cleanup rejection, and CLI preview parity. |
| AC-11 | Local: `browser` (origins and actions, redirects, stale frames, takeover). Real backends and both renderers. |
| AC-12 | Mock: `settings-capture`. Signed: final package capture, preview edits, cancel and prepared-only send ([run](evidence/signoff-appshot.txt)). Web: Appshot capture is explained as unavailable. |
| AC-13 | Mock: `settings-computer`. Signed: final package with OS permission, app grant and runtime approval; one lease and emergency stop ([run](evidence/signoff-computer.txt)). |
| AC-14 | Mock: `settings-credentials` (opaque references, revoked grants, no plaintext fallback). Signed: final package Keychain run ([run](evidence/signoff-credentials.txt)). |
| AC-15 | Mock: `execution-targets`. Local: Docker labeled local, pinned remote job ID persisted and reconciled. No paid target exists. |
| AC-16 | Plan checker, task evidence, manuals, teaching pages 30–46, roadmap and changelog; mock tests need no network. |

## Numbered specs

Every numbered spec maps to at least one row: 000, 001 and 007 to V01; 009
and 026 to V02; 002 to V03; 003, 013 and 030 to V04; 004, 025, 027, 028 and
031 to V05; 005, 006 and 024 to V06; 008, 016 and 021 to V07; 010 and 029 to
V08; 011 and 015 to V09; 012 and 017 to V10; 014 to V11; 018 to V12; 019 and
020 to V13; 022 to V15; 023 to V16; 032 to V19–V24.
