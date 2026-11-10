# AGENTS.md — Rules for sun-harness

These rules are binding for every human and AI agent working in this repository.
They exist to prevent drift: the product must keep matching its specs.

## 1. Language

- **Documentation, specs, comments, commit messages, and generated reports are written in English.**
- **Desktop and web UI copy is authored in English and must ship with Simplified Chinese** in the same change (`t()` / `tk()`, `apps/desktop/src/renderer/src/locale-zh-CN.ts`). `apps/desktop/test/i18n.test.ts` fails if a string is missing. See `specs/028-ui-i18n.md` and `apps/desktop/AGENTS.md`.
- Chat with the owner may be in any language; artifacts stay English. The CLI is not localized.

## 2. Source of truth (anti-drift)

Order of authority when things disagree:

1. `specs/` — product specs (`000-vision.md` is the north star; numbered specs refine it).
2. `docs/plan.md` — the roadmap and milestone status.
3. `AGENTS.md` (this file) and nested `AGENTS.md` files (closest file wins for its subtree).
4. Code.

Rules:

- Any change in behavior must update the relevant spec **in the same change**. If no spec covers it, add one (`specs/NNN-topic.md`).
- Never implement a feature that contradicts a spec. Change the spec first, with a short "Decision" note.
- Architectural decisions go in `docs/adr/NNNN-title.md` (context, decision, consequences).

## 3. First principles

- A harness is: **model + context + tools + loop + durable log + policy**. Everything else is an extension.
- **Model-visible means logged.** Anything sent to a model must be reconstructable from the session JSONL log.
- **Everything is an extension.** Tools, skills, MCP servers, plugins, knowledge providers, and modes register through one registry. The core stays small.
- **Durable before clever.** Every run must be pausable and resumable from disk (quota exhaustion, crash, model switch).
- **Human in control.** Side-effecting tools pass the approval policy.

## 4. Milestone definition of done

A milestone is done only when all of these are true:

1. Code + tests pass: `pnpm test` and `pnpm build`.
2. Manual updated: `docs/manual/` (user-facing, how to use what was built).
3. Teaching page added: `docs/teach/NN-topic.html` — the development path, technical questions met, how they were solved, with Mermaid diagrams. Link it from `docs/teach/index.html`.
4. `docs/plan.md` status and `CHANGELOG.md` updated.

## 5. Code conventions

- TypeScript, ESM, strict mode. Node >= 22.
- Packages: `packages/core` (runtime, no UI), `packages/cli` (`sun` command), `apps/desktop` (Electron).
- The core must not import Electron or React. UI talks to core only through the `HarnessHost` API.
- Tests: Vitest, colocated in `packages/*/test`. Use the scripted mock provider; never require network in unit tests.
- No secrets in the repo. API keys come from env vars or `~/.sun/config.json` (`apiKeyEnv` preferred over raw keys).

## 6. Data locations

- User home: `~/.sun/` (override with `SUN_HOME`): `config.json`, `sessions/`, `skills/`, `plugins/`, `kb/`, `memory/`, `evolution/`, `intel/`.
- Project: `.sun/` in the workspace: `rules/`, `skills/`, `mcp.json`, `hooks.json`.
- Compatibility: `AGENTS.md`, `CLAUDE.md`, `.claude/skills`, `.cursor/rules` are read too.

## 7. Settings initiative execution

For settings/competitor-adoption work, read `specs/032-settings-and-capability-management.md` and `docs/plans/settings-competitors/README.md` before implementation. Follow the dependency-ready task and evidence protocol in that pack. Run `node scripts/check-settings-plan.mjs`; it is also enforced by `pnpm test`. Plan integrity does not replace behavioral acceptance. Preserve existing dirty changes and never mark planned features implemented based on documentation alone.
