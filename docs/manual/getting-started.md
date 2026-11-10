# Getting started

## Requirements

- macOS (Linux and Windows work for CLI/core; the launchd schedule is macOS-only), Node.js ≥ 22, pnpm ≥ 10.
- At least one model API key as an environment variable, for example `DEEPSEEK_API_KEY`.

## Install from source

```sh
git clone <repo> sun-harness && cd sun-harness
pnpm install
pnpm build            # core + CLI (+ bundle) + desktop
```

If the Electron binary download fails (restricted networks), run it through a mirror:

```sh
cd node_modules/.pnpm/electron@*/node_modules/electron
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ node install.js
```

Optional: put `sun` on your PATH.

```sh
ln -s "$PWD/packages/cli/dist/index.js" /usr/local/bin/sun
```

## Configure a model

Keys are read from the environment. sun-harness also imports simple `export NAME=value` lines (names ending in `_API_KEY`, `_BASE_URL`, `_API_BASE`, `_TOKEN`, `_MODEL`) from `~/.zshrc`, `~/.bashrc`, etc., and from `~/.sun/.env`, so the desktop app and scheduled jobs see the same keys as your terminal.

Check what is ready:

```sh
sun doctor       # providers, skills, MCP, KB, schedule, and a live "ping" of the default model
sun models       # ● ready  ○ missing key
```

Change the default model in the desktop Settings page or in `~/.sun/config.json`:

```json
{ "defaultModel": "deepseek/deepseek-chat", "fallbackModels": ["qwen/qwen3-coder-plus", "glm/glm-4.6"] }
```

## First session — desktop

Install the app (macOS, Apple Silicon or Intel):

```sh
pnpm desktop:install   # builds sun-harness.app and copies it to ~/Applications
open ~/Applications/sun-harness.app
```

Or run it from the checkout:

```sh
pnpm desktop:start     # built app
pnpm desktop           # dev mode with hot reload
```

The app is ad-hoc signed for your own Mac. To give it to someone else, sign it with an Apple Developer ID and notarize it.

The UI is English or Simplified Chinese (left rail **EN** / **中**, or Settings → Language).

1. Pick **Coding**, choose a project folder, press **Start**.
2. Ask for something concrete: "Add a `--version` flag to the CLI and a test for it."
3. Watch tool cards stream in. Writes inside the workspace run freely in the default `auto-edit` mode; shell commands show an approval card — **Allow**, **Always allow bash**, or **Deny**.

## First session — CLI

```sh
cd my-project
sun                                   # interactive chat (coding mode)
sun run "Summarize this repo's architecture into ARCHITECTURE.md"
sun --mode agent run "Research the top 3 open-source vector databases and write a comparison table to report.md"
```

## Make a project harness-ready

```sh
sun init     # AGENTS.md (+ CLAUDE.md symlink), specs/000-vision.md, .sun/{rules,skills,mcp.json,hooks.json}
```

Then edit `AGENTS.md` and `specs/000-vision.md`. Every session reads them (see [Rules and specs](rules.md)).

## Always-on gateway (recommended)

```sh
sun gateway install    # one background owner for sessions, schedules, jobs; web UI at http://127.0.0.1:4471
```

See [Gateway and web UI](gateway.md).

## Daily harness intel

```sh
sun intel run                 # first briefing now
sun intel install-schedule    # every day at 09:00 (macOS launchd)
```
