# 0004 — Scheduled jobs run a self-contained bundle and never source shell rc files

## Context

The daily intel job hung twice under launchd: an interactive login shell ran a conda hook that blocks without a terminal, and node blocked on a macOS privacy (TCC) prompt because the code lived under `~/Downloads`.

## Decision

`sun intel install-schedule` copies an esbuild bundle of the CLI to `~/.sun/bin/sun.mjs` and runs it with node directly. Credentials are imported by parsing simple `export NAME=value` lines (credential-like names only) from rc files and `~/.sun/.env`; nothing is executed and no secret is written to the plist.

## Consequences

The schedule works regardless of where the repository lives. After upgrading, re-run `install-schedule` to refresh the bundle.
