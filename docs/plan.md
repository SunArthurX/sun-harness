# sun-harness — Plan

Status legend: `[ ]` todo, `[~]` in progress, `[x]` done.

## Method

1. Derive the minimum harness from first principles (see `specs/000-vision.md`): model, context, tools, loop, log, policy.
2. Build that MVP with tests.
3. Loop: research what other harnesses do (intel) → pick the highest-value gap → spec it → build → test → document → repeat.

## Architecture

```mermaid
flowchart LR
  subgraph UI
    D[Desktop - Electron + React]
    C[CLI - sun]
  end
  D -- IPC --> H
  C --> H
  subgraph Core [packages/core]
    H[HarnessHost] --> A[Agent loop]
    A --> P[Providers]
    A --> T[Tool registry]
    A --> L[(Session JSONL log)]
    A --> Pol[Approval policy + hooks]
    Ctx[Context builder: rules, skills index, memory, KB] --> A
    T --> B[Built-in tools]
    T --> M[MCP client]
    T --> Pl[Plugins]
    T --> K[Knowledge providers]
  end
  I[Intel job - daily] --> H
  E[Evolution - reflect/propose/accept] --> Ctx
```

## Milestones

### M0 — Foundations `[x]`
- [x] `AGENTS.md` rules (English-only, spec-first, milestone definition of done)
- [x] `specs/000-vision.md`, this plan

### M1 — Core runtime MVP `[x]`
- [x] Append-only JSONL session log, `deriveMessages()`
- [x] Providers: OpenAI-compatible (DeepSeek, OpenAI, GLM, Qwen/DashScope, Gemini, Ollama) and Anthropic, streaming + tool calls
- [x] Error taxonomy: `quota`, `rate_limit`, `auth`, `network`, `context_length`, `other`
- [x] Agent loop with retries, abort, approval, max steps
- [x] Built-in tools: read/write/edit file, list, glob, grep, bash, web_fetch, todo
- [x] Approval modes `suggest | auto-edit | full-auto`, workspace path guard
- [x] Rules loader (AGENTS.md hierarchy, CLAUDE.md, `.sun/rules`, `.cursor/rules`), specs index
- [x] Durable pause/resume: quota pause, model switch, fallback chain, auto-resume probe
- [x] Context compaction
- [x] CLI `sun`
- [x] Tests (mock provider)

### M2 — Extensions, knowledge, modes `[x]`
- [x] Skills (`SKILL.md`, progressive disclosure, Claude-compatible locations)
- [x] MCP client (stdio + streamable HTTP)
- [x] Plugins (ESM, `api.registerTool/registerKnowledgeProvider/registerMode/on`)
- [x] Hooks (`preToolUse`, `postToolUse`, `sessionStart`, `stop`)
- [x] Knowledge: `KnowledgeProvider` seam, local markdown BM25 (CJK-aware), company HTTP provider (reserved)
- [x] Memory (`MEMORY.md`) + tools
- [x] Modes: coding, agent (Manus-like), assistant (Hermes-like); subagent `task` tool

### M3 — Desktop app `[x]`
- [x] Electron main hosts `HarnessHost`; secure preload bridge
- [x] Sessions sidebar, chat with streaming, tool cards, approval cards
- [x] Model/mode switch, paused banner with resume
- [x] Pages: Skills, MCP, Plugins, Knowledge, Memory, Evolution, Intel, Settings

### M4 — Intel + evolution `[x]`
- [x] Intel sources (GitHub releases + changelogs), dedupe, LLM analysis with principles, daily report
- [x] macOS launchd daily schedule + in-app catch-up scheduler
- [x] Evolution: reflect → proposals → accept into memory/skills/rules; intel adoption ideas → proposals

### M5 — Docs + verification `[x]`
- [x] Manual per milestone, teaching HTML per milestone with Mermaid
- [x] Full test + build + live model smoke + desktop screenshot

### Iteration 1 — fail-closed approvals `[x]`
- [x] Source: intel 2026-11-07 (Claude Code 2.1.317–2.1.319)
- [x] Spec `specs/008-approval-policy.md`; headless deny with reason; `denyInsteadOfPrompting`; hook `onFailure: "block"`
- [x] Tests, manual, teaching page `docs/teach/06-research-loop.html`

### Iterations 2–7 `[x]`
- [x] 2 — Context budgets: separate global/project rule budgets; model context windows; `%` compaction buffer; compact with the old model before downgrading (`specs/009`, teach 07)
- [x] 3 — Worktree sessions: isolated branch per session; status/diff; squash or merge; discard (`specs/010`, teach 08)
- [x] 4 — Background jobs: `bash` background, slow-MCP promotion, eventual delivery into the session (`specs/011`, teach 09)
- [x] 5 — Gateway: `sun serve` owns sessions; CLI/desktop/web attach; per-session approval; launchd service; headless schedules (`specs/012`, ADR 0005, teach 10)
- [x] 6 — Hybrid knowledge: BM25 + embeddings with rank fusion, content-addressed cache, BM25 fallback (`specs/013`, teach 11)
- [x] 7 — Packaged macOS app: self-contained bundle, offline packaging, Finder PATH, ad-hoc signing, icon (`specs/014`, teach 12)

