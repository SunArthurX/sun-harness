# Worktree sessions

Run a coding session on its own branch in a separate checkout. Your working copy stays untouched until you decide to merge. Several sessions can work on the same repository at once.

## Start one

- Desktop: Welcome → Coding → choose a git project → tick **Isolated git worktree** → Start.
- CLI: `sun --worktree` (chat) or `sun run --worktree "Add input validation to the signup form"`.

The repository needs at least one commit. The session starts from `HEAD`; uncommitted changes in your main checkout are not included, so commit or stash them first if the agent needs them.

Worktrees live in `~/.sun/worktrees/<repo>-<id>` on branch `sun/<id>`.

## Review

- Desktop: click the **⑂ branch** chip in the session header to open the Changes panel: changed files (A added, M modified, D deleted), line counts, and the full diff.
- CLI: `sun worktree list`, `sun worktree status <sessionId>`, `sun worktree diff <sessionId>`.

## Merge or discard

| Action | Desktop | CLI | Result |
|---|---|---|---|
| Squash merge | **Merge (squash)** | `sun worktree merge <id>` | changes staged in your main checkout; review and `git commit` yourself |
| Merge commit | **Merge commit** | `sun worktree merge <id> --strategy merge` | a merge commit on your current branch |
| Discard | **Discard** | `sun worktree discard <id>` | worktree and branch deleted |

If the merge conflicts with your main checkout, it is aborted and nothing changes; resolve by merging the kept branch `sun/<id>` manually. After merging, the session is closed; start a new session to continue.
