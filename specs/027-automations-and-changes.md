# 027 — Automations and changed files

Status: implemented (0.7.0). Code: `packages/core/src/automation/schedule.ts`, `schedule.ts` (store, catch-up), `host.ts` (proposal flow, automations API, `sessionChanges`, `revertFile`, `readSessionFile`), `gateway.ts`, `bots/bridge.ts`, desktop `pages.tsx` (`AutomationsPage`), `Chat.tsx` (`ProposalCard`, turn cards), `Changes.tsx`, CLI.

## Competitor analysis

### Scheduled and automated work

| Product | How a schedule is created | Where it is managed | Runs | Notable |
|---|---|---|---|---|
| ChatGPT Tasks | in the chat ("remind me every morning…"); the model proposes, the user confirms | Tasks list (pause, edit, delete) | in the cloud; push/email notification | intent extraction from plain language; one place to manage |
| Cursor Automations / background agents | from a rule or trigger (schedule, events) | Automations dashboard with run history | cloud agents, results as PRs or messages | each run is a full agent session you can open |
| Manus scheduled tasks | from a finished task ("repeat this daily") | task list with run history | cloud sandbox | runs keep their deliverables |
| Claude Code / Codex CLI | none built in (cron + headless `-p`, GitHub Actions) | external | local or CI | headless JSON output makes scripting possible |
| Zapier / n8n | visual trigger builder | flow list, execution log | cloud | missed-run and error handling as first-class concerns |

What users get from the best of them: say it in plain language, confirm what was understood (with the next run times), manage everything in one menu, open any run as a normal session, be told when a run finishes, and not lose runs while the laptop sleeps.

### Seeing what a conversation changed

| Product | During the turn | After the turn | Review surface |
|---|---|---|---|
| Cursor | inline diffs per edit | "N files changed" with accept/reject per file | review pane, per-file revert |
| Codex (app/CLI) | patch previews | summary of files with +/− | diff view per file |
| Claude Code | diff per edit | summary in the final message | `/rewind` checkpoints |
| Cline | diff per edit with approve | checkpoint compare / restore | side-by-side diff |
| GitHub PR | — | files changed list | file tree + diff, per-file viewed state |

What users get from the best of them: a short summary at the end of each turn, one click from a file name to its diff or full content, a whole-session review with a file tree, and a safe per-file "put it back".

## Plan (and what was built)

1. Natural-language schedules (EN + ZH) with strict intent rules → `parseSchedule`, `describeCron`, `nextRuns`, `missedRun`.
2. Proposal flow in the host for every surface (desktop card, CLI prompt, bot `/yes` `/both` `/no`).
3. Automations: store extensions, run history, catch-up, notifications, edit/pause/run now, API, desktop menu page, CLI, bots.
4. Changes: per-range computation from checkpoints, revert (undoable, model told), file reader; turn card, session review (tree + diff + file), CLI and bot summaries.

## Natural-language schedules

`parseSchedule(text, now, {explicit?})` → `{cron | at, description, prompt, phrase}`.

- Recurring (always an intent): `every N minutes|hours`, `every hour`, `every day|morning|evening|weekday [at T]`, `daily|weekdays at T` (bare `daily`/`hourly`/`monthly` only at the start or end of the message), `every monday and thursday at T`, `every month on the Nth at T`; Chinese `每(隔)N分钟/小时`, `每小时`, `每天/每日/每个工作日 [早上|下午|晚上]N点[半|M分]`, `每周一、三…`, `每月N号`. Times: `9`, `9am`, `9:30 pm`, `21:00`, `noon`, `midnight`, `十点`, `下午3点半`.
- One-shot (`in N minutes|hours|days`, `N小时后`, `tomorrow|today|tonight [at T]`, `明天/后天/今天/今晚 …`, `on YYYY-MM-DD [at T]`) only with a scheduling verb (remind, schedule, run, check, send, notify, 提醒, 定时, 执行, 检查, 发送, …), unless `explicit` (the schedule field of a form).
- The schedule phrase is removed from the prompt.

