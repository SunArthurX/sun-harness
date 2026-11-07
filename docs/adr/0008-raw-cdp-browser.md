# 0008 — Browser automation over raw CDP, not Playwright

## Context

Agent and assistant modes need a real browser. Options: Playwright (rich API, auto-waiting, but a large dependency with its own browser downloads, awkward to bundle into the Electron main process and the single-file CLI), Puppeteer (similar trade-offs), or the Chrome DevTools Protocol directly.

## Decision

Implement a small CDP client over the WebSocket built into Node 22+ and drive Chrome with ~15 protocol methods: targets, Page, Network (for "network quiet"), DOM box models, Input events, Accessibility trees, screencast. The same client talks to a local Chrome, a Chromium in the sandbox container (through socat), or any DevTools endpoint.

## Consequences

- Zero new dependencies; works in the desktop bundle, the CLI bundle and the gateway alike; the user's installed Chrome is reused (no browser download).
- Waiting is heuristic (load event + network quiet) rather than Playwright's per-action actionability checks; snapshots after every action and refs from the accessibility tree keep the model on solid ground.
- Playwright remains possible later through `connectOverCDP` against the same endpoints if richer automation is needed.
