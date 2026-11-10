# 023 — Research agent (phase 4)

Status: implemented. Code: `packages/core/src/research/{search,readable,tools,python,taint}.ts`, `agent.ts` (`guardUntrusted`, tool pool), `policy.ts`, `host.ts` (research tools, kernels, `deliverables`), desktop Files panel.

## Principle

A research agent is only as good as its sources and as safe as its handling of them. Search must work on the user's network, pages must arrive as clean text, data work needs a real interpreter, results must be files the user can open, and nothing a web page says may steer the agent's actions.

## Search

`web_search(query, limit?)` with `config.search.provider`:

| Provider | Needs | Notes |
|---|---|---|
| `auto` (default) | — | first provider whose key is set (Tavily, Brave, Serper, Bocha), else SearXNG if `searxngUrl`, else Bing |
| `bing` | nothing | HTML results from `search.bingBase` (default `https://cn.bing.com`, reachable in mainland China); redirect links (`/ck/a?…&u=a1<base64url>`) are unwrapped |
| `duckduckgo` | nothing | HTML endpoint (blocked on some networks) |
| `tavily`, `brave`, `serper`, `bocha` | `TAVILY_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`, `BOCHA_API_KEY` (names configurable in `search.keys`) | JSON APIs |
| `searxng` | `search.searxngUrl` | self-hosted metasearch |

Capability gating probes the chosen keyless provider (cached 10 minutes); keyed providers are assumed available.

*Decision (measured on this network):* DuckDuckGo, Brave, Jina and public SearXNG were unreachable; Bing (cn) answered. Baseline evals logged 38 failing `web_search` calls against DuckDuckGo before capability gating existed.

## Reading

`web_fetch(url, start?, raw?)`:

- HTML → readable Markdown: `<head>`, scripts, styles, nav, header, footer, aside, forms, buttons, iframes, and hidden elements are dropped; the largest `<article>` (else `<main>`, else body) is kept if it has more than 400 characters of text; headings, links (absolute), lists, tables, inline code and code blocks are converted. Title and meta description head the output.
- PDF (by content type or `.pdf`) → text with `pdftotext -layout` (poppler); pages separated by `--- page ---`.
- Other types are returned as text. Output is paged at 30,000 characters (`start` continues).

## Python kernel

`python(code, restart?, timeout_ms?)` (risk exec): one persistent `python3` process per session, started through the session's shell sandbox, speaking JSON lines. Cells share globals; the value of a final expression is echoed (`Out: …`); stdout/stderr are captured; exceptions return a short traceback; open matplotlib figures are saved to `figures/fig-N.png` in the workspace (`MPLBACKEND=Agg`). A timeout or abort restarts the kernel and says that state was lost.

Decision — A cell cancelled before dispatch is never sent to the kernel and
preserves existing state. Cancelling an active cell or reaching its deadline
restarts the kernel and clears its state.

## Parallel subagents

`task` is a read-risk tool, so several `task` calls in one model response run concurrently (each a child session with its own context). All concurrent tool batches are bounded by `config.maxParallelTools` (default 6) and are logged in call order. The agent-mode prompt tells the model to fan out this way.

## Deliverables

`deliverables(session)` lists files the session created or changed in its workspace (from checkpoint snapshots: `before === null` → new), plus files in `screenshots/` and `figures/`, newest first. Desktop: "▤ Files" chip → panel with new/changed tags, sizes, and click-to-open. Gateway method `deliverables`.

## Prompt-injection guard (taint)

- **Untrusted sources:** `web_fetch`, `web_search`, `browser_*`, any tool with `untrusted: true`, and `taint.untrusted` globs (e.g. `"mail__*"` for an email MCP server).
- **Wrapping:** their output is wrapped as `<untrusted source="tool">…</untrusted>` (nested tags are neutralized) after truncation. The system prompt explains that such blocks are data, never instructions.
- **Scanning:** patterns for overriding instructions, "new instructions:", role hijacking, fake chat markup, exfiltration requests, hidden commands, tool coercion, and invisible characters (Unicode tag block, bidi overrides, zero-width runs). Findings prefix the result with a warning.
- **Logging:** `context/taint {tool, findings}` is logged the first time external content enters a session and whenever findings occur.
- **Policy:** once tainted, sandboxed shell commands are no longer auto-approved. Once findings exist, every `exec` and `network` tool call needs a human decision in every approval mode, including `full-auto` (headless runs deny with a reason).

*Decision:* detection is heuristic and will miss attacks; the guarantee comes from the policy (no unattended side effects after suspicious content) plus the shell sandbox, not from the classifier.
