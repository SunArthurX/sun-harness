# 010 — Worktree sessions

Status: implemented (iteration 3). Sources: DeepSeek Harness 0.2.2 (change request and worktree), Codex (parallel agents on branches).
Code: `packages/core/src/worktree.ts`, `host.ts` (worktree methods), CLI `sun worktree`, desktop Changes panel.

## Goal

Several coding sessions can change the same repository at once, and nothing touches the main checkout until the owner merges.

## Behavior

- `createSession({ cwd, worktree: true, worktreeBase? })` requires a Git repository with at least one commit. It resolves the requested ref to a commit, defaulting to `HEAD`. It creates branch `sun/<key>` and a worktree at `~/.sun/worktrees/<repo>-<key>`. The session cwd uses the same subfolder when it exists at the selected base. The session log records the base commit, repository identity, and destination branch.
- Rules, specs and skills are read from the worktree checkout. Writes inside the worktree are free in `auto-edit` mode; writes to the main checkout are outside the workspace and ask.
- Uncommitted changes in the main checkout are **not** copied into the worktree (it starts from `HEAD`).
- `worktreeStatus(id)` reports changed files, including untracked files, and counts from the recorded base. `worktreeDiff(id)` returns the corresponding unified diff. Decision (T09): inspection uses an isolated temporary index and leaves the repository index untouched. Review uses the same candidate snapshot.
- Decision (T09): merge requires an inactive owned worktree and a clean destination on its recorded branch. It preserves pending tracked and untracked changes in a commit on the source branch before applying the chosen strategy.
  - `squash` (default): `git merge --squash` — changes are staged for review; the branch is **kept** until you commit.
  - `merge`: `git merge --no-ff` creates a merge commit.
  - A conflict preserves both branch heads. The host attempts to restore the previously clean destination and reports when manual Git recovery is required.
  - Successful merge removes the worktree only if it is still safe to remove. The branch remains reachable.
- `discardWorktree(id)` removes an inactive, owned worktree only when Git reports it clean, including untracked and ignored files. A branch with unmerged commits is kept. Manual cleanup uses a revision-bound preview and the same checks.
- Harness-managed Git commands disable repository Git hooks. The reviewed worktree setup action uses the host hook policy instead.
- A closed worktree session cannot receive new messages.

## Surfaces

- CLI: `sun --worktree`, `sun run --worktree "…"`, `sun worktree list | status | diff | merge [--strategy merge] | discard`.
- Desktop: "Isolated git worktree" toggle on Welcome (coding mode); sidebar ⑂ marker; header branch chip opens the Changes panel (files, diff, Merge (squash), Merge commit, Discard, Refresh).

Decision (T09): a worktree review uses the candidate changes relative to
the recorded base. Worktree inventory and guarded lifecycle actions are
specified in spec 032. Existing session ownership remains the authority
for merge, discard, and cleanup.
