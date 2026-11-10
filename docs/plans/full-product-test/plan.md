# Full product verification plan

Opened 2026-11-09. Scope is the current sun-harness worktree, including
all numbered specs, documented public commands and screens, and the completed
Settings and competitor adoption pack. The worktree has substantial existing
changes. Preserve them and use temporary workspaces and data directories for
all test activity.

## Execution order

1. Inventory specs, CLI commands, desktop and web surfaces, adapters, and
   shipped integrations. Preserve a worktree snapshot for evidence. Map each
   behavior to an existing assertion, a new focused regression, or a real
   manual or end-to-end check. Document deferred product scope separately.
2. Run the untouched baseline: `pnpm test`, `pnpm build`, `pnpm typecheck`,
   plan integrity, and offline eval validation. Capture the command, exit
   status, test count, skipped cases, and full output. Retain initial failures.
3. Run independent integration slices for the CLI, local and remote gateway,
   renderer and packaged desktop. Cover both configured languages. Run the
   shipped browser, Docker, credential, Appshot, and Computer Use fixtures on
   their supported platform. Record the actual platform and build tested.
4. Audit the feature inventory against individual test names and assertions.
   For gaps, exercise public entry points with small deterministic fixtures.
   Include success, rejection, cancellation, stale/concurrent state, restart
   and legacy data where the behavior defines those paths. Label the level of
   evidence separately for each feature.
5. For every reproducible defect, save its failing case and expected contract.
   Trace the root cause, make the smallest fix, update the relevant spec for
   a behavior change, and rerun the failing case, adjacent checks, and the
   full baseline. Track fixture/environment problems separately from product
   defects. Preserve test expectations when fixing failures.
6. Publish an English report with a per-feature evidence ledger, exact
   commands and results, defect status and regression evidence, exclusions,
   and residual limitations. Audit the report against this plan, the specs,
   and current test output before closing the goal.

## Coverage matrix

Each row contains multiple independent behaviors. A row can close only when
every shipped behavior in its checklist has an assertion or an explicitly
recorded environment limitation. A prior release check is context. The
report records which evidence was reproduced in this audit.

