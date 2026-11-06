# 005 — Harness intel

Status: implemented (M4). Code: `packages/core/src/intel.ts`.

## Goal

Every day, learn what other harnesses shipped, *why it works* (mechanism / principle), and what sun-harness should adopt.

## Sources

`intel.sources` (defaults in `config.ts`): GitHub releases (Codex, Gemini CLI, OpenCode, DeepSeek Harness, Cline, Aider, Goose, Qwen Code, OpenHands, Hermes Agent, Crush, MCP spec), Claude Code `CHANGELOG.md`, and page snapshots (Cursor changelog). Kinds: `github-releases`, `github-changelog`, `rss`, `page`.

- GitHub auth: `GITHUB_TOKEN`/`GH_TOKEN`, else `gh auth token`.
- Changelogs are read via the GitHub contents API (raw.githubusercontent.com is a fallback; it is blocked on some networks).
- Page snapshots are de-duplicated by content hash.

## Run

1. Fetch all sources in parallel; per-source errors are reported, not fatal.
2. New = ids not in `~/.sun/intel/state.json`. First sight of a source keeps at most 3 items from the last 21 days.
3. Save raw items to `~/.sun/intel/raw/<date>.json`.
4. Analyze with the intel model (`intel.analysisModel` or the default model). Report sections: TL;DR, Changes by harness (What changed / Mechanism / Why it matters), Trends, Ideas for sun-harness (priority, effort), then a JSON idea block.
5. Ideas → evolution proposals of type `feature`, highest priority first, at most 8 per run; the JSON block is stripped from the report.
6. Write `~/.sun/intel/reports/<date>.md` and `.html` (Mermaid-capable). Dates are local calendar dates.

If analysis fails (quota, auth, network), the report is written with raw items and marked "Analysis pending"; `sun intel analyze <date>` or the desktop button re-runs analysis from the saved raw items.

## Schedule

- macOS: `sun intel install-schedule` copies the self-contained CLI bundle to `~/.sun/bin/sun.mjs` and installs `~/Library/LaunchAgents/com.sun-harness.intel.plist` (daily at `intel.hour:intel.minute`, default 09:00). Node runs directly; no shell rc is executed.
- Decision: the bundle lives outside the repo because launchd jobs cannot read TCC-protected folders such as `~/Downloads` without an interactive prompt (the job hangs silently).
- Desktop catch-up: if the app is open after the scheduled time and today has no report, it runs once.
