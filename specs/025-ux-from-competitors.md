# 025 — UX absorbed from competitors

Status: implemented (0.5.0). Code: `packages/core/src/ux/{commands,mentions,diff,pricing,export}.ts`, `host.ts` (`prepareUserMessage`, `fork`, `compact`, `cost`, `exportSession`, `importSession`, `searchSessions`, `readAttachment`), `providers/*` (images, stream watchdog), `agent.ts` (vision gating, `display.diff`, `compactNow`), desktop `Composer.tsx`, `Chat.tsx`, `App.tsx`, CLI, bots.

## Principle

Copy what makes the best tools pleasant, but only where it fits the core rules: whatever the model sees is logged (expanded commands, attached files, images by path), the log stays append-only (rewind forks instead of truncating), and every surface (CLI, desktop, web, bots) gets the same behavior from the host.

## Plan (comparison)

| Capability | Seen in | sun-harness before | Now |
|---|---|---|---|
| Custom slash commands | Claude Code `.claude/commands`, Codex prompts | skills only | `.sun/commands`, `~/.sun/commands`, compat `.claude/commands`, `~/.claude/commands` |
| @file mentions + completion | Cursor, Claude Code | — | `@path` attaches files, folders, images; desktop completion |
| Inline diffs | Cursor, Cline | tool output text | `tool/result.diff`, colored in tool cards and exports |
| Cost display | Claude Code `/cost`, Cursor | tokens only | pricing table with cache discount; sub-bar, `/cost`, status line |
| Rewind | Claude Code (double Esc), Cursor checkpoints | undo files only | fork from any user message, optionally restoring files |
| Export / import / share | Codex, ChatGPT | — | Markdown, HTML, JSONL; import JSONL |
| Notifications, ⌘K, search | Claude Desktop, Manus, Raycast-style | — | OS notifications, command palette, full-text session search |
| /compact, status line, stream-json | Claude Code | automatic compaction | `/compact`, per-turn status line, `--output stream-json` |
| Image input | Claude Code, Cursor | — | paste/drop/attach, `--image`, `@shot.png`; vision gating |
| Stall protection | Codex, Claude Code (stream timeouts) | none (a silent stream hung a run) | first-byte and idle watchdog, retried as a network error |

## Custom commands

Markdown files; the file name is the command (`git/pr.md` → `/git:pr`). Optional frontmatter: `description`, `argument-hint`, `mode`, `model`. Body placeholders: `$ARGUMENTS` (everything after the name), `$1`…`$9` (shell-style words; quotes group). Without placeholders, arguments are appended. Precedence (later wins): `~/.claude/commands`, `~/.sun/commands`, `<project>/.claude/commands`, `<project>/.sun/commands`.

Expansion happens in the host for user messages from every surface: the logged `user/message.text` is the expanded prompt, `user/message.command = {name, input}` keeps what was typed, and `mode`/`model` frontmatter is applied as `mode/switch` / `model/switch` events first. CLI built-ins and bot commands take precedence over custom names.

## @mentions

`@relative/path` tokens (after whitespace or at the start; path must exist inside the workspace) become `<attached file="…">content</attached>` (≤ 200 kB; larger files get a pointer to `read_file`), `<attached dir="…">listing</attached>` for folders, and image files (`.png .jpg .jpeg .gif .webp`) become image attachments. Emails, `@handles`, missing and outside paths are left as text. `completePaths(cwd, query)`: git-tracked and untracked-not-ignored files (or a bounded walk) plus their folders, ranked by prefix, base name, substring, subsequence.

## Images

`send(id, text, 'user', {images: [{data, mime}]})` (gateway `sendMessage`) copies images to `~/.sun/attachments/<session>/<n>.<ext>` and logs `user/message.images = [{path, mime}]`; `deriveMessages` loads them when the request is built (reconstructable from the log). Wire formats: OpenAI-compatible `image_url` data URLs; Anthropic base64 `image` blocks before the text. Models that cannot see images (`providers.<id>.vision`: `true`, a model list, or a name heuristic) receive a text note instead. `readAttachment(path)` serves thumbnails only from the attachments folder.

## Diffs

Edit tools set `ctx.display.diff` (unified diff, context 3; LCS on the changed middle, deletions before insertions); the agent logs it as `tool/result.diff`. It is not part of the model's view.

## Cost

`DEFAULT_PRICING` (USD per million tokens: `input`, `cached`, `output`; `prefix*` keys) merged with `config.pricing`. `sessionCost(events)` sums assistant usage per model: `(input − cached) × input + cached × cached + output × output`; unpriced models are listed separately. Surfaces: desktop sub-bar, `/cost` (CLI, desktop, bots), CLI status line, `sun run --json` / stream-json result.

## Rewind (fork)

`fork(session, {beforeSeq, restoreFiles})`, `beforeSeq` = a user message: a new session (`session/meta.forkOf = {session, seq}`) with every event before it except meta, status and title; mode and model as they were at that point; checkpoint snapshots copied so undo works in the fork. With `restoreFiles`, the original session's checkpoints after that point are undone first (logged there). The original log is unchanged otherwise. The typed text (or the command input) is returned to prefill the composer. Surfaces: desktop "↶ Rewind" on user messages, CLI `/rewind [n] [files]`.

## Export and import

`exportSession(id, 'markdown' | 'html' | 'jsonl')`: Markdown transcript (turns, tool calls with arguments, diffs and truncated output, model/mode switches, verification, compaction); self-contained HTML without scripts; raw JSONL. `importSession(jsonl)` creates a new session id with the same events and timestamps (workspace falls back to the default if missing). Surfaces: `sun export | import`, chat `/export`, desktop Export menu (browser download), ⌘K import.

## Desktop

- Composer: `@` path completion and `/` command menu (custom commands + `/compact`, `/cost`, `/export`), ↑↓ Tab/Enter, image paste, drag-and-drop and ⊕ attach with thumbnails.
- OS notifications (window in the background, top-level sessions) when a run finishes, pauses, fails, or needs approval; click opens the session. The main process allows only `notifications` and audio `media` permissions.
- ⌘K / Ctrl+K palette: new session per mode, screens, import JSONL, run briefing, jump to any session.
- Sidebar search: titles and message text (`searchSessions`), with snippets.

## CLI and bots

- Chat: `/compact`, `/cost` (`/status`), `/export [md|html|jsonl] [file]`, `/rewind [n] [files]`, custom commands (listed in `/help`), and a status line after each turn: `model · mode · tokens · cache share · $cost`.
- `sun run --output stream-json`: every live event for the session as one JSON line, then `{"type": "result", sessionId, status, text, costUsd}`; `--image <file>` (repeatable).
- `sun export`, `sun import`, `sun search`, `sun commands`.
- Bots: `/compact`, `/cost`, `/commands`, and custom commands.

## Stream watchdog

`streamTimeouts` (default `firstByteMs: 90000`, `idleMs: 120000`): providers abort a request whose headers do not arrive in time or whose stream stays silent, and raise a `network` ProviderError, which the agent retries with backoff and finally pauses as `network` (auto-resume). *Found in the live test:* a DeepSeek stream stayed silent for more than two minutes after a tool result with the connection open; without a watchdog a truly dead connection would hang the run forever.
