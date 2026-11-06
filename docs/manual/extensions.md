# Extensions

## Skills

A skill is a folder with a `SKILL.md`:

```markdown
---
name: release-flow
description: Use when cutting a release of this project.
---
1. Run `pnpm test`.
2. Bump the version in package.json.
3. Update CHANGELOG.md and tag.
```

Locations: `<project>/.sun/skills`, `~/.sun/skills`, plus Claude-compatible `.claude/skills` and `.agents/skills` (project and home). Only names and descriptions go into the prompt; the agent calls `load_skill` to read the body when it needs it. Your existing Claude Code skills work as-is.

## MCP servers

```json
// ~/.sun/mcp.json  (also <project>/.mcp.json and <project>/.sun/mcp.json)
{
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/me/notes"] },
    "remote": { "url": "https://mcp.example.com/mcp", "headers": { "Authorization": "Bearer ..." } },
    "docs": { "url": "https://example.com/sse", "type": "sse", "trust": true }
  }
}
```

Tools appear as `mcp__<server>__<tool>`. They ask for approval in `auto-edit` mode unless the server has `"trust": true`. Check status with `sun mcp` or the desktop screen.

## Plugins

```text
~/.sun/plugins/hello/index.mjs
```

```js
export default function (api) {
  api.registerTool({
    name: 'hello',
    description: 'Greet someone',
    parameters: { type: 'object', properties: { who: { type: 'string' } }, required: ['who'] },
    risk: 'read',                       // default is 'exec' (asks for approval)
    execute: async ({ who }) => `Hello, ${who}!`,
  });
  api.registerPromptSection('Team conventions', 'We deploy on Tuesdays.');
  api.registerKnowledgeProvider({ id: 'wiki', name: 'Team wiki', search: async (q, k) => [] });
  api.onSessionEvent((sessionId, e) => { if (e.type === 'run/status') api.log(sessionId, e.status); });
}
```

Settings for a plugin: `config.plugins.settings.<name>` (available as `api.settings`). Disable with `config.plugins.disabled: ["hello"]`. Reload from the desktop or restart the CLI.

## Hooks

```json
// <project>/.sun/hooks.json  (or ~/.sun/hooks.json)
{
  "preToolUse": [
    { "matcher": "^bash$", "command": "./scripts/check-command.sh", "onFailure": "block" }
  ],
  "postToolUse": [{ "matcher": "^(write_file|edit_file)$", "command": "pnpm -s lint --quiet || true" }],
  "sessionStart": [{ "command": "git status --short" }],
  "stop": [{ "command": "pnpm -s test >/dev/null 2>&1 || { echo 'Tests fail; fix them before finishing.' >&2; exit 2; }" }]
}
```

The event JSON arrives on stdin (`tool`, `args`, `cwd`, `sessionId`, and `output` for postToolUse).

| Exit | preToolUse | postToolUse | sessionStart | stop |
|---|---|---|---|---|
| 0 | allow | stdout added to the result | stdout becomes context | finish |
| 2 | block (stderr is the reason) | stderr added as feedback | — | continue with stderr as a new message (max 3) |
| other | ignored, or **block** with `onFailure: "block"` | ignored | ignored | ignored |
