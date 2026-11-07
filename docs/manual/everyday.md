# Everyday conveniences

Small things that save time in every session, and the context report that shows what each session costs in tokens.

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

- After every turn that edited files, a card lists them: **A**dded / **M**odified / **D**eleted with +/− lines. Click a file for its **Diff** (line numbers on both sides) or the whole **File**; **Open**, **Copy path**, or **Revert** it to how it was before that turn.
- **▤ Changes** in the session bar opens the review for the whole session: a folder tree on the left, diff or file on the right, the same actions.
- Edit tool cards still show each edit's diff inline.
- Reverting is safe: it is itself undoable (**↶ Undo**), and the agent is told to re-read the file.
- CLI: a summary after each turn and after `sun run`; `/changes` (this turn) or `/changes all`, `/diff [path]`, `/revert <path>`; `sun changes <session> --diff`. Chat bots post “📝 N files changed” after a turn.

## Cost

The session bar shows the estimated cost; `/cost` breaks it down per model, including the prompt-cache share. Prices are estimates from a built-in table; set your own:

```json
{ "pricing": { "deepseek/deepseek-chat": { "input": 0.28, "cached": 0.028, "output": 0.42 } } }
```

## Rewind

Hover a message you sent and click **↶ Rewind**. sun opens a new session with the conversation as it was before that message, puts your message back in the composer to edit, and (if you choose OK) also undoes the file edits made since. The original session is kept. CLI: `/rewind` lists your messages, `/rewind 3 files` rewinds to message 3 and restores files.

## How full is the context?

Every session shows a small ring in its bar (and a percent in the sidebar): how much of the model's context window the last request used. Click it for the **context report**:

- a bar split by what fills the context (system prompt, tool definitions, your messages, attached files, images, recalled memories, assistant messages, tool results), with the compaction threshold marked;
- each category opens to show its largest parts (for example which rule file, which tool output);
- the provider's own numbers for the last request (input, cache share, output);
- suggestions ("run /compact", "this read_file result alone is 30 %", "disable unused MCP servers", "the skills index is large"), plus **Compact now** and **Export HTML**.

CLI: `/context` in chat, or `sun context <session>` (`--json`, or `--format html -o report.html`). Chat bots: `/context`.

## Steer while it works

Type while the agent is running: your message reaches it at the next step (after the current tool finishes), not after the whole run. Prefer the old behavior? `"steering": "after-run"`.

## Titles, pins, archive

Sessions get a short title written by the model after the first answer (turn off with `"titles": "first-message"`; renaming always wins). Hover a session in the sidebar to pin it (○ → ◉, Pinned group at the top) or archive it (↧; Archived is collapsed at the bottom). CLI: `sun pin | archive <session>`, `sun sessions --all`.

## Keyboard

| Keys | Does |
|---|---|
| Esc | stop the running session |
| ↑ (empty composer) | bring back your last message |
| ⌘N / Ctrl+N | new session |
| ⌘K / Ctrl+K | command palette |
| @ · / | file completion · command menu |

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
