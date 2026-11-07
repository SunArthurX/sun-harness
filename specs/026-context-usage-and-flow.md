# 026 — Context usage, steering, titles, shortcuts, pin and archive

Status: implemented (0.6.0). Code: `packages/core/src/ux/context.ts`, `prompt.ts` (`buildSystemPromptSections`), `host.ts` (`contextUsage`, `contextReportHtml`, `setSessionFlags`, `titleSession`, steering via `drainSteer`), `agent.ts`, `log.ts` (summary fields), desktop `Context.tsx`, `Chat.tsx`, `Composer.tsx`, `App.tsx`, CLI, bots.

## Plan (comparison, second round)

| Capability | Seen in | Now |
|---|---|---|
| Per-conversation context usage and a report | Claude Code `/context`, Cursor context tray | ring in every session bar, percent in the sidebar, report panel, `/context`, `sun context`, HTML export |
| Steering while the agent works | Codex, Claude Code | messages typed during a run join at the next step |
| Model-written titles | ChatGPT, Claude | short title after the first run |
| Keyboard habits | Claude Code (Esc, ↑), editors (⌘N) | Esc stops, ↑ recalls, ⌘N new session |
| Pin and archive | ChatGPT, Cursor | pinned group, archived group, `sun pin`/`archive` |

## Context usage

`contextUsage(session)` → `ContextReport` describing the next request, mirroring `deriveMessages` (the latest compaction replaces older events, its summary counts instead):

- **System prompt**, one item per section (`buildSystemPromptSections`: mode instructions, Environment, Project rules, Optional rules, Specs, Repository map, Skills, Knowledge base, Memory, Untrusted content, plugin sections).
- **Tool definitions**, one item per tool offered in the session's mode (name, description, JSON schema).
- **Compaction summary**, **User messages** (typed text; command input as label), **Attached files** (`<attached …>` blocks split out per file/folder), **Images** (~1,000 tokens each), **Recalled memories**, **Assistant messages** (text and tool calls), **Tool results** (grouped per tool, with counts).

Sizes use the compaction estimator (≈ 4 characters per token, CJK one per character). The report also carries the model, its context window and compaction threshold (`contextWindowOf`, `compactionLimit`), the provider-reported usage of the last request (`lastRequest`: input, cached, output), the number of compactions, and suggestions: compact at ≥ 80 % of the threshold; single tool results above 15 % and 2,000 tokens; tool definitions above 25 % with more than 30 tools; project rules above 4,000 tokens; a skills index above 1,500 tokens and 20 %; attached files above 30 %.

Every `SessionSummary` carries `contextTokens` (input + output of the last request, provider-reported) and `contextWindow`, so lists show usage without measuring.

Surfaces: desktop ring + report panel (stacked bar with the compaction threshold, expandable categories, suggestions, Refresh, Compact now, Export HTML) and sidebar percent (red above 80 %); `sun context <id> [--json | --format html -o file]`; chat `/context`; bot `/context`; `sun sessions` column; gateway `contextUsage`, `contextReportHtml`.

*Verified live:* on a deepseek-chat session the estimate was 5.5k tokens against a provider-reported 5,462 input tokens; the report showed the skills index as the largest system-prompt section (2.3k), which added the skills suggestion.

## Steering

`config.steering`: `immediate` (default) or `after-run`. Messages sent while a run is active are prepared as usual (commands, mentions, images) and queued; with `immediate`, the agent takes them at the top of each step, after pending tool calls have results and before the next model request, so they never split a tool call from its result. Messages that arrive during the final model call are taken at the next loop turn of the same run. With `after-run`, the queue is delivered when the run ends (previous behavior).

## Titles

`config.titles`: `model` (default) or `first-message`. `session/title` events carry `source`: `first-message` (from the first message, immediately), `model` (written by the background model after the first idle run: ≤ 6 words, the user's language), `user` (rename). Model titles never replace a user rename and are skipped for subagents and `[eval]`/`[trigger]`-style sessions.

## Pin and archive

`setSessionFlags(id, {pinned?, archived?})` appends `session/flags` (organization only, not model-visible); `SessionSummary.pinned` / `archived`. Desktop sidebar: Pinned group first, Archived (n) collapsed at the end, hover buttons ○/◉ and ↧/↥. CLI: `sun pin | unpin | archive | unarchive <id>`; `sun sessions` hides archived (`--all` shows them) and lists pinned first.

## Shortcuts (desktop)

Esc stops the running session (from the composer or anywhere when no palette is open); ↑ in an empty composer recalls the last message you sent (command input, without attachments); ⌘N / Ctrl+N opens a new session; ⌘K remains the palette.
