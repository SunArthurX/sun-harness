# Modes

| Mode | Use it for | Behaves like |
|---|---|---|
| **Coding** | changing a repository | reads first, follows specs and rules, makes minimal edits, runs tests, summarizes |
| **Plan** | designing a change before touching code | read-only exploration; ends with a plan you approve, then continues in Coding mode ([details](coding.md#plan-mode)) |
| **Agent** | open-ended tasks: research, analysis, writing, data work | plans with a todo list, searches and fetches the web, fans independent items into fresh subagents (`wide_research`), writes deliverable files and slide decks, cites sources |
| **Assistant** | daily help, personal knowledge, reminders | uses your memory and notes, saves new facts, schedules reminders, stays concise |

Switch modes any time from the session header or `/mode`.

## Subagents

In Agent (and Coding) mode the model can call `task` with a self-contained prompt. A child session runs with its own context and returns a report. Child sessions appear nested under the parent; their approvals show in the parent.

`wide_research` is the bounded form of that for a list: a question plus 2–8 items. Each item gets its own subagent, and the notes are written to `research/<question>.md` for the parent to synthesize. It does not start hundreds of machines.

`make_slides` writes `slides/<title>.html` (arrow keys move between slides) and `slides/<title>-notes.md`. Open the HTML from **Deliverables** in the session bar.

## Schedules

Ask the assistant: "Remind me every weekday at 9:00 to review pull requests" or "At 2026-11-08T15:00 remind me to call Alex". It calls `schedule_task` (cron or ISO time). Due tasks start a new Assistant session while the gateway (`sun gateway install`) or the desktop app is running. Manage them on the Skills · MCP · Plugins screen or with `sun schedules`.

## Custom modes

A plugin can add a mode:

```js
export default (api) => api.registerMode({
  id: 'reviewer', label: 'Reviewer', description: 'Code review only',
  prompt: 'You review diffs. Never edit files.',
  allowTool: (t) => ['read_file', 'grep', 'glob', 'bash'].includes(t.name),
});
```
