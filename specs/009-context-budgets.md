# 009 — Context budgets and model-aware compaction

Status: implemented (iteration 2). Sources: DeepSeek Harness 0.2.2 (separate AGENTS.md budgets, compact before switching to a smaller model), OpenCode 2.2.5 (percentage compaction buffer, cap at the context window).
Code: `rules.ts` (`applyRuleBudgets`), `config.ts` (`contextWindowOf`, `compactionLimit`), `agent.ts` (`maybeCompact`).

## Rule budgets

- Each rule section has a scope: `global` (`~/.sun/AGENTS.md`) or `project` (repo AGENTS.md/CLAUDE.md chain, `.sun/rules`, `.cursor/rules`).
- `rules.globalMaxChars` (default 12 000) and `rules.projectMaxChars` (default 40 000) are independent. Sections fill their layer in load order; the section that crosses the budget is truncated, later ones are replaced by a one-line pointer telling the agent to `read_file` them.
- Decision: separate budgets because a merge order alone lets a large project file push global rules out (or the reverse).

## Context windows

- `contextWindowOf(ref)`: `providers.<id>.modelContext[model]` → built-in table (`KNOWN_CONTEXT_WINDOWS`) → Claude models 200k → `providers.<id>.contextWindow` → 128k (Ollama 32k).
- `compactionLimit(ref) = min(compaction.thresholdTokens, window − buffer)`; `compaction.buffer` is a percentage string (`"25%"`, default) or a token count. One config works for 32k and 1M models.

## Compaction with the right model

- Compaction triggers when the derived history exceeds the current model's limit (or on a `context_length` error).
- If a `model/switch` happened since the last compaction, the **previous model summarizes first** (it could hold this history; the new one may not). If it fails (for example the switch was a quota fallback), the current model summarizes a transcript trimmed to its own limit (≈ 3 chars per token).
- The compaction event records `model` when the summarizer differs from the session model.
- Switching to a model whose limit the history already fits does not compact.