| ID | Specs | Shipped behavior to verify | Required evidence |
| --- | --- | --- | --- |
| V01 | 000, 001, 007 | Create, list, send, stream, stop, switch mode and model, recover quota/auth/network, fail over, replay log, reopen after process restart | Scripted runtime and CLI process; Electron and gateway chat flow |
| V02 | 001, 009, 026 | Durable model-visible context, budgets and model-aware compaction, context report, steering, titles, model/cache/cost estimates, pins and archive | Transcript assertions, small-context fixture, renderer/CLI lifecycle |
| V03 | 002, 032 | AGENTS/CLAUDE/project/compatibility rules and precedence, specs context, skills and commands, MCP stdio/HTTP/SSE and reconnect, plugin loading and drain, reviewed hooks with preview/cancel/fail-closed | Offline rules and fake transports; gateway/CLI/renderer parity, real local hook sandbox |
| V04 | 003, 013, 024, 030 | Local Markdown KB indexing, CJK lexical search, embeddings and rank fusion, company-provider boundary, layered memory CRUD/recall/extraction, profile/daily notes | Temporary data with mock embeddings/model and connector fixture; UI/CLI operation checks |
| V05 | 004, 025, 026, 027, 028, 031 | Electron and web screen navigation, active chat/plan/tool cards, EN/zh-CN, palette/shortcuts, usage and search, recent/pinned sessions, changes/terminal/browser/files dock, responsive layout | Desktop/gateway renderer assertions and a layout review on supported screens |
| V06 | 005, 006, 024 | Intel release collection, cache/dedup, model summary, schedule definition, reflection, evolution proposal accept/reject and replay | Synthetic feeds, mock model, isolated proposal storage and service metadata |
| V07 | 008, 016, 021 | Human approvals, noninteractive fail-closed, early input/click, duplicate/stale replies, plan read-only, allowed sandbox backends, network and secret isolation | Runtime tests, CLI TTY or noninteractive process, renderer approval; real available sandbox backends |
| V08 | 010, 020, 027, 029, 031, 032 | Worktree branch/base/setup, status and diff, merge and conflict recovery, cleanup/reconcile, read-only inspection, protected dirty worktrees | Disposable Git histories; CLI/renderer flows and restart or stale state |
| V09 | 011, 015, 032 | Background shell/MCP start, progress, reattach after restart, result ordering, cancellation, orphan/lost reply recovery | Real harmless process and mock MCP; durable receipt assertions |
| V10 | 012, 017, 032 | Local gateway ownership, HTTP/RPC allowlist, CLI/desktop attach, token exchange, TLS identity/pin, device revoke, reconnect/resync and paused mutations | Loopback gateway and clients, fresh temporary tokens, stale and revoked paths |
| V11 | 014 | Core, CLI bundle and desktop builds; macOS packaged app launches with compiled resources, correct native helper and environment behavior | Typecheck and package validation; signature/resource checks and packaged process |
| V12 | 018, 025 | Bot bridge sessions, streamed replies, approvals/allowlists and command dispatch; Telegram, DingTalk, Feishu, WeChat, WeCom, generic webhook adapters | Local HTTP fixtures for ingress and outbound contracts; no third-party chat recipients |
| V13 | 019, 020 | Eval validate/run/results/compare, hidden judge, reference/untouched cases, telemetry, best-of-N | Offline eval judge and isolated scripted model runs; live model evidence where applicable |
| V14 | 020, 029, 032 | Tolerant edits and atomic patch/undo, repo map, ignore patterns, scoped rules, local search, LSP, verification gate, structured review and staleness | Real temporary repositories with focused model, Git and language server fixtures |
| V15 | 021, 022, 032 | Browser protocol, local/external/Docker Chromium, persistent profiles, tab/frame identity, snapshots, navigation and inputs, noVNC live view/takeover, grants, file upload/download | Real browser checks, synthetic local pages, denied/stale/concurrent actions |
| V16 | 023, 030 | Search, readable HTML/PDF, Python kernel state, subagents and wide research, slides and deliverables, tainted content blocks writes | Offline HTTP/PDF fixtures, real local interpreter, deterministic worker/provider scripts |
| V17 | 024, 027, 030 | Model routing, briefing and connector protocols, webhook and file triggers, efficiency metrics, voice record/transcribe/read-aloud/cancel, schedule proposals, run/history/pause/catch-up | Scripted provider and controlled clock, local connector fixtures, renderer media stubs and available OS adapter checks |
| V18 | 025, 026, 027 | CLI chat and one-shot status/exit codes, stream JSON, custom and skill slash commands, file/image input, inline diff/revert, forks and checkpoints, search/export/import | Spawn built CLI in isolated state against loopback provider; desktop composer and session checks |
| V19 | 028, 032 AC-01–AC-04 | Settings schema and optimistic writes, migration and malformed-file recovery, allowlisted/versioned capabilities, preferences routing, search, deep links, drafts, personal controls, Mini | Unit concurrency and compatibility; bilingual renderer and persisted restarts |
| V20 | 032 AC-05–AC-10 | Archive/trash/storage retention, safe exports and portable imports, hook/plugin governance, remote connections, review/worktree behavior and permissions | Browser/CLI/desktop contracts, adversarial fixtures, no synthetic secret leaked |
| V21 | 032 AC-11–AC-12 | Browser ownership/grants/transfer constraints and Appshot capture, preview/redact/cancel, attachment replay and disabled/unsupported states | Real supported Chromium and authorized signed macOS capture; exact-byte assertions |
| V22 | 032 AC-13–AC-14 | Computer Use OS and app grants, exclusive lease, approval, stale target and stop, private sign-in, Keychain storage, origin isolation and blocked web surfaces | Real synthetic macOS Accessibility and private browser windows, negative scope and secret checks |
| V23 | 032 AC-15 | Current host, Local Docker and pinned remote execution, target identity, durable jobs, cancellation and restart recovery | Real harmless local/Docker commands and a pinned loopback gateway |
| V24 | 032 AC-16 | Screenshot dispositions, bilingual check, coverage/dependency/evidence checker, fixed offline qualification, live handoff acceptance, manuals and teaching links | Plan checker and negative tests, fixture validator, fresh qualification evidence or a dated prior-run comparison tied to the exact inputs |

Read the numbered specs for exact contracts and distinguish target capability
from shipped behavior. Family-account controls and managed public hosting are
deferred by the Settings manifest. Test that unavailable capabilities do not
claim readiness. On this macOS host, verify Linux-specific branching and
contracts with controlled fixtures, and report any real Linux execution
separately. Treat missing binaries, credentials, or OS permission as explicit
test environment findings. Report live provider outcomes separately from
deterministic protocol coverage. Keep credentials, real user data, and external
recipients outside test fixtures.

## Evidence conventions

- Store outputs and the final report under this plan directory. Record exact
  commands, working directory, exits, and whether a test was skipped. Logs
  may use synthetic identifiers. Redact credential values and personal paths
  unrelated to reproducing a result.
- Keep failures distinct from fixes. A single green suite provides evidence
  only for the assertions it actually ran. Label documented-only, mocked,
  real local, and live vendor coverage separately.
- Finish with the milestone requirements in `AGENTS.md`, the latest full
  `pnpm test`, `pnpm build`, and `pnpm typecheck`, and an explicit disposition
  for every shipped behavior in the ledger.
