# Evals

Measure how well sun-harness solves coding tasks, and whether a change made it better.

```sh
sun eval validate                         # every task fails untouched and passes with its reference solution
sun eval run --label baseline             # all tasks on your default model
sun eval run --label flash --model qwen/qwen-flash --concurrency 6
sun eval run --only js-off-by-one,h-py-semver
sun eval list                             # past runs with pass rates
sun eval report <run-id|label>            # table: pass/fail, steps, tool errors, edit failures, status
sun eval compare baseline after-change    # metric deltas and per-task fixed / regressed
```

Each task runs in a fresh git repository in a temp folder with approvals off (`full-auto`) and no plugins, MCP servers or hooks, so runs are comparable. Hidden tests are copied in only after the agent is done. Runs are saved in `~/.sun/evals/`.

## Reading results

- **Pass rate** — the headline. Run twice: models are random; differences of one task are noise.
- **Edit failure rate** — share of edit/write calls that failed (e.g. text not found). High values mean the agent wastes steps fighting its tools.
- **Tool error rate** — all failing tool calls.
- **Tokens** — cost. Lower with equal pass rate is a real improvement.
- **Status** — `paused (max_steps)` means it ran out of steps; `timeout` means 10 minutes passed.

Use a weaker model (e.g. `qwen/qwen-flash`) to see harness effects: strong models solve most tasks regardless of the harness.

## Adding a task

Create `evals/coding/<id>/` with `task.json`, `repo/`, `hidden/` tests, `check.sh` and a `solution.sh`, then run `sun eval validate`. Make checks test the requirement, not one implementation.
