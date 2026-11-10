# Shell sandbox

Commands the agent runs (its `bash` calls, background jobs, the project checks after edits) run in a sandbox: they can change your project, not your machine, and cannot read your credentials.

```bash
sun sandbox status        # which sandbox is in use
sun sandbox test          # quick self-test: write inside the workspace works, write to ~ is blocked
```

## What the default (`auto`) does

- macOS: Apple's seatbelt (`sandbox-exec`). Linux: bubblewrap (`bwrap`, install it with your package manager). Elsewhere: no sandbox (the header shows "no sandbox").
- Writable: the workspace, temp folders, package caches (`~/.npm`, `~/.cache`, `~/Library/Caches`, pnpm, yarn, cargo, Go, Gradle, Maven), the repository's `.git` (so commits in worktrees work), and anything in `sandbox.writable`.
- Hidden: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.kube`, `~/.docker/config.json`, shell rc files, and `~/.sun` (except skills, plugins, kb, workspace, worktrees).
- Secret environment variables (provider keys, bot tokens, `*_API_KEY`, `*_TOKEN`) are removed from the command's environment.
- Network: on.

The agent is told about the sandbox, so when a command fails with "Operation not permitted" it explains what it needs instead of retrying.

## Network control

In `~/.sun/config.json`:

```json
{ "sandbox": { "network": "allowlist", "allow": ["github.com", "*.github.com", "registry.npmjs.org", "pypi.org", "files.pythonhosted.org"] } }
```

- `off`: no network except localhost (local test servers still work).
- `allowlist`: only the listed hosts, through a local proxy sun starts (`*.example.com` includes subdomains). Most tools (curl, git over HTTPS, npm, pip, Node) use it automatically.

## Docker

For stronger isolation, run each session in its own container where only the workspace is visible:

```bash
sun chat --sandbox docker
```

or set `"sandbox": { "mode": "docker", "docker": { "image": "node:22-bookworm-slim" } }`. The container starts on the first command and is removed when you delete the session or quit. Use an image with the tools your project needs (Node, Python, compilers).

## Fewer approval prompts

Commands that cannot write outside the workspace are much less risky. With `"sandbox": { "autoApprove": true }` and approval mode `auto-edit`, sandboxed shell commands run without asking (like Codex's workspace-write mode). Settings → Shell sandbox has the same switch.

`sun sandbox test` checks both a workspace write and an outside write. It
exits with an error when the backend fails to start or either probe produces
an unexpected result.

## When a command needs more

- One more writable folder: add it to `sandbox.writable`.
- `git push` over SSH or a global install: run it yourself, or start the session with `--sandbox off`.
- Desktop: Settings → Shell sandbox (mode, network, allowlist, auto-approve). The session header shows the active sandbox.
