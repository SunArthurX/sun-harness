# Fresh-agent execution protocol

Use this prompt for a future implementation run:

> Implement the first dependency-ready planned task in `docs/plans/settings-competitors/manifest.json`. Read repository instructions, spec 032, ADR 0010, implementation contracts and the selected task card. Use its file anchors to read relevant source and tests in batches. Preserve existing changes and stay within the task's write scope.
>
> Verify the required behavior before and after the smallest implementation. For a rejection test, make the injected dependency actually throw or reject and assert the observed error. Returning an error object tests a normal return. If a check fails, read its first failure and inspect the exact test inputs before changing the implementation. Preserve fixed tests, bilingual copy, capability checks and evidence requirements. Record any contradiction and a Decision before changing a contract.
>
> Work within the run budget. Once the required checks pass and the diff is in scope, send the final response with changed files, test outcomes, unresolved risks and the next dependency-ready task. Use the remaining budget to report a precise blocker if a required check still fails.

## Start

1. Inspect `git status --short` and diffs of intended files. Record dirty files in the evidence report; never reset/stash/delete another change to make a test pass.
2. Run plan checker and its negative tests. Read dependency evidence, not just statuses.
3. Run existing focused tests, then record full baseline when first entering a release slice.
4. Write the task's smallest failing behavioral test first. Verify that it reaches the injected boundary and fails for the expected reason. For a rejection test, make the stub actually throw or reject. Returning an error object exercises a different contract. When a test fails after the edit, check its inputs and observed calls before expanding the fix.
5. Implement the smallest host/service slice; wire gateway/shared allowlist/renderer/CLI together where applicable.
6. Add English and Chinese strings and failure states. Run i18n completeness.
7. Test restart, cancel, unsupported platform, stale state and permission denial where the task requires them.
8. Update specs if behavior changed, user manual, Mermaid teaching page + index, roadmap and changelog. Save evidence, then mark task done only if all gates pass.

## Evidence format

Each evidence JSON contains task, result (`pass` only for done), acceptance IDs actually checked, commands with command/exitCode/outputFile, artifacts (existing repository-relative paths), manualChecks, limitations and rollback. Output files must contain actual captured results. Do not store secrets. The checker validates presence/shape/file references, not semantic truth or authenticity. Code review must inspect tests and reports.

Example shape (illustrative, not evidence):

```json
{
  "task": "T02",
  "result": "pass",
  "acceptance": ["AC-01", "AC-02", "AC-03"],
  "commands": [{"command": "pnpm test", "exitCode": 0, "outputFile": "docs/plans/settings-competitors/evidence/T02-test.txt"}],
  "artifacts": ["docs/manual/configuration.md"],
  "manualChecks": ["Describe observed behavior and platform"],
  "limitations": [],
  "rollback": "Describe supported reversal without deleting user data"
}
```

## Prevent drift during execution

No spec or fixture relaxation solely to accommodate failing code. No blanket test skips. No second settings store in renderer state/localStorage. No hard-coded available=true. No direct filesystem/secrets from React. No return-success on unavailable adapters. No external network required for unit tests. Never convert an advisory review into auto-edit. Runtime permission grants and OS permissions stay distinct.

If baseline fails, distinguish existing from new failures with a focused repro and record them. Do not mark a blocked platform task done using only mocks. Preserve completed slices; avoid expanding work to unrelated legacy defects. If a task is too large for the model context, split it before implementation and update manifest/coverage, never drop acceptance IDs.

## Qualification with smaller models

After T04 and again after T15, use isolated fixture repositories and an explicitly chosen available model; do not change the owner's real repo for a benchmark. Three tasks: add one validated setting through all surfaces, add one permission-denial UI state bilingually, and repair one injected replay defect. Use the handoff prompt with no hidden coaching. Run each three times, record model/version, prompt hash, duration, attempts, diff and acceptance output. Pass requires all nine attempts to meet their fixed tests without weakening fixtures, exposing a secret or modifying outside allowed scope. Report failures honestly; these trials measure this pack, not a universal one-pass guarantee. Network/model runs are separate from offline unit tests and require configured credentials.

Use [the qualification suite](../../../evals/settings-qualification/README.md) to run the offline fixture validator and live repetitions. See [post-T04 results](evidence/post-t04-qualification.md) for the completed first trial.
