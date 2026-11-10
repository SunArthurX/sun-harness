# T07 progress — Hook trust, execution, and settings

The hook portion of T07 is implemented. T07 remains in progress for plugin
manifest disclosures and disable/drain state.

## Behavioral evidence

- Unreviewed hooks remain inert. Batch review rejects stale digests without
  granting any row in the batch. Changes to the same source invalidate its
  trust, and dispatch rechecks it between commands. Invalid matchers and
  malformed policy sources produce diagnostics and fail closed when relevant.
- The runtime and fixture runner share sandbox preparation, a restricted
  environment, a combined 64 KiB output limit, and process-group termination.
  Tests exercise a credential sentinel, excess output, timeout and explicit
  cancellation. Cancelling a real session-start hook prevents its delayed
  child and the model request. A macOS sandbox test protects the settings
  directory even when the hook workspace contains it.
- Docker hook execution creates a dedicated stopped container before attaching
  and starting it. Cancellation force-removes that invocation container.
  The cached default image was exercised offline with real timeout and cancel
  runs. Both containers were removed and neither delayed child wrote a file.
  [Docker create](https://docs.docker.com/reference/cli/docker/container/create/),
  [Docker start](https://docs.docker.com/reference/cli/docker/container/start/),
  [Docker remove](https://docs.docker.com/reference/cli/docker/container/rm/)
- CLI review, preview, execute, and revoke were exercised with the built CLI.
  Electron and the served web renderer show invalid matchers, preview without
  side effects, save review, run and cancel fixtures, and reject stale trust
  after source edits.
- A scripted provider's model input after post-hook feedback matched the
  messages derived from the durable log exactly.

## Verification

- [Full suite](T07-hooks-test.txt)
- [Build](T07-hooks-build.txt)
- [Typecheck](T07-hooks-typecheck.txt)
- [Electron and web acceptance](T07-hooks-e2e.txt)
- [Built CLI smoke](T07b-cli.txt)
- [Real Docker execution](T07b-docker.txt), reproduced with
  `node apps/desktop/e2e/hooks-docker.mjs`

## Remaining slice

T07c still needs plugin manifest disclosures and a controlled disable
operation. Reuse the existing contribution registry and its stale-tool
revocation. Verify that disabling a plugin rejects queued and future calls
immediately, tracks already-started work until it drains, and exposes the
state through the product entry points. Linux and Windows hook executors
have not been exercised on those operating systems.
