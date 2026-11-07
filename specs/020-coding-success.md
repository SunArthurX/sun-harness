# 020 — Coding success (phase 1)

Status: implemented. Code: `packages/core/src/tools/edit.ts`, `verify.ts`, `repomap.ts`, `diagnostics.ts`, `bestofn.ts`, `agent.ts` (tool batches, done gate), `host.ts` (checkpoints, undo, plan mode), `providers/*` (cache tokens, `wireArguments`), `modes.ts` (`plan`).

## Principle

A coding agent fails for mechanical reasons long before it fails for lack of intelligence: edits that do not apply, stale views of a file, tools that cannot work, broken tool-call JSON, and "done" claimed without running the tests. Phase 1 removes those failure modes in the harness, so every model gains, and measures each change with the eval suite (spec 019).

## Edits

- **Read before edit.** `write_file` (on an existing file), `edit_file`, and `apply_patch` require that the file was read in this session (`FileState`). If the file changed on disk since the agent last read or wrote it, the edit is refused with "re-read it" — the model never overwrites changes it has not seen.
- **Tolerant replace** (`edit_file`): exact match → CRLF-normalized → whitespace-insensitive line match with the replacement re-indented to the file. Ambiguous matches are refused (ask for more context or `replace_all`). A miss returns the closest region of the file with line numbers so the next attempt can copy the real text.
- **`apply_patch`**: Codex-style multi-file patches (`*** Begin Patch` / `Update|Add|Delete File` / `Move to` / `@@` anchors). All operations are validated first and written only if every hunk applies (atomic). Hunk context matching uses the same whitespace tolerance.
- **Post-edit diagnostics.** After every write, the touched files are syntax-checked (`node --check`, Python `ast.parse`, `JSON.parse`, the project's own `typescript` syntactic diagnostics). Errors are appended to the tool result: `WARNING: syntax errors after this edit`. Type and test errors are left to the done gate.

## Checkpoints and undo

Before any write tool modifies files, the host snapshots their current content to `~/.sun/checkpoints/<session>/cp-NNNN.json` and logs `{type: 'checkpoint', id, files}`. `undo(session, {steps | to})` restores the newest not-yet-undone checkpoints (files that did not exist are deleted), logs `checkpoint/undo`, and tells the model what was reverted. Surfaces: `sun undo <session> [--steps n]`, chat `/undo [n]`, desktop "↶ Undo" button, gateway method `undo`.

## Done gate (verify loop)

When the model ends a turn after editing files (a `checkpoint` since the last `verify/result`), the harness runs the project's verify commands and logs `verify/result`. On failure the output is appended as a `user/message` with `source: 'verify'` ("fix the cause, do not weaken tests") and the loop continues, up to `verify.maxAttempts` (default 2). Commands: `.sun/project.json` `verify` array wins; otherwise detected (package.json `typecheck`/`test` scripts, `tsc --noEmit`, `node --test`, pytest/unittest, cargo, go). Only active while the session is in `coding` mode.

## Tool reliability

- **Capability gating.** A tool may define `available()`; tools whose backend is unreachable (e.g. the web search provider) are not offered for this run.
- **Malformed tool-call JSON.** Arguments that are not valid JSON are kept as `{_invalid_json: raw}` and sent back to providers as a JSON object (`wireArguments`), so one bad call cannot make every later request fail with HTTP 400; the tool returns an error asking for valid JSON.
- **Parallel read-only calls.** Consecutive calls of read-risk tools that need no approval run concurrently; results are logged in call order.

## Context

- **Prompt caching.** Providers report cached input tokens in `Usage.cachedTokens` (DeepSeek `prompt_cache_hit_tokens`, OpenAI/DashScope `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens`). Anthropic requests mark the system block, the last tool, and the last message block with `cache_control: ephemeral`. The prompt prefix is kept stable: append-only messages, a per-session repository map, and an unchanged tool list. Telemetry and eval reports show the cache hit rate.
- **Repository map.** In `coding` and `plan` mode, projects with at least `repoMap.minFiles` (8) source files get a `# Repository map` section: definitions (functions, classes, types, methods) per file, files ranked by how often other files reference their definitions, within `repoMap.budget` characters (6000). It is computed once per session (stable prefix). The `repo_map` tool returns a fresh, larger, filterable view (`query`, `path`).

## Plan mode

Mode `plan`: read-only builtin tools only (no edits, no shell, no MCP) plus `exit_plan_mode({plan})`. That tool has `exec` risk, so it passes the approval policy: a human reviews the plan unless approval is `full-auto`. On approval the session logs `mode/switch plan → coding` on the running log, turns the plan's numbered or bulleted steps into the todo list, and the next step continues in coding mode with all tools. "Deny" (desktop: "Keep planning") returns the reason to the model, which stays in plan mode.

## Best-of-N

`runBestOfN(host, {cwd, prompt, n, models?, apply?})` runs the task in N git worktrees in parallel (models rotate if several are given), then judges each candidate with the project's own verify commands. Ranking: verified > no tests > failing; finished cleanly; has changes; smallest diff; fewest tokens. With `apply`, the winner is squash-merged (staged) into the checkout and the other worktrees are discarded. Surfaces: `sun run "<task>" --best-of N [--model a,b] [--apply]`, `sun eval run --best-of N` (cost metrics sum all candidates). Candidates never see hidden eval tests: only visible tests judge.

## Results

See the table in `docs/teach/18-coding-success.html` and the eval runs in `~/.sun/evals`.

| Run | Model | Pass | Edit failure rate | Tool error rate | Input tokens | Cache hit |
|---|---|---|---|---|---|---|
| baseline-flash | qwen-flash | 55.6% | 40.6% | 25.8% | 4.90 M | — |
| baseline | deepseek-chat | 100.0% / 97.2% | 0% | 0% | 1.78 M / 2.65 M | — |
