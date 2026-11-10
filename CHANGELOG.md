# Changelog

## 0.11.0 — 2026-11-07

A Cursor-style workspace column on the right of a session (`specs/031`, teaching page 29).

- Switcher: **Changes** (with +/−), **Browser**, **Terminal**, **Files**. Click to open, click again to close. Panes are registered in `DOCK_PANES`.
- Terminal shows the bash commands this session ran and their output. Files lists the workspace (`listWorkspace`) and opens a file in the pane.
- The session-bar Changes and Browser chips open the same panes.

## 0.10.0 — 2026-11-07

Manus-style research output, and the personal-assistant habits from Hermes and OpenClaw (`specs/030`, teaching page 28).

- `wide_research`: 2–8 independent items, each in its own subagent, written to `research/<question>.md`.
- `make_slides`: an HTML deck (arrow keys) and speaker notes under `slides/`. **Deliverables** in the session bar opens those files, plus screenshots, figures, and edits.
- User profile `~/.sun/memory/USER.md` (1,375 characters, every session) and `remember_user`. Daily notes under `~/.sun/memory/daily/`. Knowledge screen edits the profile.
- `/skill-name` loads an installed skill when no custom command uses that name. `session_search` finds past conversations.

## 0.9.0 — 2026-11-07

Cursor-grade coding, after a pass over each competitor's strongest points (`specs/029`, teaching page 27).

- `codebase_search`: local symbol lookup plus BM25 over source chunks. `@codebase <query>` attaches the hits. No network index.
- `.cursorignore` and `.sunignore`: `read_file`, `grep`, `glob`, listings, and `@file` refuse matching paths.
- Rules: `globs` on `.cursor/rules` and `.sun/rules` are included after a matching file is read, edited, or attached. `@rule <name>` and `@git` (status and diff stat).
- `/review`: the session diff is reviewed by the session model and logged as `review/report` (desktop Review button, CLI, bots). No file changes means no model call.

## 0.8.0 — 2026-11-07

Desktop and web UI in English and Simplified Chinese (`specs/028`, teaching page 26).

- Every page (Welcome, Sessions, Chat, Composer, Context, Changes, Browser, Knowledge, Extensions, Evolution, Intel, Settings, Automations, ⌘K palette) goes through `t()` / `tk()`. Simplified Chinese lives in `locale-zh-CN.ts`; missing keys fall back to English.
- Language: `ui.language` `system` | `en` | `zh-CN` (default system: OS/browser `zh*` → Simplified Chinese). Settings segmented control; **EN** / **中** on the left rail.
- Policy: new UI copy ships in both languages in the same change. `apps/desktop/test/i18n.test.ts` fails on unwrapped strings, missing Chinese, or drifted `{placeholders}`. `AGENTS.md` and `apps/desktop/AGENTS.md` record the rule.

## 0.7.0 — 2026-11-07

Automations and changed files, after a competitor analysis (`specs/027`, teaching page 25).

- Scheduling intent in plain English or Chinese (“every weekday at 9 …”, “每周一下午3点半…”, “remind me tomorrow at 3pm …”) becomes a **Schedule this?** proposal: create, create & run now, or just answer. Desktop card (editable title/time, next three runs), CLI `y/b/n`, bots `/yes /both /no`; `automations.detect`.
- Automations: ⏲ menu (list, on/off, run now, edit, history with links to runs, delete; form with plain-language schedule and live preview, mode, model, workspace, chats, catch-up), run history, catch-up of missed runs (24 h), notifications and bot delivery; `sun automations list|add|preview|run|pause|resume|edit|rm|history`; `/automations` in bots; `schedule_task` in all modes.
- Changed files: a card after every turn that edited files (A/M/D, +/−, Diff with line numbers or full File, Open, Copy path, Revert to before the turn), ▤ Changes session review with a file tree; revert is undoable and the model is told. CLI summaries, `/changes`, `/diff`, `/revert`, `sun changes`; bot “📝 N files changed”.
- Fix: diffs no longer count a final newline as an extra line.

## 0.6.0 — 2026-11-07

Context usage and conversation flow (`specs/026`, teaching page 24).

