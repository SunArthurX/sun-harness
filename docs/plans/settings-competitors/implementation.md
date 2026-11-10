# Implementation design

All signatures below are proposed contracts, not existing exports. Keep the public names stable once T02 fixtures lock them. Changes require a spec Decision note, migration and updated fixtures in the same change.

## Settings information architecture

Use a searchable left navigation with Personal, Integrations and Coding groups; the right pane shows the selected section, scope, current values, effective state, validation errors and Save/Cancel. Search uses translated labels and aliases and returns section plus matching control, not an empty section. Preserve the old Settings route as a redirect to General. Keep feature pages (Memory, Skills, etc.) working; link from settings rather than maintaining duplicate stores.

Each control must specify a default, persistence owner, application timing and capability requirement. Show unsaved changes, saving, saved, conflict and failed states. Never show Saved until persistence succeeds. Navigation with a dirty form offers discard or stay. A revision conflict offers reload and a displayed diff; it never silently overwrites newer state. Save batches one section's edits. Loading and error states are explicit and translated. Use semantic labels, focus restoration, keyboard navigation, screen reader status and reduced motion. Verify 800px and 1440px widths and both languages.

The visible billing section is titled Usage & costs in sun. Account becomes Providers & credentials; Codex Cloud becomes Remote jobs. Parental controls and Trusted contact are documented deferred entries, not user-facing mock controls. Mini is optional and disabled by default; pets are not required for this initiative.

## C01 — Settings transaction contract

Proposed files: `packages/core/src/settings/{types,schema,store,redact}.ts`.

```ts
type SettingScope = 'user' | 'host';
type SettingsRevision = string; // SHA-256 of exact persisted bytes, or a fixed missing-file sentinel
interface SettingsSnapshot {
  revision: SettingsRevision;
  values: PublicSettings; // explicit DTO, never SunConfig plus deleted fields
  origins: Record<string, { source: 'default' | 'user' | 'environment'; editable: boolean }>;
  capabilities: CapabilityStatus[];
}
interface SettingsPatch {
  expectedRevision: SettingsRevision;
  scope: SettingScope;
  changes: Record<string, unknown>; // allowlisted dotted keys, never arbitrary object paths
}
type SettingsWriteResult =
  | { ok: true; snapshot: SettingsSnapshot; apply: 'immediate' | 'next-turn' | 'restart' }
  | { ok: false; code: 'CONFLICT' | 'INVALID' | 'BUSY' | 'IO_ERROR'; fields?: Record<string, string> };
```

Host operations: `getSettings()`, `updateSettings(patch)`, `listCapabilities()`; all input is validated at the host boundary, including CLI and gateway. No nested object prototype keys, nonfinite numbers or unknown edit keys. Existing unknown stored keys are preserved but not editable through generic JSON input. Passwords, provider apiKey, authorization headers, device tokens and embedded URL credentials never occur in PublicSettings. Provider readiness is `{id, configured, source, lastErrorCode}`. Do not return environment variable values. Migrate old `getConfig/updateConfig` consumers together; an old remote client gets a version mismatch instead of a secret response. Internal trusted provider configuration remains in core.

Writes: acquire exclusive same-directory lock with random owner token/PID/start identity; read and validate current bytes under lock; compare expectedRevision; merge only allowlisted changes; validate complete result; write a same-directory private temp file, flush, rename and flush directory where supported; release only own lock in finally. A lock timeout returns BUSY. Use bounded retry; stale recovery requires demonstrably dead ownership, never age alone. A surviving process cannot have its lock stolen. Test all crash points with injected filesystem operations and real subprocess concurrency. Keep original bytes on validation or IO failure. File permissions default to 0600; preserve restrictive existing permissions. Existing legacy raw keys are preserved on disk until an explicit migration, but never exposed via reads.

Read precedence remains defaults < user config; environment supplies credentials and platform capabilities, not arbitrary UI preference overrides. No new `.sun/config.json` precedence is introduced. Existing project hooks/rules remain their own scoped sources. UI language/theme/shortcuts belong to the client host; model/sandbox/tool behavior belongs to the execution host. When connected remotely, label each scope and do not silently edit local runtime config.

