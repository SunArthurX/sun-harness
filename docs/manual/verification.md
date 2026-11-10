# Verify a local build

Run these commands from the repository root.

```sh
pnpm build
pnpm typecheck
pnpm test
node --test packages/cli/e2e/product.mjs
node apps/desktop/e2e/chat-product.mjs
node apps/desktop/e2e/settings.mjs
node apps/desktop/e2e/settings-remote.mjs
node apps/desktop/e2e/smoke.mjs
```

The chat fixture starts Chrome with `--use-mock-keychain` through a
temporary launcher because the fixture's isolated `HOME` has no macOS
login keychain. It also fails if a managed Chromium is still running after
the desktop app quits.

The CLI and chat fixtures use temporary state and a loopback model. The
tests exercise normal entry points, including an actual CLI gateway
process. The launch-agent fixture records installation commands without
changing the owner’s service. `SUN_TEST_DOCKER=1 pnpm test` includes the
real Docker sandbox case when a local Docker engine is available.

Run `node apps/desktop/e2e/browser-backends.mjs` for real Chromium, file
transfers, and noVNC. Run `node packages/core/e2e/python-figure.mjs` with a
Python environment that has Matplotlib installed to verify PNG output.

The latest results are in the [verification report](../plans/full-product-test/report.md).
Use the [feature ledger](../plans/full-product-test/feature-ledger.md) for
coverage by feature, platform and test level. The [run log](../plans/full-product-test/run-log.md)
links reproductions and fixes. Native macOS checks use a signed app and
synthetic windows or sites. Screen Recording and Accessibility grants are
associated with the tested app. Package native QA builds in place at
`apps/desktop/release/full-product-d17/mac-arm64/sun-harness.app` so the
grants stay on one path. An ad-hoc rebuild changes the code hash, so macOS
may still ask for the grants again. See [Appshots](appshots.md) and
[Computer Use](computer-use.md) for the corresponding controls.
