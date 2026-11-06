# 000 — Vision

## Problem

Coding harnesses (Claude Code, Codex, DeepSeek Harness, Cursor, OpenCode, zcode, WorkBuddy, Manus, Hermes) evolve weekly.
A single person wants **one personal harness** that grows with them and with the models: it codes, runs general tasks, assists daily life, learns from use, and tracks what the rest of the field is doing.

## Users

Anyone. The first user is the owner; defaults must be safe for a newcomer and powerful for an expert.

## First principles

An agent harness reduces to six parts:

| Part | Question it answers | sun-harness component |
|---|---|---|
| Model | Who thinks? | `providers/` — OpenAI-compatible + Anthropic adapters, per-session model switch |
| Context | What does it know? | rules loader, skills index, knowledge base, memory |
| Tools | What can it do? | tool registry (built-ins, MCP, plugins) |
| Loop | How does it proceed? | `agent.ts` step loop: request → tool calls → results → repeat |
| Log | What happened? | append-only JSONL session events |
| Policy | What is allowed? | approval modes, workspace path guard, hooks |

Everything else (desktop UI, intel, evolution, modes) is built on these six.

## Capabilities (target)

1. Desktop app first (Electron), CLI second, both on the same core.
2. Anti-drift rules: `AGENTS.md` hierarchy, `specs/`, `.sun/rules/`, compatible with `CLAUDE.md` and `.cursor/rules`.
3. Extensions: skills (`SKILL.md`, Claude-compatible), MCP servers (stdio + HTTP), plugins (ESM modules), hooks.
4. Knowledge: pluggable `KnowledgeProvider`; local markdown provider now, company provider reserved (HTTP contract).
5. Modes: `coding` (code agent), `agent` (Manus-like general task agent), `assistant` (Hermes-like personal assistant with memory).
6. Durability: every session pausable/resumable; quota exhaustion pauses the run, resume after quota restore or model switch.
7. Harness intel: daily fetch of other harnesses' releases, LLM analysis with principles and trends.
8. Evolution: reflect on sessions, propose memory/skill/rule updates, owner approves, harness improves.
9. Documentation: per-milestone manual + teaching HTML with Mermaid. English only.

## Non-goals (for now)

- Multi-tenant cloud hosting.
- Our own model training.
- Full OS sandboxing (path guard + approvals for MVP; containers later).
