# 0002 — Electron for the desktop app

## Context

The core is TypeScript on Node: child processes, the file system, the MCP SDK. The desktop must host that core.

## Decision

Electron with electron-vite. The main process bundles `@sun/core` and owns one `HarnessHost`; the renderer is sandboxed React talking over one allowlisted IPC channel.

## Alternatives

Tauri: smaller binaries, but it would need a Node sidecar or a Rust port of the core. A web UI served on localhost (DeepSeek Harness style) is possible later from the same host API.

## Consequences

One runtime shared by the CLI and desktop; a larger app size; macOS GUI apps need explicit credential import (see `env.ts`).