Apply preferences immediately. Snapshot model/tool/sandbox/policy configuration at a turn boundary; permission revocation blocks new effects immediately. Return restart when an adapter cannot reload safely. On startup, invalid config preserves the file and opens recovery diagnostics; never overwrite with defaults. Backup before any explicit schema migration. Downgrade must refuse a newer incompatible schema instead of destroying fields.

## C02 — Capability and native extension contract

```ts
interface CapabilityStatus {
  id: string; // stable namespaced ID
  state: 'available' | 'disabled' | 'unavailable' | 'error';
  reasonCode?: string; // translated by UI
  owner: 'core' | 'extension' | 'native';
  surface: ('desktop' | 'web' | 'cli')[];
  configKeys: string[];
}
```

Descriptors live in core; UI sections consume them. Extensions register descriptors alongside their existing tools. No arbitrary React/HTML from third-party descriptors. Native interfaces are injected into HarnessHost; Electron main owns platform permission calls and OS helper lifecycle. Web endpoints never expose a native helper directly. Native capability checks run both in UI discovery and at invocation, preventing stale enabled UI from bypassing revocation.

Defaults: capture/control off; credential reuse requires confirmation; remote targets unconfigured; browser's existing execution mode preserved until explicitly changed. Unsupported operating systems return unavailable with a reason; no simulated successful action. Enabling an extension does not grant its actions. Plugins and hooks show discovered vs trusted vs enabled vs ready independently.

## C03 — Audit and replay

Settings edits produce a private `settings/audit.jsonl` record containing operation ID, timestamp, scope, changed key names, before/after revision and outcome. Exclude raw values and credentials. Audit failures are surfaced: do not claim audit success if persistence failed. Version events and retain unknown historical event types.

Review requests record prompt text, selected model, rules snapshot, file digests, actual bounded diff, omissions and request ID in the session before calling a provider. The completion references the request ID. A provider failure records failure, not an empty passing report. Existing `review/report` text events still render. Auxiliary model calls added by this initiative must follow the same rule. Do not claim the entire legacy codebase has been audited merely because review is fixed.

Appshots use owned attachment bytes plus SHA-256, MIME, size, capture timestamp, app identifier, window metadata and available text. Capture preview is private transient state. Only the user-confirmed, redacted immutable version enters the log and model request. If replay bytes are missing/corrupt, report a missing attachment; never substitute a newly captured window. Non-vision models receive a logged fallback text description and available text, not hidden image input. Observe existing attachment ignore/path rules.

Deletion intentionally makes deleted sessions unreplayable; that user action is explicit. Retention must not silently delete live session inputs. Shared attachments are reference-counted/manifest-referenced before cleanup.

## C04 — Everyday preferences

General: reuse defaultModel, fallbackModels, mode and ui.language; validate referenced provider/model exists. Theme defaults system, text scale 1.0 (range 0.8–1.5), reduced motion system. Notifications default to current behavior; configure completion/pause/failure/approval separately. Quiet hours use IANA timezone and start/end local clock; wrap midnight; test DST. Approval remains visible in app when notification is muted. Dedupe by session+event sequence and do not replay old desktop alerts on restart.

Profile edits reuse USER.md and its cap. Personal instructions and extracted memory have separate editors and provenance. Disabling memory stops new recall/extraction at the next turn; deletion is separate. Voice uses existing configured provider; recording is explicit, shows active state and stops on cancellation; permission denial offers text input. No always-on microphone.

Shortcut registry includes ID, default per platform, scope, label and handler. Validate collisions and reserved keys before registration, preserve old binding if OS registration fails, support reset. Global Appshot shortcut is registered only when enabled. Mini displays current status/open-chat/stop; it shares host events and never creates its own agent loop. Usage reuses pricing calculation, reports unpriced models and labels all local totals as estimates; provider links use verified configured URLs, not inferred account invoices.

## C05 — Import, storage and data

Keep legacy JSONL import. Add versioned bundle with manifest, event log and relative attachments. Set conservative defaults: 100 MiB total, 10,000 entries, 20 MiB per attachment; reject before extraction if limits/path rules fail. Validate decompressed size as it streams; reject absolute paths, `..`, duplicate normalized paths, symlinks and unknown executable payloads. Never activate imported hooks/plugins or launch imported jobs. Stage in a private temp directory, validate references/digests, assign a new session ID, atomically install; failures clean staging without affecting existing sessions. Imported workspace must be explicitly chosen when the original is absent.

