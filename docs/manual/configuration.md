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
| `compaction` | `{thresholdTokens: 90000, keepRecent: 12}` | history summarization |
| `providers.<id>` | presets | `{type: openai|anthropic, baseUrl, apiKeyEnv, apiKey?, models[], headers?, echoReasoning?, noKey?}` |
| `skills` | `{extraDirs: [], compat: true}` | extra skill folders; read Claude/agents locations |
| `plugins` | `{disabled: [], settings: {}}` | plugin control |
| `mcp.enabled` | `true` | connect MCP servers |
| `kb.roots` | `[~/.sun/kb]` | personal KB folders |
| `kb.company` | disabled | `{enabled, name, baseUrl, tokenEnv}` |
| `intel` | 14 sources, 09:00 | `{sources[], analysisModel?, hour, minute}` |
| `evolution.autoReflect` | `false` | reserved |

Provider presets: `deepseek`, `anthropic`, `openai`, `glm`, `qwen` (DashScope), `gemini`, `openrouter`, `ollama`. Add your own:

```json
{ "providers": { "kimi": { "type": "openai", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY", "models": ["kimi-k2"] } } }
```

## Data layout

```text
~/.sun/
  config.json  .env  AGENTS.md  mcp.json  hooks.json  schedules.json
  sessions/<id>.jsonl          # durable session logs
  memory/MEMORY.md
  kb/                          # personal notes (kb_add_note writes to kb/notes/)
  skills/<name>/SKILL.md
  plugins/<name>/
  evolution/proposals/*.json  backlog.md  journal.md
  intel/state.json  raw/<date>.json  reports/<date>.{md,html}  launchd.log
  bin/sun.mjs                  # self-contained CLI used by launchd
  workspace/                   # default folder for agent/assistant sessions
```
