# Assistant: memory, connectors, briefing, triggers, voice, metrics

How the Assistant mode learns about you, reaches your tools, shows up on its own, and how to see whether it saves you time.

## Memory

Two layers:

- **Core memory** (`~/.sun/memory/MEMORY.md`): a few lines that matter in every conversation (name, language, time zone). Always shown to the model. Edit it on the Knowledge screen.
- **Long-term memory**: facts, preferences, people, projects, lessons and one-line summaries of past conversations. Only the relevant ones are recalled when you write a message, so it can grow without slowing anything down.

After each Assistant conversation, sun extracts what you said or confirmed that is worth remembering (never the assistant's own suggestions). You can also say "remember that …".

```bash
sun memory list
sun memory search "sister"
sun memory add "Prefers meetings after 10:00" --kind preference
sun memory rm m_1a2b3c4d
```

The Knowledge screen lists long-term memories with a ✕ to forget one. Turn automatic extraction off with `"memory": { "autoExtract": false }`.

## DingTalk, email, calendar

- **DingTalk**: install the DingTalk Workspace CLI (`dws`) and sign in (`dws auth login`). The assistant then reads your calendar, todos, approvals, messages and docs, and asks before anything that changes data or notifies people.
- **Email / calendar via MCP**: `sun mcp presets` lists ready-made servers (Gmail, Google Calendar, Outlook / Microsoft 365, Apple Mail/Calendar/Reminders). `sun mcp add gmail` adds one and prints its one-time setup. Their content is treated as untrusted (see [Research → Safety](research.md#safety-content-from-the-web-is-data)).

## Cheaper, faster models where possible

```json
{ "router": { "background": "qwen/qwen-flash", "fast": "deepseek/deepseek-chat", "strong": "deepseek/deepseek-reasoner" } }
```

- `background`: the model for sun's own housekeeping (memory extraction).
- Pick the model **auto** for a session (`--model auto`, or in the model menu once configured): quick turns go to `fast`; code, long or analytical requests and struggling runs go to `strong`.

## Daily briefing

```bash
sun briefing enable --at 08:30     # runs while the gateway (sun gateway install) or desktop app is running
sun briefing run                   # now
sun briefing show                  # today's
```

It covers today's meetings and todos (DingTalk when signed in), open follow-ups from memory, the day's harness intel, and up to three priorities. Briefings are saved in `~/.sun/briefings/`. To also receive it in a chat: `"briefing": { "chats": ["telegram:123456789"] }` (see [Chat bots](bots.md)). Settings → Daily briefing has the same switches.

## Event triggers

Start a session when something happens:

```json
{
  "triggers": [
    { "id": "invoices", "kind": "watch", "path": "~/Downloads", "match": "\\.pdf$", "mode": "agent",
      "prompt": "New files arrived:\n{{files}}\nIf any is an invoice, extract vendor, date and total into ~/invoices.csv." },
    { "id": "github", "kind": "webhook", "secretEnv": "SUN_GITHUB_SECRET",
      "prompt": "Summarize this GitHub event and tell me if I need to act:\n{{payload}}" }
  ]
}
```

- Watch triggers run while the gateway or desktop app runs.
- Webhooks: `POST https://<gateway>/trigger/github` with header `X-Sun-Trigger-Secret: $SUN_GITHUB_SECRET` (or a device token). The payload is treated as untrusted content.
- `sun trigger list`, `sun trigger fire github '{"test": true}'`.

## Voice

- Desktop: click 🎙, speak, click **● Stop**: the text appears in the composer. 🔈 / 🔊 toggles reading replies aloud.
- CLI chat: `/voice` (8 seconds) or `/voice 15`. Outside chat: `sun voice record`, `sun voice transcribe memo.m4a`.
- Speech recognition uses `voice.stt` (default `qwen/qwen3-asr-flash`, needs `DASHSCOPE_API_KEY`); an OpenAI-compatible Whisper model also works (`"voice": { "stt": "openai/whisper-1" }`). Install ffmpeg for recording from the CLI and for formats the recognizer does not accept.

## Is it saving me time?

```bash
sun metrics --days 7
```

Per mode: turns, median time to the first reply, approval prompts per turn (interruptions), how often it had to ask you back, tool errors, tokens per turn, prompt-cache share, memories recalled and extracted. Settings → **Efficiency · last 7 days** shows the same.