Storage inventory reports sessions, attachments, caches, jobs, browser profiles and worktrees separately. Never scan arbitrary user directories. Cleanup is preview → confirm exact inventory revision → revalidate active references → move eligible owned data to trash → purge after configured grace period (default 7 days). A durable operation record allows restart reconciliation. Active sessions/jobs/worktrees are ineligible. Automatic retention defaults off; browser-profile deletion additionally signs out and requires explicit scope confirmation. Data controls describe local deletion separately from third-party retention. Export defaults redact credentials and untrusted HTML is inert.

## C06 — Hook/plugin governance

Maintain the current four hook events. Each entry gains stable ID, enabled state and trust digest over canonical command/matcher/event/source. Existing hooks are discovered as untrusted after migration; explain why and provide bulk review, never silently run them once. Trust records are user-local, never committed in project config. Editing source invalidates trust. Invalid files, invalid regex, overlong matcher (>256 characters), excessive output (>64 KiB combined) or timeout are visible failures. Validate regex conservatively; dangerous patterns are rejected before evaluation.

Hook testing uses a selected fixture, declared cwd, scrubbed environment and the existing execution sandbox/policy seam. A dry-run validates and previews only; actual execution requires the normal explicit trust/approval. Terminate process groups on timeout/cancel and collect bounded output. Preserve `onFailure` semantics from spec 008; policy-critical hooks fail closed. Untrusted project hooks cannot write trust records through their own execution. Plugin manifests show requested actions; disable removes future dispatch immediately, then drains or cancels in-flight work with recorded status. Do not build an online marketplace in this slice.

## C07 — Connections and execution targets

Reuse remote.ts certificate pinning and device tokens. Connect flow: endpoint → certificate identity preview → explicit trust → authentication → capability handshake → selected host label. Never silently accept a changed pin. Tokens stay in protected host storage, not renderer localStorage. Revocation closes or invalidates active sessions and pending approvals for that device. Pending approval IDs remain host scoped. Add client request IDs and server deduplication for send/create/job-start; retries return the prior result. A disconnected client shows stale state and disables mutations until refreshed.

T14 introduces `ExecutionTarget {id, kind: local|remote-gateway|container, capabilities, health}` and durable remote job mapping. Local Docker is not cloud. Start with existing remote gateways, plus a mock adapter for contract testing. External hosted-provider adapters require separate credentials, cost limits and a spec; this plan neither purchases infrastructure nor depends on OpenAI private APIs. Jobs transition queued → running → waiting-user|paused|succeeded|failed|cancelled; unknown remote status becomes reconciling, never an automatic new submission. Cancellation has requested/acknowledged states.

## C08 — Review, Git and worktrees

Review configuration: model reference (default session model), severity threshold for display, rule sources, diff budget and optional completion gate (default off for compatibility). Findings are `{id, severity, path, startLine, endLine, title, explanation, evidence}` plus reviewed digest and omission list. Validate schema, path inside reviewed diff and lines; malformed output produces retryable failure. Findings are advisory, never automatic edits. A changed digest marks findings stale. An empty diff returns no changes without model call. Truncation means incomplete review, never a clean pass. Local review does not post to a remote PR.

Git uses argv-based subprocess calls, repository identity and explicit base selection. No shell interpolation of branch/user input. Worktrees retain session ownership and closed-state checks. Before merge/discard/cleanup, recheck active runs, dirty files, untracked files and repo identity. Default cleanup is manual preview; never force-delete dirty/unowned trees. Branch naming collision retries are bounded. Setup scripts use hook trust and run once per worktree with a durable marker; restart after ambiguous execution requests reconciliation. Do not enable automatic push/force-push.

## C09 — Browser and native control

Browser permissions: normalize scheme+host+port, distinguish browse/upload/download; deny overrides grant; default ask for new origin/action. Recheck on redirects and dispatch. Profiles have explicit owner/location; reuse valid existing browser configuration without importing another browser's cookies. Downloads are staged under an owned directory with limits and path validation; uploads require an explicit approved file handle. Tabs carry session ownership and generation IDs. Takeover revokes agent write lease; resume is explicit and requires a fresh snapshot.

