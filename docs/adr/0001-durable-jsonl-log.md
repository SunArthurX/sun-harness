# 0001 — The session log is an append-only JSONL file and the only run state

## Context

Runs must survive crashes, quota exhaustion, model switches and app restarts. Keeping loop state in memory makes each of those a special case.

## Decision

One JSONL file per session; every model-visible input and every outcome is an event. The agent loop is stateless and derives its next action from the log (`pendingToolCalls`, "is a request owed?"). The system prompt is logged as `request/header` when it changes.

## Consequences

- `run()` is also `resume()`; recovery paths need no extra code.
- Debugging starts by reading one file.
- No database dependency; the cost is an O(n) reload per open, which is fine for personal-scale sessions.
