# Worktree sessions

Run a coding session on its own branch in a separate checkout. Your working copy stays untouched until you decide to merge. Several sessions can work on the same repository at once.

## Start one

- Desktop: choose a Git project in a Coding session, select **Isolated git
  worktree**, and optionally enter a **Worktree base** before starting.
- CLI: `sun --worktree` (chat) or `sun run --worktree --base main "Add input validation"`.

The repository needs at least one commit. The default base is `HEAD`.
The worktree starts from the resolved commit. Commit changes first if
they should be included in the new worktree.

Worktrees live in `~/.sun/worktrees/<repo>-<id>` on branch `sun/<id>`.

## Review

- Desktop: click the **⑂ branch** chip in the session header to open the Changes panel: changed files (A added, M modified, D deleted), line counts, and the full diff.
- CLI: `sun worktree list`, `sun worktree status <sessionId>`, `sun worktree diff <sessionId>`.

## Merge or discard

| Action | Desktop | CLI | Result |
|---|---|---|---|
| Squash merge | **Merge (squash)** | `sun worktree merge <id>` | changes staged in your main checkout; review and `git commit` yourself |
| Merge commit | **Merge commit** | `sun worktree merge <id> --strategy merge` | a merge commit on the recorded destination branch |
| Discard | **Discard** | `sun worktree discard <id>` | a clean, inactive worktree is removed and any unmerged branch is kept |

Merge requires an inactive worktree and a clean destination on the
recorded branch. The candidate is committed first. If Git reports a
conflict, the candidate branch remains available. The host attempts to
restore the destination and reports when it needs manual inspection.

## Cleanup and setup

In **Settings → Worktrees**, select clean entries and choose **Preview
worktree cleanup**. Confirm the displayed paths. A change after preview
requires a new preview. The CLI equivalent is `sun worktree preview
<id...>`, followed by `sun worktree cleanup <revision> <id...>`.

To prepare a worktree, declare a `sessionStart` hook with
`worktreeSetup: true` in `.sun/hooks.json`. Open the worktree in Settings,
inspect its setup hook, review the command, and select **Run worktree
setup**. The CLI uses the reviewed hook ID and digest with `sun worktree
setup <id> <hook-id> <digest>`. The command runs once in the owned worktree.
If the host exits before recording the outcome, inspect the files and
acknowledge recovery in Settings or with `sun worktree reconcile <id>`.
