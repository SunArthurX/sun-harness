# Bounded implementation tasks

All tasks start `planned`. Dependencies must be done before implementation starts. Each task uses specification 032 plus the relevant existing spec. Subdivide large tasks with stable child IDs and explicit dependencies before coding; do not silently widen file scope.

## T01 — Freeze behavioral fixtures

- Dependencies: none.
- Acceptance: AC-16.
- Read/edit anchors: packages/core/test/helpers.ts; packages/core/test/settings-contract.test.ts (new).
- Implementation: Create legacy/minimal/invalid/secret-bearing config fixtures, synthetic session/attachment fixtures and a fake native adapter. Capture baseline commands and dirty file inventory without committing user content.
- Behavioral verification: Fixtures run under temporary SUN_HOME; no real credentials, user home writes or external network. Confirm each negative fixture fails its intended assertion.
- Scope limit: Fixtures and baseline only; do not alter runtime behavior.
- Evidence record: `docs/plans/settings-competitors/evidence/T01.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T02 — Revisioned settings service

- Dependencies: T01.
- Acceptance: AC-01, AC-02, AC-03.
- Read/edit anchors: packages/core/src/config.ts; packages/core/src/settings/ (new); packages/core/src/host.ts; packages/core/src/gateway.ts; apps/desktop/src/shared/api.ts; apps/desktop/src/renderer/src/api.ts; packages/cli/src/index.ts.
- Implementation: Implement C01 transactions and DTOs; migrate all existing settings callers and compatibility routes in one vertical slice. Add schema migration and audit records.
- Behavioral verification: Concurrent subprocess writes yield exactly one success; injected write/rename failures preserve valid bytes; getConfig compatibility never leaks sentinel secrets; unknown stored keys survive.
- Scope limit: No new settings page or project-config precedence.
- Evidence record: `docs/plans/settings-competitors/evidence/T02.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T03 — Capability descriptors and transport parity

- Dependencies: T02.
- Acceptance: AC-03, AC-04.
- Read/edit anchors: packages/core/src/settings/capabilities.ts (new); packages/core/src/plugins.ts; packages/core/src/host.ts; packages/core/src/gateway.ts; apps/desktop/src/main/index.ts; apps/desktop/src/shared/api.ts.
- Implementation: Implement C02 descriptors and adapter injection. Add native-unavailable stubs that explicitly return unsupported errors; negotiate host/client protocol version.
- Behavioral verification: Same descriptor IDs and settings shape through local host, IPC contract and gateway; web cannot invoke native methods; unknown method denied; disable revokes next dispatch.
- Scope limit: No actual native automation and no replacement tool registry.
- Evidence record: `docs/plans/settings-competitors/evidence/T03.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T04 — Searchable bilingual settings shell

- Dependencies: T03.
- Acceptance: AC-04, AC-16.
- Read/edit anchors: apps/desktop/src/renderer/src/settings/ (new); apps/desktop/src/renderer/src/pages.tsx; apps/desktop/src/renderer/src/App.tsx; apps/desktop/src/renderer/src/styles.css; apps/desktop/src/renderer/src/locale-zh-CN.ts; apps/desktop/e2e/smoke.mjs.
- Implementation: Build navigation, search, section registry, deep routes and shared section form state. Migrate existing controls without changing their defaults.
- Behavioral verification: English and Chinese search find the same stable IDs; keyboard focus works; failed save does not show Saved; conflict does not lose draft; desktop and web at two viewport widths.
- Scope limit: No empty feature panels advertised as implemented.
- Evidence record: `docs/plans/settings-competitors/evidence/T04.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T05 — Preferences and personal controls

