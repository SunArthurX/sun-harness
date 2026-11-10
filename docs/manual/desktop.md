# Desktop app

Install with `pnpm desktop:install` (→ `~/Applications/sun-harness.app`), or start from the checkout with `pnpm desktop:start` (built) or `pnpm desktop` (dev). The app finds your tools (`node`, `npx`, `git`, Homebrew, nvm) even when launched from Finder. The left rail switches screens; the badge on **Sessions** counts sessions that need you (paused or awaiting approval).

## Welcome

Choose a mode card, pick a workspace (required for Coding; Agent and Assistant default to `~/.sun/workspace`), optionally tick **Isolated git worktree** (Coding), then **Start**.

## Session

- **Header**: status dot (green idle, pulsing amber running, yellow paused, red error), title, workspace chip (opens Finder), mode and model selectors (take effect on the next request), token counter with the prompt-cache share, **↶ Undo (n)** (revert the last edit step), delete.
- **Transcript**: your messages on the right; assistant text in Markdown; collapsible **Reasoning** for thinking models; one **tool card** per call — click to see arguments and output. MCP tools show as `server › tool`.
- **Worktree**: sessions on a worktree show ⑂ in the sidebar and a branch chip in the header; the chip opens the Changes panel (files, diff, Merge (squash), Merge commit, Discard). See [Worktree sessions](worktrees.md).
- **Plan** stays above the transcript when the agent updates its tasks. Scroll within a long plan to see the remaining items. Approval cards stay reachable in the transcript below it.
- **Verification**: after the agent finishes editing, a "✓ verified" or "✗ verification failed" line shows the project checks that ran; click it for the output. See [Coding](coding.md#verification-the-done-gate).
- **Voice**: 🎙 in the composer records and transcribes into the message box; 🔈/🔊 reads replies aloud.
- **Files**: **▤ Files** lists what the session created or changed (new / changed, size); click to open.
- **Execution targets**: review and start a shell job in a session on the current host, Local Docker, or a trusted gateway. See [Execution targets](execution-targets.md).
- **Appshots**: capture one foreground window on macOS, review and edit it privately, then attach it to a chat. See [Appshots](appshots.md).
- **Computer Use**: grant a running macOS app to one chat and control accessible elements in its foreground window. See [Computer Use](computer-use.md).
- **Passwords**: save a website password on macOS and fill it in an isolated sign-in window. See [Website passwords](passwords.md).
- **Browser**: sessions that used the browser show **◎ Browser**: a live view with **Take over** / **Hand back to agent**. See [Browser](browser.md).
- **Plan review**: in Plan mode the agent's plan appears as a card: **Approve and start coding** or **Keep planning**.
- **Approval card**: Allow / Always allow `<tool>` (for this session) / Deny. The buttons arm after a moment ("read first…") so a click or Enter aimed at something else can't approve. Subagent approvals appear in the parent session.
- **Paused banner**: shown for quota, auth, rate limit, network, step limit, or interruption. **Resume** retries the same model; pick another model and **Switch & resume** to continue elsewhere. Nothing is lost.
- **Composer**: Enter sends, Shift+Enter adds a line. `@` completes file paths; `@codebase <query>`, `@git`, and `@rule <name>` attach search hits, git status, or a rule. `/` shows custom commands and `/compact` `/cost` `/export` `/review`; paste, drop or ⊕ attach images.
- **Review**: the session bar **Review** button (also `/review`) asks the model to read this session's diff and posts the findings. It does not edit files.
- **Right dock**: beside the transcript, **Changes** (with +/−), **Browser**, **Terminal** (commands this session ran), and **Files** (the workspace tree). Click a row to open it; click again to close. New panes are one entry in `DOCK_PANES` (`apps/desktop/src/renderer/src/Dock.tsx`). **▤ Changes** and **◎ Browser** in the session bar open the same panes.
- **Scheduling**: a message like “every weekday at 9 …” shows a **Schedule this?** card. The ⏲ **Automations** screen manages them ([Automations](automations.md)).
- **Context**: the ring in the session bar shows context usage; click for the report (categories, largest items, suggestions, Compact now, Export HTML). The sidebar shows each session's percent; hover to pin or archive.
- **Keys**: Esc stops a run, ↑ recalls your last message, ⌘N new session, ⌘K palette.
- **Session bar**: sandbox, Files, Browser, estimated cost, **Export…**, tokens and cache share, Undo. Edit tool cards show diffs. Hover your message for **↶ Rewind**.
- **⌘K** palette and the sidebar **search**; background **notifications**. See [Everyday conveniences](everyday.md).
- **Queue and stop**: while running, messages are queued and sent when the run ends. **Stop** aborts the run (including a running shell command).
- **Subagent sessions** are nested under their parent in the sidebar; "← back to parent session" returns.
- **Quit** (⌘Q) waits up to a few seconds while the app stops the managed browser, sandboxes, Python kernels and MCP servers it started, so none of them keeps running after the app closes.

## Export transcripts

Export a session as Markdown, HTML, or JSONL from the chat header. Exported text
redacts the configured provider credentials, credential environment values, and
sun device tokens. HTML opens as a self-contained document with inert transcript
content. The session history used by the app stays on its execution host.

## Archived chats and storage

Archive a chat from the session list. Open **Settings → Archived chats** to
search the archive and restore a chat with its existing ID and history.

Use **Settings → Data controls** to download a portable `.sunbundle` or
import a bundle or a legacy JSONL transcript. Portable bundles include saved
images. If the original workspace is missing, enter the absolute path of an
existing workspace on the execution host. Send a new message to continue an
imported conversation under the host's current approval settings.

Use **Settings → Storage** to see usage by category and select eligible
resources. **Preview cleanup** shows the exact selection. If the inventory
changes before confirmation, refresh it and preview again. Archived inactive
chats can be moved to trash. An attachment still referenced by any retained
chat stays protected. After moving a log, refresh to find any newly orphaned
attachments.

Browser profile cleanup requires a separate selection and confirmation.
A stopped local profile can be moved to trash, which removes the sign-in
state from the active browser profile. Worktrees are managed through their
Git workflow. Cleanup applies to the execution host's files. Service
providers manage their own copies and retention.

Trash operations resume after restart and are purged after the configured
grace period, seven days by default. Automatic cleanup is off at zero days.
A positive age moves eligible old archived chats and unreferenced attachments
to trash. Trash grace settings apply to new operations.

## Knowledge

Search every knowledge provider, add a note to the personal KB, and browse or forget long-term memories. Use **Open memory settings** to edit core memory and manage recall.

## Skills · MCP · Plugins

Pick a workspace (top right) to see its skills, MCP servers, and scheduled
tasks. The plugin panel here and in **Settings → Plugins** shows the installed
manifests, requested actions, and current registrations. Disable a plugin to
stop future calls and watch the remaining calls finish.

## Evolution

Pending proposals with **Accept** / **Reject**; history below. **Reflect on current session** asks the model for up to five improvements from the selected session.

## Harness Intel

Dates on the left (yellow dot = analysis pending), the report on the right. **Run now** fetches and analyzes; **Analyze pending** re-runs analysis for a day whose model call failed.

The left rail’s **EN** / **中** button switches English and Simplified Chinese immediately (also in Settings → **Language**: System / English / 简体中文). System follows the OS or browser. The setting is `ui.language` in `~/.sun/config.json`. Every screen is translated; new UI copy has to ship in both languages.

## Settings

Search settings by section or field in English or Simplified Chinese. Edit a
section and select **Save changes**. The app keeps a draft when the host has a
newer revision, so you can reload and review it before saving.

- **Connections** previews a remote gateway certificate and switches the
  execution host after you confirm its fingerprint and authenticate. Personal
  interface preferences remain local when connected to a separate host.
- **Code review** sets the review model, rule sources, display threshold and
  diff budget. The optional completion gate pauses coding runs that have
  findings or omitted changes.

Select **Review** in a session to see findings with file paths, changed line
numbers and quoted evidence. **Check review status** compares the saved
report with the current changes. Run Review again after edits or when a
provider response could not be validated.

- **General** sets the default mode and model, fallback order, approval policy,
  run limits, and auto-resume. **Appearance** sets theme, text size, motion, and
  the startup page.
- **Notifications** controls completion, pause, failure, and approval alerts.
  Enter a time zone such as `Asia/Shanghai` and local start and end times for
  quiet hours. If permission has yet to be requested, select **Allow
  notifications**. Approval requests remain visible in the app.
- **User profile**, **Personal instructions**, and **Memory** edit separate
  files on the execution host. The profile and instructions each have a
  1,375-character limit. You can turn off automatic memory while keeping the
  files and learned facts for later use.
- **Voice input** shows transcription readiness and microphone permission.
  Start recording in a session. **Read aloud** controls playback separately.
- **Keyboard shortcuts** edits the palette and new-chat bindings. For
  **Mini**, turn it on, optionally set a global shortcut, and select **Show
  Mini**. The always-on-top window shows the latest active top-level run.
  **Open chat** returns to its conversation and **Stop run** cancels it on the
  execution host. The panel is available in Electron, including when attached
  to a gateway.
- **Usage** shows the last seven days of efficiency metrics and estimates the
  cost of one selected session from recorded tokens and the host pricing
  table. Models without a price appear as **Unknown price**. If only some
  models are priced, the estimate covers those models.
