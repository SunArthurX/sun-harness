# 010 — Worktree sessions

Status: implemented (iteration 3). Sources: DeepSeek Harness 0.2.2 (change request and worktree), Codex (parallel agents on branches).
Code: `packages/core/src/worktree.ts`, `host.ts` (worktree methods), CLI `sun worktree`, desktop Changes panel.

## Goal

Several coding sessions can change the same repository at once, and nothing touches the main checkout until the owner merges.

## Behavior

- `createSession({ cwd, worktree: true })` requires a git repository with at least one commit. It creates branch `sun/<key>` from `HEAD` and a worktree at `~/.sun/worktrees/<repo>-<key>`. The session cwd is the worktree (same sub-folder if started below the repo root). `session/meta.worktree = { repo, path, branch, base }`.
- Rules, specs and skills are read from the worktree checkout. Writes inside the worktree are free in `auto-edit` mode; writes to the main checkout are outside the workspace and ask.
- Uncommitted changes in the main checkout are **not** copied into the worktree (it starts from `HEAD`).
- `worktreeStatus(id)`: changed files (including untracked, via intent-to-add), insertions, deletions, commits since base. `worktreeDiff(id)`: unified diff against base.
- `mergeWorktree(id, { strategy })`: commits pending worktree changes as `sun: <title>`, then in the main checkout:
  - `squash` (default): `git merge --squash` — changes are staged for review; the branch is **kept** until you commit.
  - `merge`: `git merge --no-ff` merge commit; the branch is kept.
  - On conflict the merge is aborted and the main checkout is left unchanged.
  - The worktree directory is removed; `worktree/closed {action: merged}` is logged.
- `discardWorktree(id)`: aborts any run, removes the worktree and deletes the branch; logs `worktree/closed {action: discarded}`.
- A closed worktree session cannot receive new messages.

## Surfaces

- CLI: `sun --worktree`, `sun run --worktree "…"`, `sun worktree list | status | diff | merge [--strategy merge] | discard`.
- Desktop: "Isolated git worktree" toggle on Welcome (coding mode); sidebar ⑂ marker; header branch chip opens the Changes panel (files, diff, Merge (squash), Merge commit, Discard, Refresh).
