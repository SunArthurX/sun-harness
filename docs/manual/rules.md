# Rules and specs — preventing drift

Agents drift when the "why" lives only in a chat. sun-harness keeps the why in files that are injected into **every** request.

## What gets loaded

1. `~/.sun/AGENTS.md` — your global rules (evolution can append accepted rules here).
2. `AGENTS.md` files from the project root down to the session folder — the closest one is most specific. `CLAUDE.md` is read where there is no `AGENTS.md`.
3. `.sun/rules/*.md` — always applied, unless the file has frontmatter `alwaysApply: false` with a `description` (then it is listed and read on demand).
4. `.cursor/rules/*.mdc` with `alwaysApply: true`.
5. An index of `specs/*.md` titles. The coding prompt tells the agent specs are the source of truth and must be updated with behavior changes.

Rules are re-read before every model request, so edits apply immediately.

## Recommended project layout

```text
AGENTS.md            # how to work here (language, commands, conventions, definition of done)
CLAUDE.md -> AGENTS.md
specs/000-vision.md  # problem, users, goals, non-goals
specs/NNN-topic.md   # one per feature area; "Decision" notes record changes
.sun/rules/*.md      # focused rules (style, testing, security)
.sun/skills/*/SKILL.md
```

`sun init` creates this skeleton.

## Writing good rules

- Imperative and checkable: "Run `pnpm test` before finishing" beats "be careful".
- Put commands in rules (build, test, lint) so the agent verifies the same way you do.
- Keep each file short; move rarely needed detail into an optional rule with a description.

## This repository's own rules

sun-harness follows its own `AGENTS.md`: English-only artifacts, spec-first changes, and a definition of done that requires tests, a manual update, and a teaching page per milestone.