Computer adapter: `probe`, `snapshot`, `act`, `takeover`, `stop`, with cancellable calls, app identity and a short-lived exclusive lease. Native OS permission + per-app grant + policy decision are all required. Lease binds session, app and observed snapshot generation. Stale snapshot, foreground switch, disconnect or revoked permission prevents action. Stop is available independent of model progress and is tested with a blocked adapter. First production adapter targets macOS; Windows/Linux stay unavailable until their adapters pass the same conformance fixtures. Native helper packaging/signing and OS permission prompts need a manual test with the packaged app.

### T12 execution and verification contract

Keep app grants on the local execution host. A desktop user must opt in,
review the exact application identity, and give a session ownership.
The presence of an adapter, a granted OS permission, and an active lease
are independent states. Discovery reports each applicable missing
condition without observing window content. A browser or gateway client
has no native observation or action route. The desktop connection switch
and window teardown revoke ownership before completing the transition.

An active lease is local to the desktop process. Bind it to the session,
the running application instance, the window identity, and an opaque
snapshot generation. A granted application can still lose foreground
or change its focused window. Check the current binding before querying
content, after asynchronous observation, and again in the helper before
dispatch. A change invalidates the generation. Keep window titles and
content out of discovery, errors, and permission diagnostics. Return any
model-visible observation through the ordinary untrusted tool result and
session log. Never read secure accessibility values or inspect the T13
private sign-in window. Its privacy guard applies both before dispatch
and while an operation is in flight.

Route model actions through the existing tool policy. An approval can
arrive after the user takes over, another app gains focus, or an app
grant changes. Treat it as a decision for the original request. Check
the lease, observation, and grant again before dispatch. Bind each
action to one snapshot generation and consume that generation at
dispatch. Before sending the action to the helper, persist its identity
and dispatch intent. A confirmed outcome can be recorded after the
helper returns. If a helper or desktop process stops before confirmation,
report an uncertain outcome. The normal agent loop replays unresolved
tool calls, so a restarted host must refuse the old operation even when
its assistant request or approval is still in the session log. A fresh
observation and explicit ownership are required for subsequent actions.

Emergency Stop and takeover invalidate the lease and current generation
before aborting any native wait. They must operate while the helper is
blocked and without waiting for the model or the normal tool queue.
Handback requires a new observation and never restores the old lease.
Stopping an already-dispatched action cannot undo its effect. Keep the
receipt unresolved until its outcome can be established.

Acceptance fixtures must count actual action dispatches, including zero
after denied permission, revoked grants, mismatched applications,
stale snapshots, or user takeover. Hold one adapter call pending to
verify independent stop, then let it resolve and assert the stale
result cannot re-enable control. Restart with an action dispatch record
and no outcome to verify zero redispatches. The packaged macOS fixture
must exercise real observation and an action on an isolated synthetic
app, show that a second session cannot act, and exercise the private
window deny path. A helper that only builds, starts, or reports missing
OS permission provides partial evidence.

Appshots require Screen Recording and optionally Accessibility where supported. Prefer screenshot-only when text permission is unavailable; label that limitation. Preview allows cancel, crop/redact and text removal; do not automatically send. Initial capture limit: 10 MiB image and 20,000 text characters with visible truncation. Capturing a different frontmost window between intent and capture must display the actual target before confirmation. No continuous capture.

## C10 — Credential broker

Separate provider credentials from optional website credentials. Prefer existing environment variables for API credentials. The macOS adapter seals passwords with a Keychain-backed key and exposes metadata, create, replace, delete, and authorized fill. The reference, revision, account label, exact HTTPS origin, and top-level document bind each fill. The user submits the form in a private browser partition. This partition has no model observations, screenshots, or gateway view, including after sign-in. Logs record only the action, outcome, and reference ID. Manual browser takeover remains available for other login flows. The detailed contract lives in spec 032.

## Rollout and rollback

Each task ships behind capabilities until end-to-end acceptance passes. New schema fields are additive; store one pre-migration backup, report its location without exposing contents. Disabling a feature stops new actions but preserves logs and attachments. Rollback never rewrites history or deletes newly created worktrees. Keep old settings navigation reachable until T04 parity passes, then remove only its duplicate UI. Never maintain two independent persistence paths. No release version is assigned until slice acceptance; do not mark existing 0.11 implementation as newly delivered.
