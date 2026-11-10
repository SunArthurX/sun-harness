# 029 — Cursor-grade coding

Status: implemented (0.9.0). Code: `packages/core/src/ux/ignore.ts`, `ux/codebase.ts`, `ux/mentions.ts`, `rules.ts`, `tools/builtin.ts`, `tools/services.ts` (`codebase_search`), `host.ts` (`reviewSession`, file-scoped rules). Desktop: Review button, `/review`, transcript card.

## Why these, and not twenty more

The field's products overlap. sun-harness already has the parts that used to distinguish them: durable log, approvals, worktrees, sandbox, LSP diagnostics, plan mode, checkpoints, diffs, skills, MCP, memory, automations, browser. This release takes the **top gap that is still missing** from each product the vision names, and builds the ones that make coding behave like Cursor.

| Product | Three strengths | Already here | Built in 0.9.0 |
|---|---|---|---|
| Cursor | codebase index; rules by glob / @rule; Agent Review of the diff | checkpoints, inline diff, @file | `codebase_search`, glob rules, `/review` |
| Claude Code | repo search before edit; project instructions; permissioned tools | grep, AGENTS.md, approvals | search-before-read in the coding prompt; ignore file so secrets stay out |
| Codex | apply_patch; sandbox; reviewable diff | both tools, sandbox, changes view | a dedicated review pass that does not edit |
| Manus | plan, then files you can open; sandbox; browser | plan mode, deliverables, browser | — (no new gap that fits the local harness) |
| Hermes | memory, skills it can propose, LSP after edits | memory, evolution proposals, LSP | — |
| OpenCode | any model, terminal, small core | providers, CLI | — |
| Cline | plan/act, checkpoints, MCP | plan mode, undo, MCP | — |
| DeepSeek Harness | spec-first context, one host, durable sessions | specs index, HarnessHost, JSONL | — |

Decision: do not add a cloud index or an embedded editor. Cursor's coding loop that we can own locally is **find the code, apply the rule for that file, then review the diff**.

## Codebase search

`codebase_search` and `@codebase <query>` search source files with BM25 (the same tokenizer as the knowledge base) plus an exact definition hit when the query is a symbol name. The index lives in memory, keyed by file mtimes. No embeddings and no network. Ignored files are not indexed.

## Ignore files

`.cursorignore` and `.sunignore` at the project root use gitignore-like patterns (`*`, `**`, `?`, a trailing `/`, `!` last-match-wins). `read_file`, directory listings, `glob`, `grep`, and `@file` mentions refuse a match. The refusal is the tool error, so the model is told and the secret is not in the result.

## Rules

Cursor frontmatter on `.cursor/rules` and `.sun/rules`:

- `alwaysApply: true` — in every prompt.
- `globs` — the body is added as "Rules for files in context" once a matching path has been read, edited, or attached. `*.ts` matches the project root only; `src/**/*.ts` matches every depth.
- `description` without globs — one line in the optional-rules index.
- `alwaysApply: false` with neither — only `@rule <name>`.

## Review

Decision (T09): review binds to a digest of the candidate changes. Before
dispatch, the host appends `review/request` with the exact provider request,
the model reference, and the omitted files. The provider receives no tools.
Findings must cite a path and contiguous changed lines in the submitted
diff. A finding on a deleted file uses its old line numbers. A finding on
an added or modified file uses its new line numbers. Evidence must quote
text on those lines. Invalid findings make the entire result retryable.

Binary, ignored, out-of-workspace, unrepresentable, and over-budget
changes are reported as omissions. The host submits whole text diffs
within the configured budget. A result with omissions is incomplete.
Ordinary sessions use their checkpoint changes and recorded deliverables.
Worktree sessions use Git changes relative to their recorded base,
including untracked files.
Changes to the candidate digest make a report stale. No diff produces
`No file changes to review.` without a model call. Historical text reports
remain readable. Review events stay outside the normal agent conversation.

The configurable review model defaults to the session's model. Rule
sources and diff budget determine the review input. Severity threshold
filters display. An optional completion gate defaults off. When enabled
for coding runs, completion requires either an empty diff or a current,
complete review with no findings. An unsuccessful review pauses the run
without editing files.

Surfaces: desktop **Review** and `/review`, CLI `/review`, bots `/review`, gateway `reviewSession`.
