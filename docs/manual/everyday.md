# Everyday conveniences

Small things that save time in every session.

## Custom slash commands

Save a prompt you use often as Markdown:

```markdown
<!-- .sun/commands/review.md  (project)  or  ~/.sun/commands/review.md  (everywhere) -->
---
description: Review a file for bugs
argument-hint: <file> [focus]
mode: plan
---
Review $1 for bugs and risky edge cases. Focus: $ARGUMENTS
```

Then type `/review src/parser.ts "error handling"` in the desktop, the CLI chat, or a chat bot. Sub-folders become namespaces (`.sun/commands/git/pr.md` → `/git:pr`). Claude Code commands in `.claude/commands` work too. `sun commands` lists them; the desktop `/` menu shows them with their hints.

## Mention files with @

`Explain @src/parser.ts` attaches the file; `@src/` attaches a folder listing; `@screenshot.png` attaches the image. In the desktop, typing `@` opens path completion (↑↓, Tab or Enter).

## Images

Paste a screenshot into the desktop composer, drop image files on it, or click ⊕. CLI: `sun run "what is broken here?" --image shot.png`, or mention `@shot.png`. Use a vision model (for example `qwen/qwen3-vl-plus`, `openai/gpt-4o`, Claude); text-only models are told that images were attached. Mark more models with `"providers": { "deepseek": { "vision": ["my-model"] } }`.

## See what changed

Edit tool cards show the diff (green added, red removed) right in the transcript; click the card for the full diff and output.

## Cost

The session bar shows the estimated cost; `/cost` breaks it down per model, including the prompt-cache share. Prices are estimates from a built-in table; set your own:

```json
{ "pricing": { "deepseek/deepseek-chat": { "input": 0.28, "cached": 0.028, "output": 0.42 } } }
```

## Rewind

Hover a message you sent and click **↶ Rewind**. sun opens a new session with the conversation as it was before that message, puts your message back in the composer to edit, and (if you choose OK) also undoes the file edits made since. The original session is kept. CLI: `/rewind` lists your messages, `/rewind 3 files` rewinds to message 3 and restores files.

## /compact

Long session getting slow or expensive? `/compact` summarizes the older part now (it also happens automatically near the context limit).

## Export, share, import

- Desktop: **Export…** in the session bar → Markdown, HTML (a single file anyone can open) or JSONL.
- CLI: `sun export <session> --format html -o session.html`, chat `/export md`.
- Import a JSONL export (from another machine or a colleague): `sun import session.jsonl`, or ⌘K → *Import session*.

## Find anything: ⌘K and search

- **⌘K** (Ctrl+K): start a session in any mode, open a screen, import, run the briefing, or jump to a session by name.
- The search box above the session list searches titles and message text.

## Notifications

When the app is in the background, macOS notifications tell you when a session finished, paused, failed, or needs approval. Click to open it.

## Scripts and CI

`sun run "…" --output stream-json` prints one JSON object per line while the agent works and a final `{"type":"result", …, "costUsd": …}`. The CLI chat prints a status line after each turn (model · mode · tokens · cache · cost).

## Stalled connections

If a model connection goes silent (no data for 2 minutes, or no response for 90 seconds), sun abandons it and retries. Tune with `"streamTimeouts": { "firstByteMs": 90000, "idleMs": 120000 }`.
