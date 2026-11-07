# Durability and quota recovery

Every session is an append-only log on disk (`~/.sun/sessions/<id>.jsonl`). A run can stop for any reason and continue later from exactly where it was, because the loop re-derives its state from the log.

## When a model runs out of quota

1. The provider returns a quota error (for example DeepSeek `402 Insufficient Balance`, OpenAI `insufficient_quota`, GLM `余额不足`).
2. If you configured `fallbackModels`, the session switches to the next one automatically (logged as a model switch) and continues.
3. Otherwise the session **pauses** with reason `quota`. Nothing is lost; the pending request is simply not sent.

Recover in any of these ways:

| Situation | Desktop | CLI |
|---|---|---|
| Quota restored / topped up | **Resume** on the banner (or wait for auto-resume) | `sun resume <id>` |
| Use another model now | choose a model, **Switch & resume** | `sun resume <id> --model qwen/qwen3-coder-plus` |
| Key was wrong (`auth`) | fix the env var / config, then **Resume** | fix, then `sun resume <id>` |

Auto-resume (desktop): every `autoResume.intervalMinutes` (default 15), sessions paused for `quota`, `rate_limit`, or `network` are retried. If the quota is still exhausted, they pause again.

## Other pause reasons

| Reason | Meaning |
|---|---|
| `rate_limit`, `network` | 5 retries with exponential backoff failed |
| `max_steps` | the run hit `maxSteps`; resume to continue |
| `interrupted` | the app quit or crashed mid-run; resume to continue |

## Intel and quota

If the daily intel analysis fails for quota, the report is saved with raw items and marked "Analysis pending". Run `sun intel analyze <date>` (or **Analyze pending** in the desktop) after recovery.

## Long sessions

Each model has a context window (built-in table, or `providers.<id>.modelContext` in config). When history grows past the window minus `compaction.buffer` (default 25%), older turns are summarized into a compaction event; recent turns stay verbatim. A provider "context length exceeded" error forces a compaction and one retry.

Switching to a smaller model is safe: if the history no longer fits, the **previous** model writes the summary before the new model sees anything. If the previous model is unavailable (it ran out of quota), the new model summarizes a trimmed transcript instead.

```json
{ "providers": { "ollama": { "modelContext": { "qwen3-coder": 65536 } } }, "compaction": { "buffer": "20%" } }
```
