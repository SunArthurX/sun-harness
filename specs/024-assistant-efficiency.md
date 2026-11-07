# 024 — Assistant efficiency (phase 5)

Status: implemented. Code: `packages/core/src/assistant/{memstore,router,connectors,briefing,triggers,voice,metrics}.ts`, `host.ts` (recall, extraction, routing, briefing, triggers, transcription, metrics), `gateway.ts` (`/trigger/<id>`), bots (briefing delivery), desktop (voice, read aloud, memory list, briefing, efficiency), CLI.

## Principle

An assistant is efficient when the user says less and waits less: it already knows the context (memory), uses the user's real systems (connectors), spends strong models only where needed (routing), shows up on its own (briefing, triggers), accepts the fastest input (voice), and proves it with numbers (metrics).

## Layered memory

| Layer | Store | In the prompt |
|---|---|---|
| Core | `~/.sun/memory/MEMORY.md` (sections) | always (system prompt), ≤ 12k chars |
| Long-term | `~/.sun/memory/items.jsonl` — `{id, text, kind: fact/preference/person/project/lesson/episode, created, source, uses, lastUsed}`, append-only with tombstones | recalled per user message |

- **Recall:** for user messages in `memory.recallModes` (default assistant, agent), the top `recallK` (4) items by BM25 (ASCII words + CJK bigrams) × a small recency/usage prior, above a score threshold and not recalled earlier in the session, are appended as a `user/message` with `source: 'memory'` immediately before the user's message. Recall is part of the log (reproducible) and keeps the system prompt stable (prompt cache).
- **Tools:** `memory_save(fact, kind?, core?)` — long-term by default, core with `core: true` or a `section`; `memory_search(query)`.
- **Auto-extraction:** when a run in `memory.extractModes` (default assistant) ends idle with new user messages since the last extraction, a background call (router background model) receives the new conversation (recalled blocks excluded) plus related known memories and returns `{memories: [{text, kind, core}], episode}`. Items are deduplicated (normalized text or ≥ 80% token overlap), core items go to `## Profile`, the episode is stored as `kind: episode`, and `memory/extract {added, episode, model}` is logged. Subagent sessions are skipped.
  - *Decision (live test, deepseek-chat):* the first prompt also stored the assistant's own suggestions ("may want Friday reminders", sightseeing "lessons"): 6 items from one turn. Requiring "only what the user said or confirmed, never guesses" reduced it to the 2 true facts plus the episode.

## Model routing

`router.background` serves harness-internal calls (memory extraction; other internal calls may adopt it). Sessions with model `auto` pick per request: `routeTier` → `strong` for code, stack traces, long (> 1200 chars) or analytical requests (English and Chinese keywords), or runs with ≥ 2 recent tool errors or ≥ 12 steps; otherwise `fast`. The chosen model is what `request/header` and `assistant/message` log. Unconfigured or unready tiers fall back to the other tier, then the default model.

## Connectors

- **DingTalk** through the DingTalk Workspace CLI (`dws`): `dingtalk_read(args)` (risk read; refuses commands that are not clearly read-only — write verbs or unknown verbs) and `dingtalk_write(args)` (risk network, passes approval). Both are offered only when `dws auth status` reports a login, and both are untrusted sources (messages from other people). The bundled `dingtalk-*` skills document the commands.
- **Email and calendar MCP presets:** `sun mcp presets | add <preset>` (gmail, google-calendar, outlook, apple) write `~/.sun/mcp.json` and add `mcp__<name>__*` to `taint.untrusted`.

## Daily briefing

`briefing {enabled, hour, minute, chats, extra}`. The background tick (gateway, desktop) runs it once per day after the configured time: a new assistant session with a read-only briefing prompt (calendar, todos, approvals, unread messages via `dingtalk_read` when available; follow-ups from memory; the day's intel report; up to three priorities). The answer is saved to `~/.sun/briefings/<date>.md`, broadcast as `LiveEvent {kind: 'briefing'}` and a notice, and sent to bot chats listed as `"platform:chatId"`.

## Event triggers

`triggers: [{id, kind: 'watch' | 'webhook', prompt, mode?, cwd?, path?, match?, debounceMs?, secretEnv?, enabled?}]`.

- `watch`: recursive `fs.watch` on `path` (dot-files ignored, optional `match` regex), bursts debounced (default 2 s) into one session with `{{files}}`.
- `webhook`: `POST /trigger/<id>` on the gateway, authorized by a gateway/device token or the `X-Sun-Trigger-Secret` header matching `env[secretEnv]`; the body (≤ 200 kB) becomes `{{payload}}`, scanned and wrapped as untrusted, with `context/taint` logged before the message (`source: 'trigger'`).

## Voice

- Speech to text: `voice.stt` is a provider/model ref. Chat models that accept `input_audio` (default `qwen/qwen3-asr-flash` on DashScope) or OpenAI transcription models (`whisper`, `*transcribe*` → `/audio/transcriptions`). Non-MP3 audio is re-encoded to 16 kHz mono MP3 with ffmpeg when available.
- Desktop: 🎙 records with `MediaRecorder` and fills the composer; 🔈/🔊 reads final replies aloud with the OS voices (`speechSynthesis`). The main process grants only audio media permission; the packaged app declares `NSMicrophoneUsageDescription`.
- CLI: `/voice [seconds]` in chat, `sun voice record | transcribe <file>` (ffmpeg microphone capture).

## Efficiency metrics

`conversationMetrics` per mode over sessions updated in the last N days (eval sessions excluded): sessions, user turns, turns per session, median first-response time and turn time, tool calls per turn, tool error rate, approval prompts per turn, denial rate, aborts, pauses, clarify rate (final answer ends with a question), tokens per turn, cache hit rate, memory recalls and extracted memories. Surfaces: `sun metrics [--days]`, gateway `metrics`, desktop Settings → "Efficiency · last 7 days".
