# Modes

| Mode | Use it for | Behaves like |
|---|---|---|
| **Coding** | changing a repository | reads first, follows specs and rules, makes minimal edits, runs tests, summarizes |
| **Agent** | open-ended tasks: research, analysis, writing, data work | plans with a todo list, searches and fetches the web, delegates sub-tasks, writes deliverable files, cites sources |
| **Assistant** | daily help, personal knowledge, reminders | uses your memory and notes, saves new facts, schedules reminders, stays concise |

Switch modes any time from the session header or `/mode`.

## Subagents

In Agent (and Coding) mode the model can call `task` with a self-contained prompt. A child session runs with its own context and returns a report. Child sessions appear nested under the parent; their approvals show in the parent.

## Schedules

Ask the assistant: "Remind me every weekday at 9:00 to review pull requests" or "At 2026-11-08T15:00 remind me to call Alex". It calls `schedule_task` (cron or ISO time). Due tasks start a new Assistant session while the desktop app is open. Manage them on the Skills · MCP · Plugins screen or with `sun schedules`.

## Custom modes

A plugin can add a mode:

```js
export default (api) => api.registerMode({
  id: 'reviewer', label: 'Reviewer', description: 'Code review only',
  prompt: 'You review diffs. Never edit files.',
  allowTool: (t) => ['read_file', 'grep', 'glob', 'bash'].includes(t.name),
});
```
