# Changelog

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
