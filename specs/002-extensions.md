# 002 — Extensions: rules, skills, MCP, plugins, hooks

Status: implemented (M2). Code: `packages/core/src/{rules,skills,mcp,plugins,hooks}.ts`.

## Rules (anti-drift context)

Loaded fresh for every model request, in this order (later = more specific):

1. `~/.sun/AGENTS.md` (global; evolution appends accepted rules here)
2. `AGENTS.md` from the project root down to the session cwd; `CLAUDE.md` is used where no `AGENTS.md` exists; symlinks are de-duplicated
3. `.sun/rules/*.md` (frontmatter `alwaysApply: false` + `description` → listed as optional, read on demand)
4. `.cursor/rules/*.mdc` with `alwaysApply: true` (others listed by description)
5. A specs index: every `specs/*.md` title, marked as the source of truth

`sun init` scaffolds `AGENTS.md`, `CLAUDE.md -> AGENTS.md`, `specs/000-vision.md`, `.sun/{rules,skills,mcp.json,hooks.json}`.

## Skills

- A skill is a folder with `SKILL.md` (frontmatter `name`, `description`) plus optional files.
- Search order (first name wins): `<project>/.sun/skills`, `~/.sun/skills`, `skills.extraDirs`, then compat locations `<project>/.claude/skills`, `<project>/.agents/skills`, `~/.claude/skills`, `~/.agents/skills` (`skills.compat`).
- Progressive disclosure: the prompt lists name + description; `load_skill(name)` returns the body and the bundled file list.

## MCP

- Config files (later overrides earlier by server name): `~/.sun/mcp.json`, `<project>/.mcp.json`, `<project>/.sun/mcp.json`. Format `{ "mcpServers": { name: { command, args, env, cwd } | { url, headers, type: "http"|"sse" } } }`, plus `disabled` and `trust`.
- Tools are exposed as `mcp__<server>__<tool>` with risk `exec` (asks in auto-edit) unless `trust: true` (risk `read`).
- One connection set per project root, created lazily.

## Plugins

- Each folder in `~/.sun/plugins/<name>` loads unless listed in `plugins.disabled`. Entry: `package.json` `sun.main`, else `index.mjs` / `index.js`.
- Module exports `default (api) => void` or `activate(api)`. API: `registerTool` (risk defaults to `exec`), `registerKnowledgeProvider`, `registerMode`, `registerPromptSection`, `onSessionEvent`, `settings` (from `plugins.settings.<name>`), `log`.
- A failing plugin is reported with `status: error` and never breaks the host.

## Hooks

- `~/.sun/hooks.json` and `<project>/.sun/hooks.json`: `sessionStart`, `preToolUse`, `postToolUse`, `stop`; entries `{ matcher?, command, timeoutMs?, onFailure? }`.
- The event JSON is written to the command's stdin. Exit 0 = ok (stdout becomes context), exit 2 = block (`preToolUse`) / continue with feedback (`stop`, max 3 times per run).
- `onFailure: "block"` (preToolUse): any other non-zero exit, crash, or timeout vetoes the call (fail-closed).
