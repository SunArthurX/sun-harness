# 0007 — Shell commands run in an OS sandbox by default; containers are opt-in

## Context

The agent runs arbitrary shell commands (its own, the project's tests, scripts it wrote). Approval prompts are the only guard today, and they fail in both directions: people stop reading them, and `full-auto` (evals, bots, schedules) skips them. Options: an OS sandbox around each command (macOS seatbelt, Linux bubblewrap/landlock), a container per session (Docker), or a VM per session (Manus-style).

## Decision

One exec interface (`ExecSandbox.shell(command, cwd)` + `env()`) used by the `bash` tool, background jobs, the verify gate, and best-of-N judging. `sandbox.mode: auto` picks the OS sandbox when it works (seatbelt on macOS, bubblewrap on Linux) and runs unsandboxed otherwise; `docker` is opt-in per config or session. The OS profile allows writes only to the workspace, temp directories, package caches, and the repository's git directory; hides credentials (`~/.ssh`, cloud configs, shell rc files) and the harness's own state (tokens) from reads; and scrubs the harness's secret environment variables. Network is `on` by default, `off` or `allowlist` (through a local CONNECT proxy) by choice.

## Consequences

- Safety without new dependencies or startup cost on macOS and most Linux machines; a command writing outside the workspace fails with "Operation not permitted", and the system prompt tells the model so.
- Docker gives stronger isolation (only the workspace is visible) at the price of an image, a container per session, and tools that differ from the host's.
- With `allowlist`, the OS sandbox enforces "loopback only" and the proxy enforces the host list; inside Docker the allowlist relies on the proxy environment and is best-effort.
- Some workflows need more access (global installs, `git push` over SSH). They need `sandbox.writable`, `--sandbox off` for the session, or the user's own terminal.