- Dependencies: T04.
- Acceptance: AC-05.
- Read/edit anchors: packages/core/src/config.ts; packages/core/src/assistant/voice.ts; packages/core/src/assistant/memstore.ts; apps/desktop/src/main/index.ts; apps/desktop/src/renderer/src/settings/; apps/desktop/src/renderer/src/locale-zh-CN.ts.
- Implementation: Implement C04 controls; reuse profile/memory/voice/cost APIs. Add shortcut registry and optional Mini status overlay. Split into T05a preference persistence, T05b adapters, T05c UI if one change becomes large.
- Behavioral verification: Restart persistence; quiet hours crossing midnight/DST; no duplicate notifications; denied mic; failed shortcut registration keeps prior shortcut; unknown model price not zero; Mini stop aborts real host run.
- Scope limit: No public account, always-on audio, animated pet creation or billing backend.
- T05a: persist and validate preferences, default mode, memory and voice switches, quiet-hour calculations, and shortcut collisions. Record the partial evidence before wiring UI and native adapters.
- T05b: apply appearance, notification delivery and deduplication, voice cancellation, and shortcut registration. Verify rejection preserves the existing registration.
- T05c: expose the preference sections, profile, Mini, and usage estimates. Run the cross-surface AC-05 acceptance before marking T05 done.
- Evidence record: `docs/plans/settings-competitors/evidence/T05.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T06 — Import, archives, storage and privacy

- Dependencies: T04.
- Acceptance: AC-06.
- Read/edit anchors: packages/core/src/host.ts; packages/core/src/ux/export.ts; packages/core/src/settings/storage.ts (new); packages/core/src/settings/import.ts (new); apps/desktop/src/renderer/src/settings/.
- Implementation: Implement C05 staged bundle import, archival controls, storage inventory and preview/revalidate/trash workflow.
- Behavioral verification: Traversal, symlink, oversized/decompression and duplicate-path fixtures rejected; imported automation remains inert; active/shared attachments excluded; crash resumes trash operation without deleting new files; restore archive preserves ID.
- Scope limit: No unbounded home scan or third-party data deletion claim.
- T06a: make transcript exports inert and redact known credentials by default. Preserve the existing JSONL format and verify exported records remain parseable.
- T06b: implement bounded bundle validation and installation with a new session ID, verified owned attachments, and inert history. Keep the legacy JSONL entry point.
- T06c: expose import and archive controls, inventory and revalidated trash operations. Verify interrupted cleanup and the complete AC-06 path across the affected surfaces.
- Evidence record: `docs/plans/settings-competitors/evidence/T06.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T07 — Hooks and extension governance

- Dependencies: T03, T04.
- Acceptance: AC-07.
- Read/edit anchors: packages/core/src/hooks.ts; packages/core/src/plugins.ts; packages/core/src/plugin-runtime.ts; packages/core/src/host.ts; packages/core/src/sandbox.ts; apps/desktop/src/renderer/src/settings/; packages/core/test/settings-hooks.test.ts; packages/core/test/settings-capabilities.test.ts.
- Implementation: Implement C06 validation, local trust digest, diagnostics and fixture runner; use current registry and sandbox seam.
- Behavioral verification: Changed command invalidates trust; malformed regex/config visible; timeout/cancel kills child descendants; scrub secret sentinel from environment; dry-run executes nothing; hook output replay matches provider input.
- Plugin verification: Static inspection imports no code and exposes only supported declarations. Disable during execution or activation, reject a stale approval, preserve other plugins, observe draining then disabled, and retain the decision after restart.
- Scope limit: Do not add undocumented Codex hook event names or an online marketplace.
- T07a: validate source and matcher inputs, implement durable digest review, and gate normal hook dispatch.
- T07b: reuse sandbox and approval boundaries for fixture execution, scrub credentials, bound output, and terminate process trees on timeout or cancel.
- T07c: expose bilingual review and fixture controls, plugin manifest and disable/drain state, and collect AC-07 acceptance evidence.
- Evidence record: `docs/plans/settings-competitors/evidence/T07.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T08 — Remote connection management

- Dependencies: T03, T04.
- Acceptance: AC-08.
- Read/edit anchors: packages/core/src/remote.ts; packages/core/src/gateway.ts; packages/core/src/host.ts; apps/desktop/src/main/index.ts; apps/desktop/src/renderer/src/settings/; packages/core/test/remote.test.ts.
- Implementation: Implement C07 connection lifecycle, host identity, protocol handshake, protected credentials and request deduplication.
- Behavioral verification: Pinned certificate mismatch denied; revoked token cannot reuse existing connection; reconnect same request ID yields one send; stale approval from another host fails; local preferences remain local.
- Scope limit: No public relay, mobile app or cloud provisioning.
- T08a: establish the handshake and stable host identity, atomic device writes, active stream revocation, and host-scoped approval responses.
- T08b: bind retry receipts to the authenticated principal and gateway instance. Cover session create, message send, and automation start.
- T08c: exchange the browser bootstrap token for an HttpOnly session and remove renderer token persistence.
- T08d: connect from desktop through certificate preview and confirmation. Keep desktop preferences local and gate host mutations across desktop and web during a disconnected or stale connection.
- Evidence record: `docs/plans/settings-competitors/evidence/T08.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T09 — Review and Git/worktree controls

