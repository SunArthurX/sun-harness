# 001 — Core runtime

Status: implemented (M1). Code: `packages/core/src/{log,messages,agent,host,providers,tools,policy}.ts`.

## Session log

- One append-only JSONL file per session: `~/.sun/sessions/<id>.jsonl`. Each line is a `SessionEvent` with `seq` and `ts`.
- Event types: `session/meta`, `session/title`, `user/message`, `request/header`, `assistant/message`, `tool/result`, `approval/request`, `approval/decision`, `run/status`, `model/switch`, `mode/switch`, `context/compaction`, `todo/update`.
- **Invariant — model-visible means logged.** The system prompt and tool list are logged as `request/header` whenever they change; messages are derived from the log by `deriveMessages()`.
- A torn last line (crash mid-write) is ignored on load.

## Loop

- `Agent.run()` is stateless between calls. Each step: execute pending tool calls → if a request is owed (latest conversational event is user input or a tool result) call the model → log the assistant message → repeat. Ends `idle` when nothing is owed.
- `run()` doubles as `resume()`: crash, abort, quota pause, and model switch all resume from the log.
- Every assistant tool call is paired with a result before the next request; interrupted calls get a synthetic result.
- Messages sent during a run are queued and delivered when it ends.
- A new session is titled from its first user message when it is sent (so sessions that pause before any reply are recognizable).
- `maxSteps` (default 60) pauses with reason `max_steps`; finishing exactly on the last step is `idle`.

## Providers

- `openai` wire format (DeepSeek, OpenAI, GLM, Qwen/DashScope, Gemini compat, OpenRouter, Ollama) and `anthropic` Messages API. Streaming SSE, tool calls, reasoning deltas, usage.
- Model refs are `provider/model`; the model part may contain `/`.

## Error taxonomy and reactions

| Kind | Examples | Reaction |
|---|---|---|
| `rate_limit` | 429 without quota wording, 529 | retry with backoff (max 5, honors Retry-After), then pause |
| `network` | fetch failure, 5xx, empty response | retry with backoff, then pause |
| `quota` | 402; 429/403/400/401 with balance/quota/billing wording (incl. 余额/额度/配额) | try `fallbackModels`, else **pause** |
| `auth` | 401/403 | try `fallbackModels`, else **pause** |
| `context_length` | 400 "maximum context" | force compaction, retry once |
| `aborted` | user stop | status `aborted` |

## Durability (quota recovery)

- Paused sessions keep everything on disk. Recovery paths: `resume(id)` (same model, after quota restore), `resume(id, {model})` (logs `model/switch`), automatic fallback chain, and the auto-resume tick (`autoResume.intervalMinutes`, default 15) for `quota`/`rate_limit`/`network` pauses.
- On host start, sessions left `running`/`awaiting_approval` become `paused: interrupted`.

Decision — CLI process status. `sun run` and `sun resume` use the same
exit-code contract. A finished run exits with `0`, a paused run with `3`,
and an error or abort with `1`. This preserves the distinction between a
recoverable pause and a terminal failure for shell callers.

## Compaction

- When the derived history exceeds `compaction.thresholdTokens`, older history up to a clean boundary (no outstanding tool calls) is summarized into a `context/compaction` event; the most recent `keepRecent` events stay verbatim.

## Tools and policy

- Built-ins: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `bash`, `web_fetch`, `web_search`, `todo_write`; service tools: `kb_search`, `kb_add_note`, `memory_save`, `load_skill`, `task`, `schedule_task`.
- Each tool has a risk: `read | write | exec | network`. Approval modes: `suggest` (ask for non-read), `auto-edit` (ask for exec/network and writes outside the workspace or `~/.sun`), `full-auto` (never ask). `allow_always` is remembered per session from the log. See `specs/008-approval-policy.md`.
