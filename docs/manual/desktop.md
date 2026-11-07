# Desktop app

Install with `pnpm desktop:install` (→ `~/Applications/sun-harness.app`), or start from the checkout with `pnpm desktop:start` (built) or `pnpm desktop` (dev). The app finds your tools (`node`, `npx`, `git`, Homebrew, nvm) even when launched from Finder. The left rail switches screens; the badge on **Sessions** counts sessions that need you (paused or awaiting approval).

## Welcome

Choose a mode card, pick a workspace (required for Coding; Agent and Assistant default to `~/.sun/workspace`), optionally tick **Isolated git worktree** (Coding), then **Start**.

## Session

- **Header**: status dot (green idle, pulsing amber running, yellow paused, red error), title, workspace chip (opens Finder), mode and model selectors (take effect on the next request), token counter with the prompt-cache share, **↶ Undo (n)** (revert the last edit step), delete.
- **Transcript**: your messages on the right; assistant text in Markdown; collapsible **Reasoning** for thinking models; one **tool card** per call — click to see arguments and output. MCP tools show as `server › tool`.
- **Worktree**: sessions on a worktree show ⑂ in the sidebar and a branch chip in the header; the chip opens the Changes panel (files, diff, Merge (squash), Merge commit, Discard). See [Worktree sessions](worktrees.md).
- **Plan**: when the agent uses `todo_write`, a sticky plan with a progress bar appears at the top.
- **Verification**: after the agent finishes editing, a "✓ verified" or "✗ verification failed" line shows the project checks that ran; click it for the output. See [Coding](coding.md#verification-the-done-gate).
- **Voice**: 🎙 in the composer records and transcribes into the message box; 🔈/🔊 reads replies aloud.
- **Files**: **▤ Files** lists what the session created or changed (new / changed, size); click to open.
- **Browser**: sessions that used the browser show **◎ Browser**: a live view with **Take over** / **Hand back to agent** (and **noVNC ↗** in Docker mode). See [Browser](browser.md).
- **Plan review**: in Plan mode the agent's plan appears as a card: **Approve and start coding** or **Keep planning**.
- **Approval card**: Allow / Always allow `<tool>` (for this session) / Deny. The buttons arm after a moment ("read first…") so a click or Enter aimed at something else can't approve. Subagent approvals appear in the parent session.
- **Paused banner**: shown for quota, auth, rate limit, network, step limit, or interruption. **Resume** retries the same model; pick another model and **Switch & resume** to continue elsewhere. Nothing is lost.
- **Composer**: Enter sends, Shift+Enter adds a line. `@` completes file paths, `/` shows custom commands and `/compact` `/cost` `/export`; paste, drop or ⊕ attach images.
- **Changes**: a card after each turn that edited files (click a file: Diff / File, Open, Copy path, Revert); **▤ Changes** opens the session review with a file tree.
- **Scheduling**: a message like “every weekday at 9 …” shows a **Schedule this?** card. The ⏲ **Automations** screen manages them ([Automations](automations.md)).
- **Context**: the ring in the session bar shows context usage; click for the report (categories, largest items, suggestions, Compact now, Export HTML). The sidebar shows each session's percent; hover to pin or archive.
- **Keys**: Esc stops a run, ↑ recalls your last message, ⌘N new session, ⌘K palette.
- **Session bar**: sandbox, Files, Browser, estimated cost, **Export…**, tokens and cache share, Undo. Edit tool cards show diffs. Hover your message for **↶ Rewind**.
- **⌘K** palette and the sidebar **search**; background **notifications**. See [Everyday conveniences](everyday.md).
- **Queue and stop**: while running, messages are queued and sent when the run ends. **Stop** aborts the run (including a running shell command).
- **Subagent sessions** are nested under their parent in the sidebar; "← back to parent session" returns.

## Knowledge

Search every knowledge provider, add a note to the personal KB, browse and forget **long-term memories** (filter, ✕), and edit the core memory (`MEMORY.md`) directly.

## Skills · MCP · Plugins

Pick a workspace (top right) to see its skills (scope badge: project / user / compat), MCP servers (status, tools, **Reconnect**), plugins (**Reload**), and scheduled tasks.

## Evolution

Pending proposals with **Accept** / **Reject**; history below. **Reflect on current session** asks the model for up to five improvements from the selected session.

## Harness Intel

Dates on the left (yellow dot = analysis pending), the report on the right. **Run now** fetches and analyzes; **Analyze pending** re-runs analysis for a day whose model call failed.

## Settings

Default model, fallback chain (click to order), auto-resume interval, approval mode, deny-instead-of-prompting, max steps, providers (base URL and model list per provider), shell sandbox (mode, network, allowlist, auto-approve), KB folders, company KB, daily briefing (time, **Run briefing now**), intel time, and **Efficiency · last 7 days** (turns, first-reply time, approvals per turn, clarify rate, tool errors, cache share, memory). Changes save immediately to `~/.sun/config.json`.
