# 021 — Shell sandbox (phase 2)

Status: implemented. Code: `packages/core/src/sandbox.ts`, `host.ts` (`sandboxFor`, proxy), `tools/builtin.ts` (bash), `jobs.ts`, `verify.ts`, `policy.ts`. ADR 0007.

## Principle

Human in control does not mean a human reads every command. The shell must be safe by construction: a command can change the workspace, not the machine, and cannot read the user's credentials.

## Unified exec interface

`ExecSandbox { kind, describe(), shell(command, cwd) → shell string, env(base) → env, dispose?() }`. Every agent-driven shell execution goes through the session's sandbox: the `bash` tool, background jobs (the job wrapper runs outside; the command inside), the verify gate, and best-of-N judging. User-configured hooks are not sandboxed (the user wrote them).

The host creates one sandbox per session (`sandboxFor`), from `meta.sandbox` (set at `createSession({sandbox})`, CLI `--sandbox`) or `config.sandbox.mode`.

## Backends

| Mode | When | Isolation |
|---|---|---|
| `auto` (default) | seatbelt on macOS if `sandbox-exec` can apply a profile here; bubblewrap on Linux if `bwrap` exists; otherwise none | OS |
| `seatbelt` | macOS | profile: `(allow default)`, `(deny file-write*)` except workspace, git common dir, `/private/tmp`, `/private/var/folders`, package caches, `sandbox.writable`; `(deny file-read-data)` on `sandbox.denyRead` and `~/.sun` (re-allowing `skills`, `plugins`, `kb`, `workspace`, `worktrees`, and the workspace) |
| `bwrap` | Linux | `--ro-bind / /`, tmpfs over denied paths and `~/.sun`, read-only re-binds of the readable parts, `--bind` for writable roots, `--unshare-net` when network is off |
| `docker` | opt-in | container `sun-sb-<session>` (`sandbox.docker.image`, default `node:22-bookworm-slim`), only the workspace bind-mounted at the same path, `--network none` when off; started on first command, removed on session delete and host dispose; Linux runs as the host uid |
| `off` | — | none |

An explicitly requested backend that is unavailable does not fall back silently: commands fail with "Shell sandbox unavailable: …".

Metadata reads (`stat`) stay allowed under denied paths; only contents are hidden (Node's `realpath` must be able to `lstat` parent directories).

## Secrets

With `scrubEnv` (default on), sandboxed commands do not receive the environment variables named by any `*Env` field of the config (provider keys, bot tokens) or matching the credential pattern (`*_API_KEY`, `*_TOKEN`, `*_BASE_URL`, `*_API_BASE`). Default `denyRead`: `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.netrc`, `~/.config/gh`, `~/.kube`, `~/.docker/config.json`, shell rc files.

## Network

`sandbox.network`: `on` (default), `off` (OS: deny all but loopback and unix sockets; Docker: `--network none`), `allowlist`. With `allowlist`, the host starts an HTTP proxy on `127.0.0.1:<random>` that accepts `CONNECT` and absolute-URL requests only for `sandbox.allow` hosts (`*.domain` matches subdomains and the domain), answers 403 otherwise, and records refused hosts. Sandboxed commands get `HTTP(S)_PROXY`, `ALL_PROXY`, `npm_config_*proxy`, `NODE_USE_ENV_PROXY=1`, `NO_PROXY=localhost`. The OS sandbox only allows loopback, so the proxy is the only way out.

## Approval

`sandbox.autoApprove` (default off): in `auto-edit`, `bash` calls run without asking when the session's sandbox is not `none`. `suggest` still asks; `full-auto` never asks.

## Model visibility

When a sandbox is active, the system prompt's environment section says which one, that writes outside the workspace fail with "Operation not permitted", and the network policy. The prompt is logged in `request/header`.

## Surfaces

`sun sandbox status | test` (self-test: write inside works, write to `~` fails), session flag `--sandbox`, desktop header chip (`⛉ seatbelt` / `no sandbox`), Settings (mode, network, allowlist, auto-approve), gateway method `sandboxInfo`.