- Context usage for every conversation: `contextUsage` report of the next request (system prompt sections, tool definitions, compaction summary, user messages, attached files, images, recalled memories, assistant messages, tool results), context window and compaction threshold, provider-reported last request, suggestions. Desktop ring in the session bar with a report panel (Compact now, Export HTML), percent per session in the sidebar; `sun context [--json|--format html]`, chat and bot `/context`, `sun sessions` column.
- Steering: messages sent during a run reach the model at the next step (`steering: immediate | after-run`).
- Model-written session titles after the first run (`titles: model | first-message`); renames win.
- Desktop shortcuts: Esc stops, ↑ recalls the last message, ⌘N new session.
- Pin and archive sessions (sidebar groups, `sun pin|unpin|archive|unarchive`, `sun sessions --all`).
- Fix: `@path.` at the end of a sentence now attaches the file.

## 0.5.0 — 2026-11-07

UX absorbed from Claude Code, Codex, Cursor, Manus and Cline (`specs/025`, teaching page 23).

- Custom slash commands: Markdown in `.sun/commands`, `~/.sun/commands`, `.claude/commands`; frontmatter `description`, `argument-hint`, `mode`, `model`; `$ARGUMENTS`, `$1`…`$9`; CLI, desktop `/` menu, bots; `sun commands`.
- `@path` mentions attach files, folder listings and images; desktop path completion.
- Images: paste, drop or ⊕ attach in the desktop, `--image` and `@shot.png` in the CLI; stored in `~/.sun/attachments`; OpenAI `image_url` and Anthropic image blocks; text-only models get a note (`providers.<id>.vision`).
- Inline diffs on edit tool results (tool cards, exports).
- Cost: built-in pricing table + `pricing` config; session bar, `/cost`, CLI status line, `--json`/stream-json `costUsd`.
- Rewind: fork a session from any user message, optionally undoing file edits (desktop ↶ Rewind, `/rewind`).
- Export Markdown / HTML / JSONL and import JSONL (`sun export`, `sun import`, `/export`, desktop Export menu, ⌘K import).
- Desktop: OS notifications, ⌘K palette, full-text session search (`sun search`).
- `/compact` on demand (CLI, desktop, bots); `sun run --output stream-json`.
- Stream watchdog: silent model connections are abandoned and retried (`streamTimeouts`).

## 0.4.1 — 2026-11-07

