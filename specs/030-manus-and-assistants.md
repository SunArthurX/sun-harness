# 030 — Manus, Hermes, and OpenClaw

Status: implemented (0.10.0). Code: `packages/core/src/ux/slides.ts`, `memory.ts` (`USER.md`, daily notes), `skills.ts` (`expandSkillCommand`), `host.ts` (`wideResearch`), tools `wide_research`, `make_slides`, `session_search`, `remember_user`. Desktop: user profile in Settings, Deliverables in the session bar.

## What was still missing

Manus, Hermes, and OpenClaw overlap this harness on plans, browser, sandbox, schedules, skills, and long-term memory. The gaps that change daily use:

| Product | Strength | What shipped |
|---|---|---|
| Manus wide research | Each item gets a fresh context, then the parent synthesizes | `wide_research`: 2–8 items, one subagent each, `research/<question>.md` |
| Manus slides | A deck you can open, with speaker notes | `make_slides`: self-contained HTML plus a notes file. No cloud renderer |
| Manus deliverables | The files are a first-class list, not a sentence in the answer | Session bar **Deliverables** (`slides/`, `research/`, screenshots, figures, edits) |
| Hermes `USER.md` | A tiny profile, always loaded, separate from notes | `~/.sun/memory/USER.md`, 1,375 characters, `remember_user` |
| Hermes `/skill` | An installed skill is a command | `/name` loads that skill when no custom command owns the name. The body is in the logged message |
| OpenClaw daily notes | A diary that does not bloat the prompt | `~/.sun/memory/daily/YYYY-MM-DD.md`, one line when an assistant session is summarized |
| Hermes and OpenClaw recall | Search old conversations from the agent | `session_search` (same index as the sidebar) |

Decision: wide research stays on this machine and stops at 8 items. Manus's hundreds of cloud VMs are a hosting product, not a local harness. Slides are HTML so they open with no Office install and no image API.

## User profile

`readUserProfile` / `saveUserFact` / `writeUserProfile`. The profile is its own prompt section (`# User`), not mixed into `MEMORY.md`. Oldest bullets added by `remember_user` are dropped to stay under the cap. Decision (T05c): newly extracted core facts go to `MEMORY.md`. Existing profile text is preserved. See [Settings and capability management](032-settings-and-capability-management.md).

## Skill commands

`expandSkillCommand` runs only after custom commands miss. The logged `user/message.text` is the skill body plus the user's words, and `command.name` is the skill, so the turn is reconstructable.

## Wide research

`wideResearch` runs subagents one after another (fresh session, agent mode, same workspace). Sequential on purpose: each context stays clean, and a scripted provider is not asked two questions at once. The combined markdown is the deliverable; the parent model still writes the conclusion.