- Dependencies: T04, T07.
- Acceptance: AC-09, AC-10.
- Read/edit anchors: packages/core/src/host.ts; packages/core/src/types.ts; packages/core/src/messages.ts; packages/core/src/worktree.ts; apps/desktop/src/renderer/src/Changes.tsx; apps/desktop/src/renderer/src/settings/; packages/core/test/cursor-coding.test.ts; packages/core/test/worktree.test.ts.
- Implementation: Implement C08. First log review requests, then validate findings and stale digests, then add worktree inventory and guarded actions. Update spec 029 and 010 together.
- Behavioral verification: Mock captures exact logged provider input; stale digest marks report stale; invalid path/line rejected; omission cannot pass gate; dirty/untracked/active worktree cannot be auto-cleaned; merge conflict preserves branches.
- T09a: persist and validate structured reviews, expose settings and report states, and enforce the optional completion gate.
- T09b: inspect the recorded worktree base without staging changes. Feed tracked, committed, and untracked candidates into the same review validation.
- T09c: add explicit base selection and bounded name collision recovery. Verify repository and session ownership before lifecycle actions. Reject active work and preserve dirty or untracked files. Bind cleanup confirmation to a revalidated inventory. Run reviewed setup once with a durable start and outcome marker.
- Scope limit: No PR posting, autofix, push or force-delete.
- Evidence record: `docs/plans/settings-competitors/evidence/T09.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T10 — Browser settings and ownership

- Dependencies: T03, T04.
- Acceptance: AC-11.
- Read/edit anchors: packages/core/src/browser/browser.ts; packages/core/src/browser/tools.ts; packages/core/src/browser/cdp.ts; apps/desktop/src/renderer/src/Browser.tsx; apps/desktop/src/renderer/src/settings/; packages/core/test/browser.test.ts.
- Implementation: Implement C09 browser origins/action grants, ownership/generations, bounded transfer and takeover. Update spec 022.
- Behavioral verification: Redirect to new origin rechecks grant; upload needs approved handle; download cannot escape directory; takeover invalidates write lease; stale ref cannot target replacement tab; two sessions cannot control same tab.
- Scope limit: No automatic cookie import or full desktop control.
- Evidence record: `docs/plans/settings-competitors/evidence/T10.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T11 — Explicit Appshot capture

- Dependencies: T03, T04, T06.
- Acceptance: AC-12.
- Read/edit anchors: packages/core/src/settings/capture.ts (new interface); apps/desktop/src/main/capture.ts (new adapter); apps/desktop/src/renderer/src/Composer.tsx; packages/core/src/host.ts; packages/core/src/messages.ts; packages/core/src/types.ts.
- Implementation: Implement C03/C09 capture lifecycle with fake adapter first, then macOS capture capability spike and packaged-app check. Add preview/redaction and owned attachments.
- Behavioral verification: Cancel sends nothing; denied permission explains recovery; actual target shown if foreground changed; redaction excludes original bytes from log; restart replay hash stable; missing attachment explicit; web unavailable.
- Scope limit: No continuous capture or screenshot of all displays by default.
- Evidence record: `docs/plans/settings-competitors/evidence/T11.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T12 — Native computer-control adapter

- Dependencies: T07, T10, T11.
- Acceptance: AC-13.
- Read/edit anchors: packages/core/src/settings/computer.ts (new interface); packages/core/src/tools/services.ts; apps/desktop/src/main/computer.ts (new adapter); apps/desktop/src/renderer/src/settings/; apps/desktop/package.json.
- Implementation: Implement C09 native control through injected extension adapter. Spike native helper build/signing first; record supported OS/version and packaging approach before exposing UI.
- Native toolchain checkpoint: run `node apps/desktop/e2e/computer-native-probe.mjs` with an existing signed bundle. See [the probe results](evidence/T12-native-spike.md). Positive native action acceptance remains separate.
- Behavioral verification: Fake and real adapter conformance: stale snapshot, permission revocation, lease contention, app switch and emergency stop; blocked action must cancel; restart never repeats click; the T13 private sign-in window denies native observation and actions if T13 has shipped; packaged macOS manual evidence.
- Scope limit: Do not pretend CDP is native desktop control. Stop task with evidence if native helper cannot meet contract.
- Evidence record: `docs/plans/settings-competitors/evidence/T12.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T13 — Private credential broker

