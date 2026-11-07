# 014 — Packaged macOS app

Status: implemented (iteration 7). Code: `apps/desktop/package.json` (`build`), `electron.vite.config.ts`, `scripts/make-icon.cjs`, `scripts/adhoc-sign.mjs`, `core/src/env.ts` (`augmentPath`).

## Build

- `pnpm desktop:package` → `apps/desktop/release/mac-arm64/sun-harness.app`; `pnpm desktop:install` also copies it to `~/Applications`.
- The main process bundles `@sun/core` and the MCP SDK, so the app contains only `out/**` (no `node_modules`); its imports are Node built-ins and `electron`.
- electron-builder reuses the local Electron binary (`electronDist`), so packaging works where GitHub release downloads are blocked.
- Signing: `identity: null` skips Developer ID signing; `scripts/adhoc-sign.mjs` ad-hoc signs (`codesign --force --deep --sign -`) and verifies, which is enough to run on the build machine (Apple Silicon requires a signature). Distribution to other Macs needs a Developer ID and notarization (not automated).
- Icon: `build/icon.png` (1024², rendered from SVG by `scripts/make-icon.cjs`); electron-builder converts it to `.icns`.

## Runtime environment

A Finder-launched app gets `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and no shell variables. At start the app:

1. imports credential variables (`importCredentialEnv`, specs/004);
2. appends user tool locations to `PATH` (`augmentPath`): Node's own dir, nvm's default version, Homebrew, `/usr/local/bin`, `~/.local/bin`, pnpm, bun, cargo, volta, go. Existing entries keep priority; duplicates are skipped.

The CLI does the same, so launchd jobs (intel, gateway) find `node`, `npx`, `git` and friends.

## Verification

Launching the packaged binary with `PATH=/usr/bin:/bin:/usr/sbin:/sbin` runs a live session whose MCP server is started as plain `node`; `open ~/Applications/sun-harness.app` launches via LaunchServices.
