# 015 — Background jobs that survive restarts

Status: implemented (iteration 8). Amends `specs/011-background-jobs.md` (jobs used to die with the host and were marked `lost`).
Code: `packages/core/src/jobs.ts` (`startProcess`, `restore`, `restorableJobIds`), `host.ts` (`init`, `dispose`).

## Behavior

- A process job runs a wrapper `bash -c "$SUN_JOB_CMD" >>"$SUN_JOB_LOG" 2>&1; echo $? > "$SUN_JOB_EXIT"` (atomic write via a temp file), spawned **detached** in its own process group with stdio ignored, so it outlives the host.
- Metadata is written to `~/.sun/jobs/<id>.json` (`id, sessionId, command, cwd, pid, logFile, exitFile, startedAt`); output in `<id>.log`; exit status in `<id>.exit`.
- Completion is detected by polling (500 ms) for the exit file; if the wrapper is gone without one, the job is `lost`. A pid is only trusted if its command line contains the wrapper marker (protects against pid reuse).
- **Restore**: on host start, after the interrupted-run cleanup, `jobs.restore()` loads every running job record:
  - exit file present → finish now (`done`/`failed` + exit code) and deliver into the session (which may start a run);
  - wrapper alive → keep watching and deliver when it ends;
  - otherwise → `lost`, delivered too (the agent can restart it).
  Restored jobs are marked `reattached`. Only jobs with no record (promoted tool calls, pre-0.3 jobs) are marked `lost` at start-up.
- `dispose()` detaches from jobs instead of killing them; `jobs.killOnExit: true` restores the old kill-on-exit behavior. `job_kill` / **Stop** kill the whole process group (SIGTERM, then SIGKILL after 3 s).
- Promoted (slow MCP) calls live in the host's memory and still cannot survive a restart.

## Why

With the gateway (specs/012) a restart happens on upgrades, crashes, or `kill`. Long builds and test runs should not be thrown away because the owner process changed.
