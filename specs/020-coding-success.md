# 020 — Coding success (phase 1)

Status: implemented. Code: `packages/core/src/tools/edit.ts`, `verify.ts`, `repomap.ts`, `diagnostics.ts`, `bestofn.ts`, `agent.ts` (tool batches, done gate), `host.ts` (checkpoints, undo, plan mode), `providers/*` (cache tokens, `wireArguments`), `modes.ts` (`plan`).

## Principle

A coding agent fails for mechanical reasons long before it fails for lack of intelligence: edits that do not apply, stale views of a file, tools that cannot work, broken tool-call JSON, and "done" claimed without running the tests. Phase 1 removes those failure modes in the harness, so every model gains, and measures each change with the eval suite (spec 019).

## Edits

- **Read before overwrite, fresh before edit.** `write_file` on an existing file requires that the file was read in this session (`FileState`): no blind overwrites. `edit_file` and `apply_patch` may target a file the agent has not read with `read_file` (it may have seen it through `grep` or `cat`; the old text must match anyway). For all three, if the file changed on disk since the agent last read or wrote it, the edit is refused with "read it again" — the model never edits on top of changes it has not seen.
  - A refusal (unread or stale) returns the file's current content with line numbers (≤ 400 lines) and counts it as read, so the next call is an informed one instead of a loop.
  - *Decision (eval-driven):* the first version required `read_file` before every edit. On deepseek-chat that produced 14 refused edits in 36 tasks (edit failure rate 0% → 20%) without preventing a single wrong edit, so the requirement was narrowed to whole-file overwrites.
- **Tolerant replace** (`edit_file`): exact match → CRLF-normalized → whitespace-insensitive line match with the replacement re-indented to the file. Ambiguous matches are refused (ask for more context or `replace_all`). A miss returns the closest region of the file with line numbers so the next attempt can copy the real text.
- **`apply_patch`**: Codex-style multi-file patches (`*** Begin Patch` / `Update|Add|Delete File` / `Move to` / `@@` anchors). All operations are validated first and written only if every hunk applies (atomic). Hunk context matching uses the same whitespace tolerance.
- **Post-edit diagnostics (LSP).** After every write, each touched file is checked and errors are appended to the tool result (`WARNING: errors after this edit (syntax or types)`):
  1. a language server over LSP (`lsp.ts`: JSON-RPC over stdio, Content-Length framing, full-text sync, diagnostics collected until the server is quiet for 600 ms, ≤ `lsp.timeoutMs`): `typescript-language-server` for TS/JS (tsserver from the project, else a global TypeScript), `pyright-langserver`, `gopls`, `rust-analyzer` when installed; one client per server and project root, reused across edits; errors only (severity 1);
  2. else the TypeScript language service in-process (project TypeScript, or a global one when the project's has no JavaScript API, as in TypeScript 7);
  3. else syntax checks (`node --check`, Python `ast.parse`, `JSON.parse`).
  Test failures remain the done gate's job.

- **Loop breakers.** From the second consecutive `old_string not found` on the same file (reset by any successful write), the error contains the file's current content with line numbers (≤ 400 lines) and suggests `write_file`. Any tool result that is an error for a call byte-identical (tool and arguments) to an earlier failed call gets a `[harness]` note with the failure count, telling the model not to repeat it.
  - *Decision (eval-driven):* in the all-phases qwen-flash run, 147 of the failing edit calls came from two sessions that re-sent the same wrong `old_string` or patch up to 30 times, although the closest-region hint was correct; DeepSeek re-sent a refused `write_file` 6 times (9 in the next run, each with different content, so the identical-call note did not fire); handing over the content on refusal ends that loop after one call.

## Checkpoints and undo

Before any write tool modifies files, the host snapshots their current content to `~/.sun/checkpoints/<session>/cp-NNNN.json` and logs `{type: 'checkpoint', id, files}`. `undo(session, {steps | to})` restores the newest not-yet-undone checkpoints (files that did not exist are deleted), logs `checkpoint/undo`, and tells the model what was reverted. Surfaces: `sun undo <session> [--steps n]`, chat `/undo [n]`, desktop "↶ Undo" button, gateway method `undo`.

## Done gate (verify loop)

When the model ends a turn after editing files (a `checkpoint` since the last `verify/result`), the harness runs the project's verify commands and logs `verify/result`. On failure the output is appended as a `user/message` with `source: 'verify'` ("fix the cause, do not weaken tests") and the loop continues, up to `verify.maxAttempts` (default 2). Commands: `.sun/project.json` `verify` array wins; otherwise detected (package.json `typecheck`/`test` scripts, `tsc --noEmit`, `node --test`, pytest/unittest, cargo, go). Only active while the session is in `coding` mode.

## Tool reliability

- **Capability gating.** A tool may define `available()`; tools whose backend is unreachable (e.g. the web search provider) are not offered for this run.
- **Malformed tool-call JSON.** Arguments that are not valid JSON are kept as `{_invalid_json: raw}` and sent back to providers as a JSON object (`wireArguments`), so one bad call cannot make every later request fail with HTTP 400; the tool returns an error asking for valid JSON.
- **Parallel read-only calls.** Consecutive calls of read-risk tools that need no approval run concurrently; results are logged in call order.

## Context

- **Prompt caching.** Providers report cached input tokens in `Usage.cachedTokens` (DeepSeek `prompt_cache_hit_tokens`, OpenAI/DashScope `prompt_tokens_details.cached_tokens`, Anthropic `cache_read_input_tokens`). Anthropic requests mark the system block, the last tool, and the last message block with `cache_control: ephemeral`. OpenAI-compatible providers with `cacheControl: true` (preset: DashScope/qwen) send the system prompt and the newest non-assistant message as content blocks with `cache_control: ephemeral`.
  - *Decision (measured):* DashScope's implicit cache returned 0 cached tokens for repeated identical 3.9k-token requests on qwen-flash; with explicit markers the second request read 3,911 of 3,922 prompt tokens from cache. DeepSeek caches implicitly (90.7% hit rate over the suite) and needs no markers. The prompt prefix is kept stable: append-only messages, a per-session repository map, and an unchanged tool list. Telemetry and eval reports show the cache hit rate.
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
| p1a-flash (edits, gating, JSON repair, parallel reads, done gate) | qwen-flash | 69.4% | 20.0% | 7.7% | 8.29 M | 0% |
| p1b-flash (all of phase 1 + sandbox) | qwen-flash | 61.1% | 7.0% | 3.6% | 9.79 M | 70.0% |
| p4a-flash (all phases, before loop breakers) | qwen-flash | 63.9% | 38.9% | 23.7% | 13.99 M | 95.1% |
| final-flash (loop breakers) | qwen-flash | **66.7%** | **8.5%** | **4.5%** | 13.58 M | 95.5% |
| p1-deepseek (strict read rule) | deepseek-chat | 97.2% | 20.0% | 4.0% | 2.45 M | 90.7% |
| p5-deepseek (all phases, before loop breakers) | deepseek-chat | 94.4% | 13.7% | 2.2% | 3.29 M | 91.7% |
| final-deepseek (loop breakers) | deepseek-chat | 100.0% | 18.4% | 3.0% | 2.58 M | 89.9% |
| final2-deepseek (+ refusal hands over content) | deepseek-chat | **100.0%** | **8.1%** | **1.3%** | 4.83 M | 93.8% |

Baselines predate cache accounting (their cache share is unknown). One weak-model run varies by about ±3 tasks.
