# Research: search, reading, Python, deliverables, safety

Agent mode is built for research and analysis: it searches, reads pages and PDFs, runs Python, fans out to subagents, and leaves files you can open.

## Search

Works without any key: sun uses Bing (`cn.bing.com` by default, reachable in mainland China). For better results add an API key to your environment and sun picks it up automatically:

| Provider | Variable |
|---|---|
| Tavily | `TAVILY_API_KEY` |
| Brave Search | `BRAVE_API_KEY` |
| Serper (Google) | `SERPER_API_KEY` |
| Bocha (博查) | `BOCHA_API_KEY` |

Or pin a provider: `"search": { "provider": "bing", "bingBase": "https://www.bing.com" }`, or self-host SearXNG: `"search": { "searxngUrl": "http://localhost:8080" }`.

## Reading pages and PDFs

`web_fetch` returns the main text of a page as Markdown (menus, footers and scripts removed) and converts PDFs to text. Install poppler for PDFs: `brew install poppler` (macOS) or `apt install poppler-utils`. Long documents come in pages; the agent continues automatically.

Pages that need JavaScript, a login or clicking go through the [browser](browser.md).

## Python

The agent has a persistent Python session (like a notebook): data stays loaded between steps, the last expression is shown, and matplotlib charts are saved to `figures/` in the workspace. Install the libraries you want it to use (`pip install pandas matplotlib`). It runs in the [shell sandbox](sandbox.md).

Cancelling a queued cell preserves the kernel state. Cancelling a running
cell or reaching its timeout starts a fresh kernel for the next cell.

## Parallel subagents

For broad questions the agent splits the work: several `task` calls in one step run at the same time, each in its own child session (shown nested in the sidebar). At most 6 tool calls run at once (`maxParallelTools`).

## Deliverables

**Deliverables** in the session bar lists files the session created or changed, plus `screenshots/`, `figures/`, `slides/`, and `research/`. Click a file to open it. **▤ Changes** is the review of edits (diff and revert).

## Safety: content from the web is data

Everything that comes from web pages, search results and the browser is marked as untrusted for the model, and scanned for prompt-injection tricks ("ignore previous instructions", fake system messages, requests to send secrets, hidden Unicode text).

- Once web content is in a session, shell commands always ask (even with sandbox auto-approve).
- If a page looks like an injection attempt, the result carries a warning and **every** shell or network action asks you first, even in `full-auto`. Headless runs (bots, schedules) deny such actions and tell the agent why.
- Mark more tools as untrusted, for example an email MCP server: `"taint": { "untrusted": ["mail__*"] }`.
