# Harness intel

A daily briefing on what other agent harnesses shipped — what changed, the mechanism underneath, why it matters, and ideas for sun-harness.

## Run it

```sh
sun intel run            # fetch + analyze now
sun intel list           # all reports (pending analysis marked)
sun intel show [date]    # print a report
sun intel analyze <date> # redo analysis from saved raw items
```

Reports: `~/.sun/intel/reports/<date>.md` and `.html`. The desktop **Harness Intel** screen shows the same.

## Schedule it (macOS)

```sh
sun intel install-schedule     # daily at intel.hour:intel.minute (default 09:00)
sun intel uninstall-schedule
```

This copies a self-contained CLI to `~/.sun/bin/sun.mjs` and installs `~/Library/LaunchAgents/com.sun-harness.intel.plist`. Log: `~/.sun/intel/launchd.log`. If the Mac sleeps through 09:00, launchd runs the job on wake; the desktop app also catches up when opened. Re-run `install-schedule` after upgrading sun-harness or changing the time.

## Sources

Defaults: Claude Code (changelog), Codex, Gemini CLI, OpenCode, DeepSeek Harness, Cline, Aider, Goose, Qwen Code, OpenHands, Hermes Agent, Crush, MCP spec (GitHub releases), Cursor changelog (page snapshot). Customize in `~/.sun/config.json`:

```json
{ "intel": { "sources": [
  { "id": "zed", "name": "Zed", "kind": "github-releases", "target": "zed-industries/zed" },
  { "id": "blog", "name": "Some blog", "kind": "rss", "target": "https://example.com/feed.xml" }
], "analysisModel": "deepseek/deepseek-reasoner" } }
```

GitHub requests use `GITHUB_TOKEN`/`GH_TOKEN` or your `gh` login to avoid rate limits.

## From intel to features

Each report ends with ideas; the top 8 become `feature` proposals on the Evolution screen. Accepting one adds it to `~/.sun/evolution/backlog.md`. In this repository, a backlog item becomes a spec, then code and tests — see `specs/008-approval-policy.md` for the first feature that came from intel.