### Iterations 8–11 `[x]`
- [x] 8 — Durable jobs: detached wrapper, on-disk record/exit status, re-attach and deliver after restart (`specs/015`, teach 13)
- [x] 9 — Approval race guard: prompt ids, stale-answer rejection, CLI pre-typed input guard, desktop arm delay, scoped approvers (`specs/016`, teach 14)
- [x] 10 — Remote gateway: TLS with self-signed pinned certificate, device tokens, `sun remote` (`specs/017`, ADR 0006, teach 15)
- [x] 11 — Chat bots: Telegram, DingTalk outgoing robot, webhook; allowlist, per-chat sessions, approvals in chat (`specs/018`, teach 16)
- [x] 11.1 — Feishu/Lark, WeChat Official Account, WeCom bots (`specs/018`, teach 16)

## Optimization plan (0.4.0) — coding success, Manus-like agent, personal assistant

Derived from a first-principles comparison with Codex / Claude Code (coding), Manus (sandboxed autonomous agent), and Hermes-like assistants. Every phase is measured; results and the decisions they forced are in the specs and teaching pages.

### Phase 0 — Measure `[x]`
- [x] 36-task coding eval suite (24 standard + 12 hard), each validated (fails untouched, passes with reference solution); hidden tests; `EVAL_BASE` diff checks
- [x] `sun eval validate | run | list | report | compare`, session telemetry, baselines for deepseek-chat and qwen-flash (`specs/019`, teach 17)

### Phase 1 — Coding success `[x]`
- [x] Tolerant `edit_file`, atomic `apply_patch`, read-before-overwrite + stale-read refusal (narrowed after evals), post-edit syntax diagnostics
- [x] Checkpoints + undo (CLI, chat, desktop, gateway); done gate (verify loop) with detected or configured commands
- [x] Capability gating, malformed tool-JSON repair, parallel read-only tools
- [x] Prompt-cache accounting (DeepSeek, OpenAI/DashScope, Anthropic) + Anthropic and DashScope cache markers; repository map + `repo_map`
- [x] Plan mode with plan approval; best-of-N in worktrees judged by project tests (`sun run --best-of`, `sun eval run --best-of`) (`specs/020`, teach 18)

### Phase 2 — Sandbox `[x]`
- [x] One exec interface for bash, jobs, verify, best-of-N judge, Python kernel; seatbelt (macOS), bubblewrap (Linux), Docker per session
- [x] Network on/off/allowlist (CONNECT proxy), hidden credentials and harness state, secret env scrubbing, optional auto-approve (`specs/021`, ADR 0007, teach 19)

### Phase 3 — Browser + takeover `[x]`
- [x] Raw CDP client; local Chrome, sandboxed Chromium (Xvfb, fluxbox, x11vnc, noVNC, socat; `docker/browser`), any CDP endpoint
- [x] Accessibility snapshots with refs; navigate/click/type/keys/scroll/back/screenshot/evaluate; persistent profiles, `sun browser login`
- [x] Live view (screencast) and takeover in the desktop; noVNC link (`specs/022`, ADR 0008, teach 20)

### Phase 4 — Research agent `[x]`
- [x] Search providers (Bing keyless, Tavily, Brave, Serper, Bocha, SearXNG, DuckDuckGo) with gating; readable Markdown + PDF `web_fetch` with paging
- [x] Persistent Python kernel; bounded parallel subagents; deliverables panel
- [x] Prompt-injection guard: untrusted wrapping, scanning, `context/taint`, policy escalation (`specs/023`, teach 21)

### Phase 5 — Assistant efficiency `[x]`
- [x] Layered memory (core + long-term), per-message recall, background extraction, `memory_search`
- [x] Model router (`background`, `auto` fast/strong); DingTalk via `dws` (read/write split); email/calendar MCP presets
- [x] Daily briefing (file, desktop, bot chats); file-watch and webhook triggers; voice input (DashScope ASR / Whisper) and read-aloud
- [x] Conversation efficiency metrics (`sun metrics`, desktop) (`specs/024`, teach 22)

## Iteration backlog (research loop)

Filled from intel reports (`~/.sun/evolution/proposals`); each item becomes a spec before code.

| Candidate | Seen in | Part |
|---|---|---|
| Locked, honest config writes (file lock, non-zero exit on failed writes) | Claude Code 2.1.317–318 | Log |
| Negative capability cache for MCP servers that fail fast | Claude Code 2.1.318 | Tools |
| Credential / key expiry surfaced in status | Claude Code 2.1.318 | Model |
| DingTalk Stream / Feishu long-connection modes (no public URL); Slack native adapter | Hermes Agent | Architecture |
| Desktop attaches to remote gateways (pinned), device management UI | — | Desktop |
| Developer ID signing + notarization; auto-update | — | Desktop |
| Session export/import and sharing | Codex, Claude Code | Log |
| Full LSP diagnostics (types) after edits, not only syntax | Claude Code, Cursor | Tools |
| Learned router (from metrics) instead of keyword heuristics | — | Model |
| Browser: multi-tab, file upload/download, Playwright via connectOverCDP | Manus | Tools |
| DingTalk event stream (`dws event`) as a trigger kind | — | Architecture |
