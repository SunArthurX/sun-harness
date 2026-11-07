# Configuration reference

`~/.sun/config.json` (override the home with `SUN_HOME`). Only the fields you set are stored; everything else uses defaults.

| Field | Default | Meaning |
|---|---|---|
| `defaultModel` | first ready model | `provider/model` for new sessions |
| `fallbackModels` | `[]` | tried in order on quota/auth errors |
| `approval` | `auto-edit` | `suggest`, `auto-edit`, `full-auto` |
| `denyInsteadOfPrompting` | `false` | deny approvals with a reason instead of waiting |
| `maxSteps` | `60` | model requests per run before pausing |
| `autoResume` | `{enabled: true, intervalMinutes: 15}` | retry paused sessions (desktop) |
| `compaction` | `{thresholdTokens: 200000, keepRecent: 12, buffer: "25%"}` | compact when history exceeds `min(thresholdTokens, contextWindow − buffer)` |
| `rules` | `{globalMaxChars: 12000, projectMaxChars: 40000}` | separate prompt budgets for global and project rules |
| `providers.<id>` | presets | `{type: openai|anthropic, baseUrl, apiKeyEnv, apiKey?, models[], headers?, echoReasoning?, noKey?, contextWindow?, modelContext?}` |
| `skills` | `{extraDirs: [], compat: true}` | extra skill folders; read Claude/agents locations |
| `plugins` | `{disabled: [], settings: {}}` | plugin control |
| `mcp.enabled` | `true` | connect MCP servers |
| `kb.roots` | `[~/.sun/kb]` | personal KB folders |
| `kb.company` | disabled | `{enabled, name, baseUrl, tokenEnv}` |
| `kb.embeddings` | `{enabled: false, model: "qwen/text-embedding-v4"}` | hybrid BM25 + embedding retrieval; `dimensions?` |
| `intel` | 14 sources, 09:00 | `{sources[], analysisModel?, hour, minute}` |
| `evolution.autoReflect` | `false` | reserved |
| `jobs.promoteAfterMs` | `30000` | MCP calls still running after this move to a background job (0 = never) |

Provider presets: `deepseek`, `anthropic`, `openai`, `glm`, `qwen` (DashScope), `gemini`, `openrouter`, `ollama`. Add your own:

```json
{ "providers": { "kimi": { "type": "openai", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY", "models": ["kimi-k2"] } } }
```

## Data layout

```text
~/.sun/
  config.json  .env  AGENTS.md  mcp.json  hooks.json  schedules.json  gateway.json  gateway.log
  sessions/<id>.jsonl          # durable session logs
  memory/MEMORY.md
  kb/                          # personal notes (kb_add_note writes to kb/notes/)
  kb-index/embeddings.json     # embedding cache for hybrid retrieval
  skills/<name>/SKILL.md
  plugins/<name>/
  evolution/proposals/*.json  backlog.md  journal.md
  intel/state.json  raw/<date>.json  reports/<date>.{md,html}  launchd.log
  jobs/<job-id>.log            # background job output
  worktrees/<repo>-<id>/       # worktree sessions
  bin/sun.mjs                  # self-contained CLI used by launchd
  web/                         # web UI served by the gateway
  workspace/                   # default folder for agent/assistant sessions
```
