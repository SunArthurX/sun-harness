# Changelog

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
