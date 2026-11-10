# 031 — Right workspace dock

Status: implemented (0.11.0). Code: `apps/desktop/src/renderer/src/Dock.tsx`, `SessionDock`, `DOCK_PANES`. Host: `listWorkspace`.

## Cursor's interaction

In the Agents Window the chat stays in the center. The right side is one workspace column, not four permanent apps. A switcher lists **Changes** (with the session's +/−), **Browser**, **Terminal**, and **Files**. Clicking a row opens that pane in the column; clicking it again closes it. Files is a tree of the workspace the agent is in. Terminal is the scrollback of commands that agent ran. Browser is the live page. Changes is the diff review.

## Decision

sun-harness uses the same column and the same four panes. The switcher is data: `DOCK_PANES`. Adding a pane is a new id in that list and a branch in `DockBody`. The switcher does not import pane internals.

The terminal is the session log of `bash` calls and their results, plus background jobs, including commands that have not finished yet. A later interactive terminal replaces `TerminalPane` only. Files lists one directory at a time through `listWorkspace` (workspace path guard, ignored names omitted), refreshes when the session log grows, and reads a file with `readSessionFile`.

## Surfaces

Desktop session view, to the right of the transcript. The session-bar Changes and Browser chips open the same panes. English and Simplified Chinese.
