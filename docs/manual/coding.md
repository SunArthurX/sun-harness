# Coding: edits, verification, undo, plan, best-of-N

What the harness does around every coding session so edits land, tests run, and mistakes are reversible.

## How edits work

| Tool | Use it for | Safety |
|---|---|---|
| `edit_file` | replace a snippet in one file | must have read the file this session; tolerates CRLF and indentation differences; on a miss shows the closest region with line numbers |
| `apply_patch` | several hunks or files at once, adds, deletes, renames | all-or-nothing: if one hunk does not apply, nothing is written |
| `write_file` | new files (or rewriting a file already read) | refuses to overwrite a file the agent has not read |

If a file changes on disk after the agent read it (you edited it, or a formatter ran), the next edit is refused with "re-read it", so your changes are never overwritten blindly.

After every edit the touched files are checked, and problems show up in the same tool result as `WARNING: errors after this edit (syntax or types)`:

- with a language server installed, real diagnostics including type errors: `npm i -g typescript-language-server typescript` (TS/JS), `pip install pyright` (Python), `gopls` (Go), `rust-analyzer` (Rust);
- otherwise TypeScript checks through the TypeScript package, and syntax checks for JavaScript, Python and JSON.

Turn language servers off or change the wait with `"lsp": { "enabled": false, "timeoutMs": 8000 }`.

## Verification (the done gate)

When the agent says it is finished after changing files, sun runs your project's checks and sends failures back to the agent (up to 2 extra attempts). Commands, in order of preference:

1. `.sun/project.json`: `{ "verify": ["pnpm typecheck", "pnpm test"] }`
2. detected: `package.json` scripts `typecheck` and `test`, `tsc --noEmit`, `node --test`, pytest or unittest, `cargo test`, `go test ./...`

The transcript shows "✓ verified" or "✗ verification failed" with the full output. Turn it off or tune it in `~/.sun/config.json` (`verify`).

## Undo

Every edit step is checkpointed first. Undo the last step (or several):

- Desktop: **↶ Undo (n)** in the session header (n = steps that can be undone).
- Chat: `/undo` or `/undo 3`.
- CLI: `sun undo <sessionId> [--steps 3]`.

Undo restores the files' previous content (and deletes files the agent created), and tells the agent what was reverted. Stop the run first.

## Plan mode

Pick **Plan** on the welcome screen, `--mode plan`, or `/mode plan`. The agent can only read (`codebase_search`, files, grep, repo map, web, knowledge base). It ends with a plan, which you review:

- Desktop: the plan appears as a card. **Approve and start coding** switches the session to Coding mode and turns the plan's steps into the todo list; **Keep planning** sends it back.
- CLI chat: the same approval prompt (allow / deny).
- `full-auto` approval approves plans automatically.

## Finding code

`codebase_search` looks through the repository without a network call: a symbol name (`chargeInvoice`) returns the definition, and a phrase returns the matching source. The index is local and refreshes when a file changes. It skips paths in `.cursorignore` and `.sunignore` (gitignore-style patterns). `read_file`, `grep`, `glob`, and `@file` mentions refuse those paths too, so secrets listed there never enter the prompt.

In the composer, `@codebase chargeInvoice` attaches the hits, `@git` attaches `git status` and `git diff --stat`, and `@rule api` attaches `.cursor/rules/api.mdc` (or the same name under `.sun/rules`).

## Rules that follow the files

`.cursor/rules/*.mdc` and `.sun/rules/*.md` use Cursor's frontmatter:

| Frontmatter | When it is included |
|---|---|
| `alwaysApply: true` | every request |
| `globs: src/**/*.ts` | after a matching file is read, edited, or `@`mentioned |
| `description:` and no globs | listed by description; the agent reads the file if it is relevant |
| neither, and `alwaysApply: false` | only `@rule <name>` |

## Review

**Review** in the session bar, `/review` in the desktop, the CLI, and chat bots, sends this session's diff to the model and posts the findings in the transcript. Nothing is edited. If the session has not changed files, it says so and does not call a model.

## Repository map

In Coding and Plan mode, projects with 8 or more source files get a repository outline in the prompt: the most referenced functions, classes, and types with line numbers. It is built once per session so the provider's prompt cache keeps working. The agent can call `repo_map` (optionally with `query` or `path`) for a fresh, filtered view. Prefer `codebase_search` when you know a name or a phrase.

## Best-of-N

Run the same task several times in parallel and keep the attempt whose tests pass:

```bash
sun run "fix the rounding bug in splitCents" --best-of 3            # review the winner
sun run "add CSV export" --best-of 4 --model deepseek/deepseek-chat,qwen/qwen-plus --apply
```

Each attempt gets its own git worktree. The judge is your project's verify commands. Ranking: tests pass, finished cleanly, changed something, smallest diff, fewest tokens. Without `--apply`, review with `sun worktree diff <id>` and keep it with `sun worktree merge <id>`; with `--apply` the winner is staged in your checkout and the rest are discarded. Commit your work first: worktrees start from `HEAD`.

## Prompt cache

The desktop header shows tokens used and the share served from the provider's prompt cache (for example `48.2k tok · 71% cached`). Cached input is cheaper and faster on DeepSeek, OpenAI, DashScope, and Anthropic.
