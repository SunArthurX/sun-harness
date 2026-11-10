# T09 review and worktree inspection checkpoint

This interim checkpoint covers structured review, the optional completion
gate, and read-only Git candidate inspection. Final verification of the
worktree lifecycle and setup is in [T09.json](T09.json).

## Verified behavior

- A scripted provider read the durable request before returning a result.
  Its model, system message, payload, and empty tool set matched the request
  event. A concurrent session rename did not duplicate event sequences.
- Invalid paths, unchanged lines, out-of-range lines, invalid severity,
  and fabricated evidence failed validation. A later valid result was
  accepted. Structured findings and the legacy text view remain in history.
- Editing a reviewed file changed the digest and marked the report stale.
  A diff that exceeded its budget produced an omission and blocked the
  enabled completion gate. A later complete review allowed the run to resume.
- A worktree fixture wrote an untracked file outside the checkpoint
  mechanism. Review included the file relative to the recorded base. Git
  status and diff inspection left the actual index bytes unchanged.
- The served renderer saved the review settings and applied the display
  threshold. Both the web renderer and Electron identified a stale report
  after the fixture changed.

## Commands

- `pnpm test` passed with 288 tests and one pre-existing skip.
- `pnpm build` and `pnpm typecheck` passed.
- `node apps/desktop/e2e/settings.mjs` passed on macOS.
- `node scripts/check-settings-plan.mjs` and `git diff --check` passed.

Ordinary sessions review checkpoint changes and recorded deliverables.
Worktree sessions review committed, tracked, and untracked changes from
their recorded base. Git inspection was exercised with Git 2.23.

## Acceptance checks carried into final verification

- In `worktree.ts` and the host lifecycle entry points, verify the selected
  base, branch, repository identity, managed path, and session ownership.
  Use argv-based Git operations. Retry branch name collisions only within
  the documented bound.
- Check running sessions, reviews, background jobs, and live descendants
  before merge, discard, or cleanup. Check closed sessions and the actual
  Git status, including untracked files. Preserve dirty or unowned paths.
- Bind manual cleanup confirmation to the reviewed inventory and recheck
  each selected worktree before removal. Test an edit between preview and
  confirmation, and a repository or path replacement.
- Exercise squash and regular merge conflicts on real repositories. Verify
  both branch heads remain reachable and the result describes any required
  recovery accurately.
- Reuse the T07 hook trust and bounded runner for explicit worktree setup.
  Persist a start marker before process dispatch and a terminal outcome
  after settlement. Restart after an ambiguous setup without rerunning it.
