# Changelog

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
