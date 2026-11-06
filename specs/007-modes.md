# 007 — Modes

Status: implemented (M2). Code: `packages/core/src/modes.ts`.

A mode is a system prompt + a tool filter (+ optional default approval). Plugins can register more modes.

| Mode | Like | Prompt focus | Tools |
|---|---|---|---|
| `coding` | Claude Code, Codex | understand → spec-first minimal edits → verify → summarize | all except `schedule_task` |
| `agent` | Manus | plan with `todo_write`, research with web tools, delegate with `task`, deliver files, cite sources | all |
| `assistant` | Hermes, WorkBuddy | memory first, KB lookups, reminders via `schedule_task`, concise and warm | files (read/write/list), web, todo, KB, memory, skills, task, schedule, plus all non-builtin tools |

- Default workspace: `coding` uses the chosen folder; `agent` and `assistant` default to `~/.sun/workspace`.
- Subagents (`task` tool) run in a child session (`parent` set), inherit cwd and model, cannot spawn further subagents, and surface their approvals in the parent session.
- Switching mode mid-session logs `mode/switch`; the next request uses the new prompt and tool set.
- Scheduled tasks (`~/.sun/schedules.json`, one-shot `at` or 5-field cron) start new `assistant` sessions while the desktop app runs.
