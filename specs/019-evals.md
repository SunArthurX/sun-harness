# 019 — Evals and telemetry

Status: implemented (phase 0 of the optimization plan). Code: `packages/core/src/eval.ts`, `telemetry.ts`, `evals/coding/*`, CLI `sun eval`.

## Principle

Measure before optimizing. Every harness change in phases 1–5 is judged by eval numbers, not by intuition.

## Suite format

`evals/<suite>/<task-id>/`:

| File | Purpose |
|---|---|
| `task.json` | `{id, title, category, tier?, language, prompt}` |
| `repo/` | starting workspace (copied into a fresh temp dir, `git init`, committed as the base) |
| `setup.sh` | optional; runs after the base commit (e.g. to create history) |
| `hidden/` | tests copied to `.eval-hidden/` **only after** the agent finished |
| `check.sh` | exit 0 = pass; gets `EVAL_BASE` (base commit) in the environment |
| `solution.sh` | reference solution; never shown to agents |

The coding suite has 36 tasks: 24 standard (bug fixes, features, refactors, edit precision, rule/spec following, git, data) and 12 `hard` (parsers, semver, concurrency, cross-module debugging, log investigation, API migration).

## Validity

`sun eval validate` requires every task to **fail on its untouched repo** (no free passes) and **pass after its reference solution** (fair check, solvable task). Checks test the spec, not one implementation (e.g. compare data, not object prototypes), byte-compare files the agent must not touch, compare diffs against `EVAL_BASE` (not `HEAD`, which the agent may move), and fail fast on slow code.

## Runs

`sun eval run [--label] [--model] [--only a,b] [--concurrency N]` runs tasks in-process with a clean context (no plugins, MCP or shell hooks), `approval: full-auto`, mode `coding`, 10 min per task. Results: `~/.sun/evals/<id>.json`.

Metrics per task (from the session log, `sessionMetrics`): pass, status, steps, tool calls, tool errors, edit calls/failures, tokens in/out, compactions, approvals, duration, per-tool calls/errors. Summary: pass rate, averages, tool error rate, edit failure rate, tokens, by category.

`sun eval list | report [run] | compare <a> <b>` (compare shows metric deltas and per-task fixed/regressed).

## Baselines (2026-11-07)

| Model | Pass | Edit failure rate | Tool error rate | Input tokens (36 tasks) |
|---|---|---|---|---|
| deepseek/deepseek-chat (2 runs) | 100.0% / 97.2% | 0% | 0% | 1.78 M / 2.65 M |
| qwen/qwen-flash | 55.6% | 40.6% | 25.8% | 4.90 M |

The strong model saturates the suite; the weak model exposes harness weaknesses (exact-match edits, unavailable tools offered, invalid tool-call JSON poisoning the session) and is the primary target for phase 1. Token cost is tracked for both.
