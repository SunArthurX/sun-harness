# T15 release preflight

The desktop and core builds passed the cross-surface checks below.
[T12 signed acceptance](T12.json) subsequently closed the native Computer
Use dependency. The final cross-surface run also checked that the gateway
excludes the native Computer Use settings and rejects its RPC.

| Command | Observed coverage | Output |
| --- | --- | --- |
| `node apps/desktop/e2e/settings.mjs` | Bilingual desktop and gateway Settings, validation, approvals, storage, browser grants, review, web capability boundaries | [Settings](T15-settings.txt) |
| `node apps/desktop/e2e/settings-remote.mjs` | Pinned gateway identity, revocation, interrupted connections, remote job and output recovery | [Remote](T15-preflight-remote.txt) |
| `node apps/desktop/e2e/browser-backends.mjs` | Real external and Docker Chromium ownership and approved file transfers | [Browser](T15-preflight-browser.txt) |
| `node apps/desktop/e2e/execution-docker.mjs` | Real isolated Docker execution and cancellation | [Docker](T15-preflight-docker.txt) |
| `node apps/desktop/e2e/credentials.mjs apps/desktop/release/computer-verified/mac-arm64/sun-harness.app` | Keychain-backed private sign-in and isolation on the current signed bundle | [Credentials](T15-preflight-credentials.txt) |
| `node scripts/settings-qualification.mjs --validate` | All three untouched handoff fixtures fail and all frozen references pass | [Offline handoff](T15-offline-preflight.txt) |

The new ad-hoc signature prompted for system Keychain access. An early
credential run timed out while that prompt was pending, while the
[earlier signed bundle](T15-preflight-credentials-baseline.txt) passed.
After the user authorized the new signature, the current signed test
passed as well. The fixture now allows time for the system prompt.
[Electron safeStorage signing guidance](https://www.electronjs.org/docs/latest/api/safe-storage)

## Handoff iterations

| Public prompt iteration | Outcome | Report |
| --- | --- | --- |
| Original | 8/9. A settings attempt passed the judge and exhausted the model steps before the final response. | [First run](qualification-post-t15-deepseek/report.json) |
| Explicit finish rule | 8/9. An attachment replay attempt used a returning stub for a test that expected an exception and exhausted its steps. | [Second run](qualification-post-t15-deepseek-v2/report.json) |
| Multiline revision with incomplete extraction | Stopped after two attempts when the runner was found to read only the first paragraph. | [Interrupted run output](T15-model-run-v3.txt) |
| Full public quote with rejection and finish rules | 9/9 first-attempt passes across all three fixtures and repetitions. | [Final run](qualification-post-t15-deepseek-v4/report.json) |

The runner now reads and fingerprints the full public quote. A regression
test asserts that both the rejection-test guidance and the finish rule reach
the live prompt. The fresh nine-attempt run used that prompt and the frozen
judge. The offline check and earlier live runs remain separate evidence.
See the [release acceptance record](T15.json) for the full matrix.