- Dependencies: T08, T10.
- Acceptance: AC-14.
- Read/edit anchors: packages/core/src/settings/credentials.ts (new interface); apps/desktop/src/main/credentials.ts (new adapter); packages/core/src/gateway.ts; apps/desktop/src/renderer/src/settings/.
- Implementation: Implement C10 secure metadata/reference API and origin-bound private use. Verify secure storage adapter first; keep manual takeover fallback.
- Behavioral verification: Sentinel secret absent from every response/log/export/error/snapshot; origin mismatch, expired/revoked grant denied; unavailable vault never writes plaintext; deletion removes future use.
- Real adapter fixture: run `node apps/desktop/e2e/credentials.mjs` after building. Pass a signed app bundle path as the optional argument to exercise packaged Keychain persistence and the same isolated HTTPS fixture.
- Scope limit: No tool/RPC returning raw password; no custom encryption fallback.
- Evidence record: `docs/plans/settings-competitors/evidence/T13.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T14 — Bring-your-own execution targets

- Dependencies: T08, T09.
- Acceptance: AC-15.
- Read/edit anchors: packages/core/src/jobs.ts; packages/core/src/remote.ts; packages/core/src/host.ts; packages/core/src/settings/targets.ts (new); apps/desktop/src/renderer/src/settings/; packages/core/test/jobs.test.ts.
- Implementation: Implement C07 target descriptors and durable job mapping using existing gateway first. Label local Docker and remote host accurately.
- Behavioral verification: Simulate remote start acknowledgement loss: reconcile same operation ID, never start twice; cancellation ack persisted; host offline visible; artifacts stay tied to target; no hosted account dependency.
- Scope limit: No paid provisioning or proprietary Codex Cloud API assumptions.
- Evidence record: `docs/plans/settings-competitors/evidence/T14.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.

## T15 — Release and handoff qualification

- Dependencies: T05, T06, T07, T08, T09, T10, T11, T12, T13, T14.
- Acceptance: AC-16.
- Read/edit anchors: packages/core/test/; apps/desktop/test/; apps/desktop/e2e/smoke.mjs; docs/manual/; docs/teach/; docs/plan.md; CHANGELOG.md.
- Implementation: Run final cross-surface acceptance, security/replay fixtures and isolated fresh-agent implementation trials; collect evidence and mark only verified scope complete.
- Behavioral verification: pnpm test/build/typecheck pass; bilingual desktop/web manual matrix; no secret sentinel; all task reports include commands and outcomes; lower-capability model trial meets gate or reported limitation remains open.
- Offline qualification preflight: run `node scripts/settings-qualification.mjs --validate`. This checks fixture and judge integrity before live model repetitions.
- Cross-surface preflight and unresolved gates: see [the release preflight](evidence/T15-preflight.md).
- Scope limit: No green status from structural plan checks alone.
- Evidence record: `docs/plans/settings-competitors/evidence/T15.json`.
- Exit: focused failure fixtures + `pnpm test` + `pnpm build`; relevant manual, teaching page/index, spec, roadmap and changelog updated. Record rollback and any skipped platform tests. Do not mark done with unresolved acceptance failures.
