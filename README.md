# sun-harness

A personal, first-principles agent harness: a **coding agent**, a **general task agent** (Manus-like), and a **personal assistant** (Hermes-like) in one desktop app and CLI. It grows with you and with the field: it reads your rules and knowledge, survives quota exhaustion, watches other harnesses daily, and proposes its own improvements.

![Session](docs/teach/img/chat.png)

## Why

A harness reduces to six parts: **model, context, tools, loop, log, policy**. sun-harness implements those six small and durable, and everything else (desktop UI, skills, MCP, plugins, knowledge, intel, evolution) as extensions of them. See [`specs/000-vision.md`](specs/000-vision.md) and the [teaching pages](docs/teach/index.html).

## Features

- **Desktop app** (Electron + React): streaming sessions, tool cards, approval cards, plan view, paused banner with resume / switch-model, knowledge, extensions, evolution, intel and settings screens. English and Simplified Chinese (rail toggle or Settings). A right dock holds Changes, Browser, Terminal and Files.
- **CLI** `sun`: interactive chat, one-shot `run` with exit codes, `resume`, `init`, `intel`, `kb`, `evolve`, `doctor`.
- **Any model**: DeepSeek, OpenAI, Anthropic, GLM, Qwen, Gemini, OpenRouter, Ollama (OpenAI-compatible and Anthropic wire formats), switchable per session.
- **Durable by design**: every session is an append-only JSONL log; quota or auth failures pause the run, fallback models take over, and resume continues exactly where it stopped.
- **Anti-drift context**: AGENTS.md hierarchy, CLAUDE.md, `.sun/rules`, `.cursor/rules`, and a specs index in every request; `sun init` scaffolds them.
- **Extensions**: Claude-compatible skills, MCP (stdio / HTTP / SSE), ESM plugins, shell hooks with fail-closed option.
- **Knowledge**: personal Markdown KB with BM25 (CJK-aware), memory file, reserved company-KB HTTP provider.
- **Modes**: coding, agent, assistant; subagents; scheduled tasks.
- **Harness intel**: daily fetch of 14 harness release feeds, LLM analysis of what changed and why it works, launchd schedule.
- **Evolution**: reflection and intel produce proposals (memory, skill, rule, feature) that you accept or reject.
- **Gateway + web UI**: `sun serve` owns every session (schedules, jobs, auto-resume run headless); CLI, desktop and browser attach as clients.
- **Worktree sessions**: parallel coding on isolated branches; review the diff, squash-merge or discard.
- **Background jobs**: long commands and slow MCP calls run in the background; results come back into the session.
- **Context budgets**: per-model context windows, separate rule budgets, safe compaction when switching to a smaller model.
- **Hybrid knowledge (optional)**: BM25 + embeddings with rank fusion; finds notes across languages.
- **Packaged macOS app**: `pnpm desktop:install` → `~/Applications/sun-harness.app`.
- **Remote access**: `sun serve --tls`, per-device tokens, certificate-pinned `sun remote` clients.
- **Chat bots**: Telegram, DingTalk, Feishu, WeChat Official Account, WeCom and webhook bots with allowlists and approvals in chat.
- **Durable jobs and safe approvals**: background jobs survive restarts; approvals can't be answered by stray keys or clicks.
- **Measured coding success**: a validated 36-task eval suite (`sun eval`); tolerant edits and atomic `apply_patch`, a done gate that runs your tests, undo, repository map, plan mode, best-of-N, prompt-cache accounting.
- **Cursor-grade coding**: local codebase search, glob-scoped rules, `.cursorignore`, and a read-only `/review` of the session diff.
- **Sandboxed shell**: seatbelt (macOS), bubblewrap (Linux) or Docker; network off / on / allowlist; credentials hidden from commands.
- **A real browser**: local Chrome or sandboxed Chromium (Xvfb + noVNC + socat) over CDP; accessibility snapshots; live view and takeover in the desktop.
- **Research agent**: keyless and keyed search providers, readable pages and PDFs, a persistent Python kernel, parallel subagents, deliverables panel, prompt-injection guard.
- **Automations**: say “every weekday at 9 …” and confirm; manage runs in the ⏲ menu or `sun automations`; missed runs catch up.
- **See what changed**: every turn lists the files it changed (diff, full file, revert); a session review with a file tree.
- **Context usage per conversation**: a ring and report showing what fills the context and how to shrink it; steering mid-run; model titles; pins.
- **Everyday conveniences**: custom `/commands`, `@file` mentions, pasted images, inline diffs, cost, rewind, export/import, ⌘K palette, session search, notifications, `stream-json` output.
- **Assistant that saves effort**: layered memory with automatic extraction, a short user profile, daily notes, skill slash commands, model routing, DingTalk and email/calendar connectors, daily briefing, file and webhook triggers, voice input and read-aloud, efficiency metrics.
- **Wide research and slides**: each item in its own subagent, an HTML deck, and a Deliverables list.
- **Settings**: revisioned bilingual settings for preferences, storage, hooks, plugins, browser grants and remote connections. Writes keep unknown keys and reject a stale revision.
- **macOS desktop extras**: Appshots of the front window, Computer Use of a granted app, and Keychain-backed website passwords. Each grant belongs to the signed app you approved.

## Quick start

```sh
pnpm install
pnpm build
export DEEPSEEK_API_KEY=...        # or any supported provider
node packages/cli/dist/index.js doctor
pnpm desktop:install               # desktop app → ~/Applications/sun-harness.app
node packages/cli/dist/index.js    # terminal chat
node packages/cli/dist/index.js gateway install   # optional: always-on gateway + web UI
```

Full guide: [docs/manual](docs/manual/README.md).

## Development

```sh
pnpm test                          # core unit tests (mock provider, no network)
pnpm build                         # core, CLI, CLI bundle, desktop
node apps/desktop/e2e/smoke.mjs    # desktop smoke test against a loopback model
```

The full command list, including Docker, the gateway and the signed macOS checks, is in [Verify a local build](docs/manual/verification.md).

Read [`AGENTS.md`](AGENTS.md) first: English-only artifacts, spec-first changes, and the milestone definition of done (tests, manual, teaching page).

| Path | Contents |
|---|---|
| `packages/core` | runtime: log, loop, providers, tools, policy, rules, skills, MCP, plugins, hooks, KB, memory, intel, evolution, host |
| `packages/cli` | the `sun` command |
| `apps/desktop` | Electron app |
| `specs/` | product specs (source of truth) |
| `docs/manual/` | user manual |
| `docs/teach/` | teaching pages with diagrams |
| `docs/adr/` | architecture decisions |

## License

[MIT](LICENSE)