- Post-edit diagnostics through language servers (LSP client: typescript-language-server, pyright, gopls, rust-analyzer), with the in-process TypeScript language service (global TypeScript when the project's has no JS API, e.g. TypeScript 7) and syntax checks as fallbacks.
- Linux sandbox fix: hidden files are covered with an empty regular file instead of `/dev/null` (bash could not read its rc file inside bubblewrap); bubblewrap verified end to end in a Debian container.

## 0.4.0 — 2026-11-07

Optimization plan, measured with a new eval suite. Teaching pages 17–22.

### Phase 0 — Measurement
- `evals/coding`: 36 validated tasks (standard + hard) with hidden tests and reference solutions; `sun eval validate | run | list | report | compare`; per-session telemetry; baselines.

### Phase 1 — Coding success
- Tolerant `edit_file` (CRLF, whitespace-insensitive with re-indent, closest-region errors), atomic Codex-style `apply_patch`, read-before-overwrite and stale-read refusal, post-edit syntax diagnostics.
- Checkpoints and undo (`sun undo`, `/undo`, desktop ↶ Undo); done gate running detected or configured verify commands.
- Capability gating (`Tool.available`), malformed tool-JSON repair (`wireArguments`), parallel read-only tool calls.
- Prompt-cache token accounting and hit rate; Anthropic `cache_control`; DashScope explicit cache markers (`cacheControl`).
- Repository map in Coding/Plan prompts and `repo_map`; Plan mode with plan approval; best-of-N (`sun run --best-of`, `sun eval run --best-of`).

### Phase 2 — Sandbox
- `ExecSandbox` for bash, jobs, verify, judging and the Python kernel: seatbelt, bubblewrap, Docker per session; network on/off/allowlist via a CONNECT proxy; hidden credentials and `~/.sun`; secret env scrubbing; `sandbox.autoApprove`; `sun sandbox status | test`; `--sandbox`.

### Phase 3 — Browser
- Raw CDP browser (local Chrome, `docker/browser` with Xvfb/noVNC/socat, any CDP endpoint); accessibility snapshots with refs; 9 browser tools; persistent profiles and `sun browser login`; desktop live view, takeover, noVNC.

### Phase 4 — Research agent
- `web_search` providers (Bing keyless, Tavily, Brave, Serper, Bocha, SearXNG, DuckDuckGo); readable Markdown and PDF `web_fetch` with paging; persistent `python` kernel; bounded parallel subagents (`maxParallelTools`); deliverables (desktop ▤ Files); prompt-injection guard (untrusted wrapping, scanning, `context/taint`, approval escalation).

### Phase 5 — Assistant efficiency
- Layered memory: core `MEMORY.md` + long-term items with per-message recall, background extraction, `memory_search`, `sun memory`, desktop list.
- Model router (`router.background`, `auto` fast/strong); DingTalk via `dws` (`dingtalk_read` / `dingtalk_write`); MCP presets for Gmail, Google Calendar, Outlook, Apple apps (`sun mcp presets | add`).
- Daily briefing (`sun briefing`, Settings, bot chats); file-watch and webhook triggers (`POST /trigger/<id>`); voice input (DashScope ASR / Whisper; desktop 🎙, `/voice`) and read-aloud; conversation efficiency metrics (`sun metrics`, Settings).

### Measured fixes found along the way
- Loop breakers: the whole current file after a second `old_string` miss; `[harness]` note on byte-identical repeated failing calls; refusals (unread/stale) hand over the current content and count it as read.
- Read-before-edit narrowed to whole-file overwrites (anchored edits may target unread files).
- Memory recall ignores English function words and stems lightly (a shopping task no longer recalls family facts); extraction keeps only what the user said or confirmed.
- Desktop: session sub-bar (sandbox, Files, Browser, tokens, Undo) and panels above the transcript.

### Results (36-task coding suite)
- qwen-flash: 55.6% → 66.7% pass; tool errors 25.8% → 4.5%; edit failures 40.6% → 8.5%; 95.5% of input cached.
- deepseek-chat: 100% (36/36) in the final runs; 89.9–93.8% of input cached.

## 0.3.1 — 2026-11-07

### Chat bots: Feishu, WeChat, WeCom
- Feishu/Lark bot: event callbacks with challenge, verification token, optional encryption, event dedupe, IM API replies.
- WeChat Official Account bot (incl. sandbox 测试号): signed GET verification, plain/safe-mode XML, `MsgId` dedupe, customer-service replies.
- WeCom self-built app bot: encrypted verification and messages, corp-id receiver check, `message/send` replies.
- Gateway bot routes accept GET (URL verification). Crypto pinned to the vendors' published test vectors.

## 0.3.0 — 2026-11-07

### Iteration 8 — Durable background jobs
- Process jobs run detached with on-disk record, log and exit status; the next host re-attaches and delivers results after a restart or crash; `jobs.killOnExit` opt-in.

### Iteration 9 — Approval race guard
- Per-showing `promptId`; stale/unknown/duplicate answers rejected (HTTP error via gateway).
- CLI: clears half-typed input and ignores answers typed before the prompt; explicit answers only.
- Desktop/web: approval buttons arm after 700 ms; scoped approvers (`registerApprover(scope)`).

### Iteration 10 — Remote gateway
- `sun serve --tls` with a self-signed certificate; non-loopback without TLS refused.
- Device tokens (`sun gateway token create|list|revoke`), hashed at rest; `sun remote add|list|use|off|remove` with certificate fingerprint pinning; `--remote` for session commands.

### Iteration 11 — Chat bots
- Telegram (long polling), DingTalk outgoing robot (signed callbacks, sessionWebhook replies), generic webhook (`?wait=1`), running inside the gateway with allowlists, per-chat sessions, commands and approvals in chat.

## 0.2.0 — 2026-11-07

### Iteration 2 — Context budgets
- Separate prompt budgets for global and project rules (`rules.globalMaxChars`, `rules.projectMaxChars`).
- Per-model context windows (built-in table + `modelContext`), `compaction.buffer` (default 25%).
- After a model switch, the previous model summarizes history the new model cannot hold; falls back to the new model with a trimmed transcript.

### Iteration 3 — Worktree sessions
- `createSession({ worktree: true })`, `sun --worktree`, desktop toggle; status, diff, squash/merge, discard; Changes panel.

### Iteration 4 — Background jobs
- `bash` `background: true`, `job_status`, `job_kill`; slow MCP calls promoted after `jobs.promoteAfterMs`; results delivered as `source: job` messages; lost jobs marked on restart; `sun run` waits for jobs.

### Iteration 5 — Gateway and web UI
- `sun serve` (HTTP + SSE, token auth, localhost), `sun gateway status|url|install|uninstall` (launchd KeepAlive).
- CLI and desktop attach to a running gateway; browser web UI via the same renderer; per-session approval mode.
- Shared method table `hostMethods` for desktop IPC and HTTP.

### Iteration 6 — Hybrid knowledge
- Optional BM25 + embedding retrieval with reciprocal rank fusion, embedding cache, BM25 fallback; `sun kb index`; Settings toggle.

### Iteration 7 — Packaged macOS app
- `pnpm desktop:package` / `desktop:install`; self-contained main bundle; offline packaging with the local Electron; ad-hoc signing; app icon.
- `augmentPath()` so Finder-launched apps and launchd jobs find `node`, `npx`, Homebrew and nvm tools.

## 0.1.0 — 2026-11-07

### M0 Foundations
- `AGENTS.md` rules (English-only, spec-first, definition of done), vision spec, plan.

### M1 Core runtime
- Append-only JSONL session log with `deriveMessages()` and tool-call pairing.
- OpenAI-compatible and Anthropic providers with streaming, tool calls, reasoning, usage.
- Error taxonomy (quota, rate_limit, auth, network, context_length) with retry, fallback chain, durable pause, resume on the same or another model, auto-resume.
- Agent loop with approvals, abort, queued messages, max steps, context compaction.
- Built-in tools and approval policy (`suggest`, `auto-edit`, `full-auto`).
- `sun` CLI.

### M2 Extensions, knowledge, modes
- Rules loader (AGENTS.md hierarchy, CLAUDE.md, `.sun/rules`, `.cursor/rules`, specs index); `sun init`.
- Skills with progressive disclosure (Claude-compatible locations), MCP client, ESM plugins, shell hooks.
- Personal KB (BM25, CJK bigrams), reserved company KB provider, memory.
- Modes: coding, agent, assistant; subagents; scheduled tasks.

### M3 Desktop
- Electron + React app with all screens; secure IPC; live streaming; E2E smoke test.
- Fixed: chat dropped batched live events; snapshot/live merge race.

### M4 Intel and evolution
- Daily harness intel (14 sources) with LLM analysis, HTML reports, pending-analysis recovery.
- launchd schedule using a self-contained CLI bundle in `~/.sun/bin`.
- Credential env import from `~/.sun/.env` and shell rc files (parsed, never executed).
- Evolution proposals (memory, skill, rule, feature) with reflection and journal.
- Fixed: local dates for reports; changelog via GitHub contents API; idea cap; reflection false positives.

### Iteration 1 (from intel 2026-11-07)
- Fail-closed approvals: headless runs and `denyInsteadOfPrompting` deny with a reason instead of hanging.
- Hooks: `onFailure: "block"`.

### Verification fixes
- CLI: agent/assistant sessions default to `~/.sun/workspace` (specs/007) instead of the current folder.
- CLI chat: buffered line input, so piped and fast-typed messages are not dropped.

## Unreleased — Settings design and execution harness

- Added source-backed project/competitor research, full 29-entry screenshot mapping, spec 032, ADR 0010 and 15 bounded implementation tasks.
- Added offline plan-integrity checks with negative tests and Vitest integration; documented configuration/replay/native capability contracts and fresh-model handoff.
- T01 added offline fixtures for legacy config, malformed data, synthetic credentials, attachment replay and simulated native capture failures.
- T02 added revisioned settings with atomic replacement, a redacted field allowlist, recovery diagnostics, and a private audit. Desktop, web, and CLI use the validated save path.
- T03 added versioned capability discovery across desktop, web, and CLI. Plugin reload now revokes stale tool registrations and failed activation leaves no partial contributions.
- T04 added searchable English and Simplified Chinese settings sections, deep links, draft guards, and explicit section saves. The translation scanner now includes nested renderer files.
- Added isolated settings qualification fixtures and captured the post-T04 live runs. DeepSeek passed eight of nine attempts.
- T05a added the everyday preference schema, persisted defaults, host mode selection, and memory and voice switches.
- T05b applied appearance and startup preferences, remapped app shortcuts, deduplicated live notifications, and added cancellable voice input. Global shortcut writes preserve the previous binding if the OS rejects a replacement.
- T05c exposed bilingual personal settings and separated standing instructions from learned core memory. Desktop Mini opens or stops the active run through the host, and session usage distinguishes priced estimates from unknown prices.
- T06a made HTML transcripts inert and added credential redaction to Markdown, HTML, and JSONL exports.
- T06b added portable session bundles with streamed validation, atomic import, image replay, and CLI and gateway transfer. Imported history retains its transcript without inheriting execution grants or pending actions.
- T06c added bilingual archive and data controls, categorized storage, revision-checked cleanup, recoverable trash, and opt-in retention. Active work and shared attachments remain protected.
- T07a and T07b added digest-reviewed shell hooks, bounded and cancellable execution, redacted diagnostics, and CLI fixture preview and execution. Existing hooks require review.
- T07c added bilingual hook diagnostics, batch trust review, and fixture preview, execution, and cancellation in desktop and web settings.
- T07c also added static plugin manifest inspection, revision-checked enable and disable, live drain state, and lifecycle audit records across desktop, web, and CLI.
- T08 added gateway identity and protocol handshake, live device revocation, bounded retry receipts, and HttpOnly browser sessions.
- T08 added a bilingual desktop connection picker with certificate confirmation and separate local preference writes. Desktop and web pause host mutations until a disconnected client refreshes.
- T09 added durable structured review requests and findings, a configurable completion gate, and read-only worktree inspection using a temporary Git index.
- T09 added explicit worktree bases, clean-only discard and cleanup previews, merge recovery, and reviewed one-time worktree setup.
- T10 added browser origin review in Settings and CLI, exclusive profile ownership, and single-viewer takeover with tab and frame generation checks. One-time upload approval and bounded downloads work with local, Docker, and explicitly delegated external Chromium.
- T11 adds opt-in macOS Appshots with a private capture preview, opaque redaction, a global shortcut, and digest-verified session replay. Signed macOS acceptance verified capture, cancellation, and persistence of only the prepared image.
- T12 adds scoped native macOS Computer Use. App grants, an exclusive session lease, runtime approval, durable dispatch receipts, and emergency stop govern native Accessibility observations and actions.
- T13 adds Keychain-backed website passwords on macOS. The private sign-in window binds fill to the reviewed HTTPS origin and keeps credentials and login state outside agent browsing and gateway views.
- T14 adds reviewed shell jobs on the current host, Local Docker, and pinned gateways. Durable provider receipts recover job state after a lost reply or restart, and output stays bound to its original target.
- T15 records cross-surface and signed macOS acceptance. The release checker requires nine first-attempt passes against the current public handoff prompt and frozen fixtures. The final DeepSeek trial passed all nine attempts.

## Unreleased — Product verification fixes

- The app icon is a playful sun face, rendered from `apps/desktop/scripts/make-icon.cjs`.

- `sun resume` uses the same exit codes as `sun run` for success, pause, and failure.
- MCP inspection releases the handshake deadline and closes failed connections so the CLI exits promptly after listing tools.
- A long task plan scrolls independently above the chat transcript, keeping approval controls reachable in short desktop and web windows.
- DingTalk and generic webhook callbacks keep denied requests from overwriting an authorized chat's reply address. Concurrent synchronous webhook callers receive an explicit same-chat conflict.
- CLI chat buffers piped input and observes end-of-file before connecting to a gateway.
- Intel and briefing lookups accept only valid calendar dates. Briefings reference the completed Intel report from the correct directory.
- The chat header wraps session controls to keep worktree actions reachable in narrow windows.
- Python cells cancelled before dispatch leave the workspace and kernel state untouched.
- `sun sandbox test` returns failure when its shell fails or either required probe produces an unexpected result.
- Ordinary image thumbnails render on gateway web. The gateway treats a JSON `null` metadata argument as absent; Appshot digest checks are unchanged.
- A failing CLI chat slash command, such as `/reflect` without proposals, prints the error and keeps the session open.
- Quitting the desktop app waits for host disposal. The managed Chromium exits before its profile is released, so it no longer outlives the app. A single `SIGTERM` still quits the app after disposal.
- A managed Chromium that misses the DevTools startup deadline is stopped before the error is reported, instead of being left running.
- New regression coverage: every CLI slash command and management command, persisted eval telemetry, every bot command, compatibility skill precedence, and renderer Deny, Always allow, Deliverables, Review and Undo. The [verification report](docs/plans/full-product-test/report.md) lists the results.
