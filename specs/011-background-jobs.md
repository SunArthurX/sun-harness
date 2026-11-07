# 011 — Background jobs

Status: implemented (iteration 4). Source: Claude Code 2.1.319 (MCP tasks move to the background; the result is delivered later).
Code: `packages/core/src/jobs.ts`, `host.ts` (job wiring, delivery), `tools/builtin.ts` (`bash.background`), `tools/services.ts` (`job_status`, `job_kill`).

## Principle

A tool call that takes minutes should not block the loop. Split "invoked" from "finished": the loop continues, and completion re-enters the context as a new, logged turn.

## Behavior

- `bash` with `background: true` starts the command (`bash -c`, workspace cwd) as a job and returns its id at once. Output goes to `~/.sun/jobs/<id>.log`.
- MCP tool calls still running after `jobs.promoteAfterMs` (default 30 000; 0 disables) are **promoted**: the model gets a notice with the job id, and the call keeps running.
- Events: `job/started {jobId, name, command}`, `job/finished {jobId, name, state: done|failed|killed|lost, exitCode?}`.
- Delivery: when a job ends (not killed), the host appends `user/message {source: "job"}` with the state, exit code and the last ~6 000 chars of output, then starts a run (or queues the message if one is running). Model-visible means logged: the delivered text is in the log.
- `job_status(id?)` lists the session's jobs, or shows one job's state and output tail. `job_kill(id)` stops a job (SIGTERM, then SIGKILL after 3 s); killed jobs are not delivered.
- On host start, jobs logged as started but never finished are marked `lost` (their processes did not survive the app).
- On host dispose, running process jobs are killed. Aborting a session's run does not kill its jobs.
- `sun run` waits for the session's running jobs and their delivery turns before exiting.

## Surfaces

Desktop transcript: a job line (pulsing while running, **Stop**), a finished divider, and the delivered result as a collapsible block.
