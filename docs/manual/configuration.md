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
| `verify` | `{enabled: true, maxAttempts: 2, timeoutMs: 300000}` | done gate: run project checks when the agent finishes after editing ([Coding](coding.md)) |
| `repoMap` | `{enabled: true, budget: 6000, minFiles: 8}` | repository outline in Coding/Plan prompts (characters, minimum source files) |
| `memory` | `{recallModes: ["assistant", "agent"], extractModes: ["assistant"], autoExtract: true, recallK: 4}` | long-term memory recall and extraction ([Assistant](assistant.md)) |
| `router` | `{}` — `{background?, fast?, strong?}` | background model; `auto` session routing |
| `briefing` | `{enabled: false, hour: 8, minute: 30, chats: [], extra?}` | daily briefing |
| `triggers` | `[]` | file-watch and webhook triggers |
| `voice` | `{stt: "qwen/qwen3-asr-flash"}` | speech-to-text model ref |
| `search` | `{provider: "auto", bingBase: "https://cn.bing.com", searxngUrl?, keys: {tavily: "TAVILY_API_KEY", brave: …, serper: …, bocha: …}}` | web search ([Research](research.md)) |
| `taint` | `{enabled: true, untrusted: []}` | prompt-injection guard; extra untrusted tool globs |
| `maxParallelTools` | `6` | concurrent tool calls per step (read-only tools, subagents) |
| `browser` | `{mode: "local", headless: true, profile: "default", chromePath?, cdpUrl?, docker: {image: "sun-harness/browser:latest"}, viewport: {width: 1280, height: 800}}` | agent browser ([Browser](browser.md)); `mode`: local, docker, cdp |
| `sandbox` | `{mode: "auto", network: "on", allow: [...], writable: [], denyRead: [...], scrubEnv: true, autoApprove: false, docker: {image: "node:22-bookworm-slim"}}` | shell sandbox ([Shell sandbox](sandbox.md)); `mode`: auto, seatbelt, bwrap, docker, off; `network`: on, off, allowlist |
| `rules` | `{globalMaxChars: 12000, projectMaxChars: 40000}` | separate prompt budgets for global and project rules |
| `providers.<id>` | presets | `{type: openai|anthropic, baseUrl, apiKeyEnv, apiKey?, models[], headers?, echoReasoning?, noKey?, contextWindow?, modelContext?, cacheControl?}` — `cacheControl` turns on explicit prompt caching for OpenAI-compatible APIs that support it (on for the DashScope preset) |
| `skills` | `{extraDirs: [], compat: true}` | extra skill folders; read Claude/agents locations |
| `plugins` | `{disabled: [], settings: {}}` | plugin control |
| `mcp.enabled` | `true` | connect MCP servers |
| `kb.roots` | `[~/.sun/kb]` | personal KB folders |
| `kb.company` | disabled | `{enabled, name, baseUrl, tokenEnv}` |
| `kb.embeddings` | `{enabled: false, model: "qwen/text-embedding-v4"}` | hybrid BM25 + embedding retrieval; `dimensions?` |
| `intel` | 14 sources, 09:00 | `{sources[], analysisModel?, hour, minute}` |
| `evolution.autoReflect` | `false` | reserved |
| `jobs.promoteAfterMs` | `30000` | MCP calls still running after this move to a background job (0 = never) |
| `jobs.killOnExit` | `false` | kill background jobs when sun-harness exits (default: they keep running and are re-attached) |
| `bots` | all disabled | `{defaultMode, approvals: chat|deny, telegram{enabled,tokenEnv,allowedUsers,apiBase?}, dingtalk{enabled,appSecretEnv,allowedUsers}, webhook{enabled,allowedUsers}, feishu{…}, wechat{…}, wecom{…,agentId}}` — see [Chat bots](bots.md) |

Provider presets: `deepseek`, `anthropic`, `openai`, `glm`, `qwen` (DashScope), `gemini`, `openrouter`, `ollama`. Add your own:

```json
{ "providers": { "kimi": { "type": "openai", "baseUrl": "https://api.moonshot.cn/v1", "apiKeyEnv": "MOONSHOT_API_KEY", "models": ["kimi-k2"] } } }
```

## Data layout

```text
~/.sun/
  config.json  .env  AGENTS.md  mcp.json  hooks.json  schedules.json  gateway.json  gateway.log
  gateway-devices.json         # device token hashes (0600)
  remotes.json                 # client side: remotes and pinned certificates (0600)
  bots.json                    # chat → session map
  tls/cert.pem key.pem         # gateway certificate (key 0600)
  sessions/<id>.jsonl          # durable session logs
  memory/MEMORY.md
  kb/                          # personal notes (kb_add_note writes to kb/notes/)
  kb-index/embeddings.json     # embedding cache for hybrid retrieval
  skills/<name>/SKILL.md
  plugins/<name>/
  evolution/proposals/*.json  backlog.md  journal.md
  intel/state.json  raw/<date>.json  reports/<date>.{md,html}  launchd.log
  jobs/<job-id>.log .json .exit  # background job output, record, exit status
  worktrees/<repo>-<id>/       # worktree sessions
  bin/sun.mjs                  # self-contained CLI used by launchd
  web/                         # web UI served by the gateway
  workspace/                   # default folder for agent/assistant sessions
```
