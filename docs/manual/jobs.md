# Background jobs

Long commands such as test suites, builds and dev servers run in the background while the agent keeps working. Their results come back into the session automatically.

## How it works

- Ask for it ("run the full test suite in the background"), or let the agent decide: the `bash` tool has a `background` option.
- MCP tool calls that take longer than `jobs.promoteAfterMs` (default 30 s) move to the background on their own.
- When a job ends, its exit code and the last part of its output arrive as a new message in the session, and the agent continues from there. If the agent is busy, the message waits until the current run ends.
- The agent can check on jobs (`job_status`) or stop them (`job_kill`).

## In the desktop app

Each job shows as a line in the transcript, pulsing while it runs, with a **Stop** button. When it finishes you see a divider (`done · exit 0`, `failed · exit 1`) and a collapsible block with the output that was delivered.

## In the CLI

`sun run` waits for the session's background jobs and the follow-up turns before exiting. A job that never ends (a dev server) keeps it running; press Ctrl+C to stop.

## Logs and limits

- Full output: `~/.sun/jobs/<job-id>.log`.
- Jobs do not survive quitting the app or CLI; after a restart they are marked `lost` in the session.
- Stopping a session's run does not stop its jobs. Use **Stop** or `job_kill`.

```json
{ "jobs": { "promoteAfterMs": 60000 } }   // or 0 to keep MCP calls in the foreground
```
