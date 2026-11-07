# Desktop app

Install with `pnpm desktop:install` (→ `~/Applications/sun-harness.app`), or start from the checkout with `pnpm desktop:start` (built) or `pnpm desktop` (dev). The app finds your tools (`node`, `npx`, `git`, Homebrew, nvm) even when launched from Finder. The left rail switches screens; the badge on **Sessions** counts sessions that need you (paused or awaiting approval).

## Welcome

Choose a mode card, pick a workspace (required for Coding; Agent and Assistant default to `~/.sun/workspace`), optionally tick **Isolated git worktree** (Coding), then **Start**.

## Session

- **Header**: status dot (green idle, pulsing amber running, yellow paused, red error), title, workspace chip (opens Finder), mode and model selectors (take effect on the next request), token counter, delete.
- **Transcript**: your messages on the right; assistant text in Markdown; collapsible **Reasoning** for thinking models; one **tool card** per call — click to see arguments and output. MCP tools show as `server › tool`.
- **Worktree**: sessions on a worktree show ⑂ in the sidebar and a branch chip in the header; the chip opens the Changes panel (files, diff, Merge (squash), Merge commit, Discard). See [Worktree sessions](worktrees.md).
- **Plan**: when the agent uses `todo_write`, a sticky plan with a progress bar appears at the top.
- **Approval card**: Allow / Always allow `<tool>` (for this session) / Deny. Subagent approvals appear in the parent session.
- **Paused banner**: shown for quota, auth, rate limit, network, step limit, or interruption. **Resume** retries the same model; pick another model and **Switch & resume** to continue elsewhere. Nothing is lost.
- **Composer**: Enter sends, Shift+Enter adds a line. While running, messages are queued and sent when the run ends. **Stop** aborts the run (including a running shell command).
- **Subagent sessions** are nested under their parent in the sidebar; "← back to parent session" returns.

## Knowledge

Search every knowledge provider, add a note to the personal KB, and edit `MEMORY.md` directly.

## Skills · MCP · Plugins

Pick a workspace (top right) to see its skills (scope badge: project / user / compat), MCP servers (status, tools, **Reconnect**), plugins (**Reload**), and scheduled tasks.

## Evolution

Pending proposals with **Accept** / **Reject**; history below. **Reflect on current session** asks the model for up to five improvements from the selected session.

## Harness Intel

Dates on the left (yellow dot = analysis pending), the report on the right. **Run now** fetches and analyzes; **Analyze pending** re-runs analysis for a day whose model call failed.

## Settings

Default model, fallback chain (click to order), auto-resume interval, approval mode, deny-instead-of-prompting, max steps, providers (base URL and model list per provider), KB folders, company KB, and intel time. Changes save immediately to `~/.sun/config.json`.