*Decisions (from the test sentences):* "every month" matched "every mon…" (day names need a word boundary; monthly is checked first); "fix the daily report generator bug", "refactor the monthly billing job", "make hourly rate configurable" must not schedule anything.

## Proposal flow

Typed user messages (not commands, not runs started by schedules/triggers, not `noDetect`: `sun run`, evals, best-of-N) with an intent are logged and followed by `automation/proposal {proposalId, title, prompt, cron|at, description}`; no run starts. `resolveProposal(session, id, 'create' | 'both' | 'run', edits?)` logs `automation/resolved`; `create`/`both` create the automation (mode and workspace of the session) and append an assistant message from `model: 'harness'` stating what was scheduled, so the conversation stays coherent for the model; `run`/`both` start the run on the original message. Answering twice is an error. `automations.detect: false` turns detection off.

## Automations

Stored in `~/.sun/schedules.json` (compatible with earlier schedules): `title, prompt, mode, cwd, cron | at, enabled, model?, chats?, catchUp?, source?, schedule?, runs[]` (newest first, ≤ 20: `at, sessionId, status, reason?, catchUp?`).

- API: `listAutomations` (with `description`, `nextRun`, `lastStatus`), `createAutomation({schedule | cron | at, …})`, `updateAutomation(id, patch)` (schedule text re-parsed; `enabled` pauses), `deleteAutomation`, `runAutomation(id)`, `previewSchedule(text)` (cron or language → description and next three runs).
- Execution (gateway/desktop background tick, each minute): due tasks plus catch-ups — a cron task whose scheduled minute passed since `lastRun` (within 24 h, `catchUp !== false`) runs once, with a note in the prompt. Each run is a new session `[automation] title` (mode, workspace, model of the automation); the run is recorded as `running` and updated with the final status; `LiveEvent {kind: 'automation'}` announces start and end.
- Notifications: desktop OS notification when a run ends while the window is in the background (click opens the run); bot chats in `chats` receive the answer.
- `schedule_task` (model tool) is available in all modes and records `source`.

Surfaces: desktop ⏲ Automations page (list, on/off, Run now, Edit, History with links to runs, Delete; form with plain-language schedule and live preview, title, mode, model, workspace, chats, catch-up); CLI `sun automations list | add "<when>" "<prompt>" | preview | run | pause | resume | edit | rm | history`; bots `/automations`, `/yes` `/both` `/no`.

## Changed files

`sessionChanges(session, {fromSeq?, toSeq?})` → `FileChange[] {path, abs, status: added | modified | deleted, additions, deletions, diff, binary}`: for every file in a checkpoint within the range, the content before the first such checkpoint against the content after the range (the next checkpoint's snapshot, or the file on disk). Unchanged files (edited and restored) are omitted; for the whole session, files tools wrote without checkpoints (screenshots, figures) are listed as added. Diffs count a final newline as the end of the last line (it is not an extra line).

`revertFile(session, path, {fromSeq?})`: restores the file as it was before the session (or before `fromSeq`), deleting files the session created; it is checkpointed first (undo brings the change back), logs `file/revert`, and appends a system message telling the model to read the file again. `readSessionFile(session, path)`: workspace-only, 1 MB cap, binary detection.

Surfaces: desktop — after every turn that changed files, a card "N files changed +a −d" (A/M/D, per-file +/−; click a file for Diff with line numbers or File, plus Open, Copy path, Revert-to-before-this-turn); "▤ Changes" opens the session review (collapsible tree, Diff/File pane, Open, Copy path, Revert); CLI — summary after each chat turn and `sun run`, `/changes [all]`, `/diff [path]`, `/revert <path>`, `sun changes <id> [--diff | --json]`; bots — "📝 N files changed" after a turn.
