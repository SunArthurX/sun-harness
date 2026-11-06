# Evolution

sun-harness improves from use, but only with your consent.

## Reflect

After a meaningful session: desktop **Evolution → Reflect on current session**, `/reflect` in chat, or `sun evolve reflect <sessionId>`. The model reads the session and proposes up to five improvements.

## Proposal types

| Type | Example | Accepting it |
|---|---|---|
| memory | "Prefers short bulleted reports with verification evidence" | added to `MEMORY.md` (every session sees it) |
| skill | "Plain-assert test file pattern" | new `~/.sun/skills/<name>/SKILL.md` (loadable immediately) |
| rule | "Run the tests before reporting done" | appended to `~/.sun/AGENTS.md` (global rules) |
| feature | "Deny instead of prompting in headless runs" | added to `~/.sun/evolution/backlog.md` |

Intel adds `feature` proposals every day.

```sh
sun evolve list pending
sun evolve accept <id>
sun evolve reject <id>
```

Everything accepted is journaled in `~/.sun/evolution/journal.md`, so you can see how the harness changed over time and undo by editing the target file.
