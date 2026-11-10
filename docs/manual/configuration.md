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
| `storage.trashDays` | `7` | Keep new trash operations for 1–365 days before purging |
| `storage.autoCleanupDays` | `0` (off) | At 1–3650 days, move eligible older archived chats and orphaned attachments to trash |
| `browser` | `{mode: "local", headless: true, profile: "default", chromePath?, cdpUrl?, cdpAllowDownloadPolicy?, docker: {image: "sun-harness/browser:latest"}, viewport: {width: 1280, height: 800}}` | agent browser ([Browser](browser.md)); `mode`: local, docker, cdp |
| `pricing` | built-in table | `{"provider/model": {input, cached?, output}}` in USD per million tokens; `prefix*` keys allowed |
| `ui.language` | `system` | desktop and web UI: `system` (OS/browser, Chinese → Simplified Chinese), `en`, or `zh-CN` ([Desktop](desktop.md)) |
| `automations` | `{detect: true}` | turn scheduling phrases in typed messages into proposals ([Automations](automations.md)) |
| `steering` | `immediate` | messages sent during a run reach the model at the next step (`after-run`: when the run ends) |
| `titles` | `model` | session titles written by the model after the first run (`first-message`: the first message) |
| `streamTimeouts` | `{firstByteMs: 90000, idleMs: 120000}` | abandon and retry silent model connections |
| `providers.<id>.vision` | name heuristic | `true` or a model list: which models receive images |
| `lsp` | `{enabled: true, timeoutMs: 8000, servers: {typescript, python, go, rust}}` | language servers for diagnostics after edits ([Coding](coding.md#how-edits-work)) |
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

## Save and recovery behavior

The desktop and gateway web settings pages read the saved revision before editing.
If another client saved first, reload the latest values, compare the pending edit,
then choose whether to apply it. Provider credentials and protected endpoints stay
in the local file. The UI displays credential readiness and its source. Use a local
editor for an endpoint that includes authentication, query parameters or a fragment.

Host settings wait for the active turn to finish. A sandbox change also waits for
active jobs. Language changes apply immediately. Reinstall the managed Intel
schedule after changing its time in Settings.

If configuration is malformed, the desktop opens a recovery screen with the file
location. Correct the file and reopen the app. A file marked for a newer settings
schema requires a supported app version. The existing JSON layout remains compatible
and a normal save preserves unknown keys. Save operations require a regular file at
the configuration path.

Settings changes record operation IDs, changed field names and revisions in
`~/.sun/settings/audit.jsonl`. The app reports when a write committed and audit
completion or disk synchronization could not be confirmed. A gateway and its clients
must support the same settings interface. Upgrade both when a settings request
reports a protocol mismatch.

## Capability status

Run `sun capabilities` to see the settings protocol and the capabilities of the
current host. Add `--local` to inspect a local runtime when a gateway is running.
Capability IDs stay stable across desktop, web, and CLI. The state can differ
with the surface, available backends, and the current extension configuration.

The Electron and gateway clients check the settings protocol on each request.
If versions differ, update the app and gateway together. Native capture and
computer inspection are unavailable without a desktop adapter. The web gateway
has no native capture or control route.

## Find and edit settings

Open **Settings** from the app rail. The General section opens first. The
Personal, Integrations, and Coding groups show sections backed by the current
host. Search accepts English or Simplified Chinese terms in either interface
language. Press Down in the search box to move to results, then press Enter
to open a result and focus the matching field.

Settings section links use the `#settings/<section>` fragment. For example,
`#settings/providers` opens provider settings after connecting to the gateway.
Use Back to return to the previous page or section. Leaving a section with a
draft offers a choice to discard it or stay. Web browser reload uses the browser's
unsaved-change prompt.

Edit the fields in a section, then select **Save changes**. The action writes
the section's changes together. The Language section saves user preferences
separately from host settings. Each field shows whether its value came from
defaults, the configuration file, or the environment. An invalid edit stays in
the form with an error. On conflict, reload the latest settings and compare
each changed field before selecting **Apply my edits**.

## Everyday preference keys

The preference service preserves existing settings and fills omitted fields with
defaults. Edit these keys in the Settings sections or the local configuration file.

| Key | Default | Effect |
|---|---|---|
| `defaultMode` | `coding` | Default for a new session without an explicit mode |
| `ui.startPage` | `chat` | Startup page preference |
| `ui.theme`, `ui.textScale`, `ui.reducedMotion` | `system`, `1`, `system` | Appearance preferences |
| `ui.notifications` | Completion, pause, failure and approval on | Event filters and optional quiet hours |
| `ui.shortcuts` | `Primary+K`, `Primary+N`, Mini unbound | Shortcut binding preferences |
| `ui.readAloud`, `ui.mini` | `false` | Read-aloud and Mini preferences |
| `memory.enabled` | `true` | Automatic memory prompt context, recall and extraction |
| `voice.enabled` | `true` | Allow recording and transcription through supported entry points |

Quiet hours use a named timezone and local `HH:MM` times. A window that crosses
midnight includes its start and excludes its end. An equal start and end disable
the interval. Disabling automatic memory leaves stored memories and the explicit
user profile available for editing.

## Applied appearance and input preferences

Appearance follows the saved theme, text scale, and motion preference. The
system options follow the current OS or browser media preferences. The startup
page applies when opening the app without a section link. A direct settings link
still opens its requested section.

Notifications use live session events. Turning off an alert type or entering
quiet hours keeps the approval cards and session status visible in the app.
Use **Settings → Notifications** to check or request permission. The app
requests permission when you select **Allow notifications**.

Voice recording starts from the composer button. **Stop and transcribe** submits
the recording. **Cancel voice input** releases the microphone and discards the
buffer. Cancelling after submission aborts the request and ignores late text.
A denial leaves the composer available for typing. An existing read-aloud
preference is migrated from the renderer's legacy storage when it has no
explicit replacement in the settings file.

`Primary` means Command on macOS and Control elsewhere. The app remaps its
command palette and new-session keys from the settings snapshot. Desktop global
shortcut registration is staged before saving. An occupied key leaves the
last active binding and the saved file intact. Enable the panel and optionally
assign its global shortcut in **Settings → Mini**.
