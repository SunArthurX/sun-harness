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

`sun mcp` prints the tools or connection error and exits after closing its
connections. A slow handshake has a 30-second deadline.

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

Put settings for a plugin in `plugins.settings.<name>` in `~/.sun/config.json`.
The plugin reads them through `api.settings`.

Declare requested actions in the plugin's optional `package.json`.

```json
{
  "sun": {
    "main": "index.mjs",
    "requestedActions": ["tools", "prompts", "knowledge", "session-events"]
  }
}
```

The supported IDs are `tools`, `knowledge`, `modes`, `prompts`, `session-events`,
`filesystem`, `network`, and `processes`. The host reads up to 64 KiB of
manifest content without activating the plugin. Existing plugins can omit
the declaration. Enabled plugins run with the host process's privileges,
so enable only code you trust.

Open **Settings → Plugins** in desktop or gateway web to inspect requested
actions and registered contributions. **Disable plugin** immediately removes
the plugin's registrations. A tool awaiting approval will fail if approved
after disable. Calls that already started may finish. **Draining** shows how
many remain. **Enable plugin** becomes available again when they finish.
The settings audit records the transition in `~/.sun/settings/audit.jsonl`.

```sh
sun plugins list
sun plugins disable hello
sun plugins enable hello
```

The CLI uses the selected execution host when connected. Without a gateway,
it inspects manifests and saves the change for the next host start.
`--local` explicitly selects the local files. **Reload** reads the current
plugin settings and replaces registrations on the active host. Activation
publishes all staged registrations only after it succeeds.

## Hooks

Put project hooks in `<project>/.sun/hooks.json`. Put user hooks in
`~/.sun/hooks.json`.

A `sessionStart` hook marked `worktreeSetup: true` is available through
the owning worktree's reviewed setup action. See
[Worktree sessions](worktrees.md) for the run and recovery controls.

```json
{
  "preToolUse": [
    { "id": "check-shell", "enabled": true, "matcher": "^bash$", "command": "./scripts/check-command.sh", "onFailure": "block" }
  ],
  "postToolUse": [{ "matcher": "^(write_file|edit_file)$", "command": "pnpm -s lint --quiet || true" }],
  "sessionStart": [{ "command": "git status --short" }],
  "stop": [{ "command": "pnpm -s test >/dev/null 2>&1 || { echo 'Tests fail; fix them before finishing.' >&2; exit 2; }" }]
}
```

Existing hooks need review before they can execute. Open **Settings → Hooks**,
choose the workspace, and load its hooks. Select reviewed commands and save
their trust. Preview a synthetic event before running a fixture. The same
review and fixture flow is available in the CLI. Run `sun hooks list`
from the workspace to inspect the source, command, state, ID, and current
digest. Use the returned ID and digest for review.

```bash
sun hooks list --cwd /path/to/workspace
sun hooks preview HOOK_ID HOOK_DIGEST --fixture shell --cwd /path/to/workspace
sun hooks trust HOOK_ID HOOK_DIGEST --cwd /path/to/workspace
sun hooks test HOOK_ID HOOK_DIGEST --fixture shell --execute --cwd /path/to/workspace
sun hooks revoke HOOK_ID HOOK_DIGEST --cwd /path/to/workspace
```

Preview builds a synthetic event without running the command. Executing a
fixture requires a matching reviewed hook and the explicit `--execute`
flag. Press Ctrl+C to cancel a running fixture. `read`, `shell`, and `edit`
select sample tool events. Use `--local` for the local host or `--remote NAME`
with an absolute workspace on that execution host.

Trust is stored on the execution host. Edits to the configuration file
require another review. Simple literals, anchors, character classes,
alternation, and one ungrouped quantifier are supported in matchers.
`onFailure: "block"` blocks matching tools if the policy hook cannot
be validated or is untrusted. The hook runs with the host sandbox and
a restricted environment. A hook can produce up to 64 KiB of combined
output. Runtime logs record the outcome and retain any text passed to
the model.

The event JSON arrives on stdin (`tool`, `args`, `cwd`, `sessionId`, and `output` for postToolUse).

| Exit | preToolUse | postToolUse | sessionStart | stop |
|---|---|---|---|---|
| 0 | allow | stdout added to the result | stdout becomes context | finish |
| 2 | block (stderr is the reason) | stderr added as feedback | — | continue with stderr as a new message (max 3) |
| other | ignored, or **block** with `onFailure: "block"` | ignored | ignored | ignored |
