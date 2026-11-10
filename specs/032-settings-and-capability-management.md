# 032 — Settings and capability management

Status: in progress. T01 through T04 are complete. The task manifest tracks remaining acceptance.
Decision: adapt the screenshot's useful controls to a local-first, provider-independent harness. Do not implement hosted account/family services or pretend to provide Codex subscription infrastructure. Detailed design: `docs/plans/settings-competitors/`.

## Scope and authority

This spec refines 002, 008, 010, 017, 022, 025, 026, 028 and 029. Existing contracts continue until the relevant task explicitly migrates them. Its acceptance IDs are stable. Screenshot coverage S01–S29 is recorded in `research.md` and `manifest.json`. Deferred entries have reasons and no enabled controls.

## Invariants

- INV-01: renderer accesses runtime state through HarnessHost contracts; core imports neither Electron nor React.
- INV-02: every model-visible input, including review requests and Appshot material, is durable before dispatch and reconstructable from session events and owned attachments.
- INV-03: side effects remain policy mediated. A settings toggle is not an approval bypass.
- INV-04: capabilities are explicitly available, disabled, unavailable, or error; no successful no-op stub.
- INV-05: English and Simplified Chinese copy and accessibility labels ship together.
- INV-06: no raw credential in settings responses, logs, exports, screenshots used for diagnostics or model context.
- INV-07: restart, cancellation and disconnect never silently repeat a side effect.
- INV-08: preserve pre-existing user files, dirty worktrees, legacy sessions and unknown configuration keys.

## Configuration persistence decision

All cooperating writes use the same configuration file lock and an atomic replacement.
The file transaction layer can enforce a revision based on the exact bytes read by the caller.
A stale revision or a failed write before replacement preserves the current file. A process that
dies after replacement leaves the new complete file. A live or unverifiable lock owner is treated
as busy. Configuration saves require a regular destination file to avoid replacing a symlink.

The trusted in-process compatibility helper participates in locking. Product clients use the validated revisioned settings API with a redacted DTO, conflict feedback and a private audit.

## Acceptance requirements

- AC-01: legacy config loads unchanged; missing fields get defaults; unknown existing keys survive unrelated writes; invalid edits return field errors without mutation.
- AC-02: two writers using the same revision cannot both succeed; crash during save leaves an old or new valid file; stale locks recover only after ownership checks.
- AC-03: settings reads return redacted DTOs and effective-value origins; old API routes cannot bypass redaction or validation.
- AC-04: search matches English/Chinese labels and keywords; keyboard navigation, direct section route and Back work; every exposed action is backed by an advertised capability.
- AC-05: preferences survive restart; event notification dedupe, timezone quiet hours, denied microphone permissions, shortcut conflicts and unknown pricing have defined UI states.
- AC-06: malformed/path-traversal imports fail before installation; archives restore; deletion preview excludes active and referenced assets and is revalidated at execution.
- AC-07: changed or untrusted hook content never executes automatically. Invalid regex or config produces a visible error. Timeout kills the process tree, and hook feedback sent to models is logged. Static plugin manifests disclose requested actions. Disabling a plugin revokes new and queued dispatch immediately, reports outstanding work, and records its settlement.
- AC-08: remote certificate mismatch is blocked; revoked device loses access; reconnect cannot duplicate a send; host identity and local-vs-remote preferences are visible.
- AC-09: reviews bind to a specific diff digest and record inputs before the provider call; invalid findings do not become accepted review results; old reports remain readable.
- AC-10: dirty, active or unowned worktrees cannot be auto-deleted; conflicts preserve both branches and report a recoverable state.
- AC-11: browser grants distinguish origins and browse/upload/download; takeover pauses agent writes; stale tab/frame references fail; redirects re-evaluate grants.
- AC-12: Appshot capture is user-triggered, frontmost-window scoped, previewed before sending, immutable after send and replayable after restart; unsupported hosts show an explanation.
- AC-13: native control checks OS permission plus app grant plus runtime policy; exclusive ownership and emergency stop prevent simultaneous control.
- AC-14: credential broker returns only opaque references/status; origin mismatch and revoked grant block use; unavailable secure storage never falls back to plaintext.
- AC-15: remote jobs identify execution target, persist provider job ID and reconcile after restart; local containers are labeled local; no paid target is provisioned automatically.
- AC-16: every completed task has behavioral evidence, docs/manual changes, linked Mermaid teaching page, roadmap and changelog updates; mock tests require no network.

## Release gate

All non-deferred entries must pass their task's acceptance tests before the full initiative is called complete. Smaller slices may ship with explicit release scope. Planned controls remain absent or honestly unavailable. Passing the plan checker is not evidence of product completion. Historical roadmap checkmarks are not proof of new behavior.

T15 completion records the post-release live handoff report alongside
the cross-surface results. The report must contain three first-attempt
passes for each of the three frozen fixture tasks, with a diff and
acceptance log for every repetition. The plan checker binds the report
to the current prompt and fixture hashes and rejects missing, repeated,
unfinished, or failed attempts. The offline reference run and
post-T04 reports cannot satisfy this release gate.

## T02 interface decisions

The settings RPC exposes a versioned allowlist of existing desktop controls and CLI
briefing and connector settings. Legacy RPC names report a protocol mismatch.
Providers and company knowledge endpoints containing embedded credentials, a query
or a fragment are hidden and require a local file edit. Provider readiness reports
the credential source without returning its value. Local desktop, local gateway and
gateway web clients share the existing machine preferences. Separating desktop
preferences from a separately connected execution host is part of T08.

Host changes wait until the current run is idle. Sandbox changes also wait for
active jobs before cached sandboxes are invalidated. Language applies immediately.
Intel schedule changes require reinstalling the separately managed schedule.
Successful writes can report an audit or durability warning after replacement.
A failed audit preparation prevents the write. An interrupted audit operation retains
a preparation record for diagnosis. A reserved settings schema version above the
supported version fails closed. The current additive contract uses the existing
JSON layout, so legacy files need no format rewrite or migration backup.

## T03 capability and protocol decisions

The settings RPC advertises a protocol version in app info. Each settings read,
write, and capability list carries the version the client supports. A missing or
mismatched version fails before the host reads or writes settings. The in-process
host uses the same DTO without a transport negotiation.

Capability IDs are stable across surfaces. State and reason reflect the execution
environment. A manager marked available can accept its existing operations. It
does not imply that a provider or extension has a live connection. Each loaded,
disabled, or broken plugin has its own descriptor from the extension loader.
Failed activation does not publish partial contributions. Reload reads the
current plugin configuration, and queued dispatches reject registrations removed
by a reload. An already started call follows its existing lifecycle.

Native discovery returns explicit reasons for missing adapters and unsupported
surfaces. The Electron main process can inject narrow capture and inspection
adapters. Availability is checked at invocation as well as discovery. The HTTP
gateway has no native invocation routes, including when its host has an injected
adapter. Production capture and native control remain gated on T11 and T12.

## T04 navigation and editing decisions

The settings home resolves to General. Section links use `#settings/<section>`
on both surfaces. A searchable field can add its stable field ID to the link.
Back restores the previous route. Navigation away from a dirty section asks
whether to discard the draft. The language section uses the user scope, while
runtime sections use the host scope. A save sends the changed fields of the
selected section as one revision-checked edit. An unsuccessful save retains the
draft. Reload after a conflict shows the latest value alongside the draft and
requires a new explicit save. Provider endpoints containing private material
remain protected, including in the conflict display.

Only sections with available backing capabilities are registered for navigation
and search. Links to existing feature pages reuse their current workflows.
Search indexes English and Simplified Chinese terms regardless of display
language. The navigation and forms remain usable at 800 and 1440 CSS pixels.

## T05 preference persistence decisions

Existing config files receive additive defaults. New sessions use the configured
built-in default mode when the caller does not specify a mode. Appearance,
startup page, notification preferences, read-aloud, Mini, and shortcut bindings
are user preferences. Memory and speech-to-text settings belong to the host.

Quiet hours use an IANA timezone and an inclusive start with an exclusive end.
An overnight interval wraps across midnight. Equal start and end mean no quiet
interval. Each instant is evaluated in the configured timezone, including both
occurrences of a repeated clock time during a daylight-saving change.

Disabling memory stops new automatic memory injection, recall, and extraction.
Existing records and already logged context remain intact. The explicit user
profile remains available as a separate source. Voice input defaults enabled,
while read-aloud and Mini default off. Shortcut values use canonical accelerator
names, with an empty value representing an unbound action.

## T05b preference adapter decisions

Appearance and startup preferences are applied from the effective settings
snapshot. Explicit deep links take precedence over the startup page. The
renderer refreshes effective preferences after a live settings revision while
dirty forms keep their own revision and draft.

Notifications are emitted from live run-status events. A session snapshot seeds
state without emitting an alert. Session ID and event sequence deduplicate
notifications across repeated delivery. Quiet hours and event filters affect OS
alerts. Pending approvals remain in the app. Permission requests use an explicit
user action.

Voice capture starts on a user gesture. A denied permission result prevents
recording. Cancelling stops tracks and discards buffered audio. If transcription
has started, a request ID cancels in-flight work and the renderer ignores late
results. The legacy transcription call remains available for callers without a
request ID. The explicit read-aloud preference uses the settings store.

In-app shortcut matching resolves Primary per platform. The desktop stages a
new global binding before committing a settings edit and keeps the previous
binding if registration or persistence fails. The web never registers an OS
shortcut.

The legacy read-aloud flag is migrated once when the user has no explicit
replacement. Browser startup does not request a new notification permission.
The user-facing permission control is implemented with the T05c settings
sections. T05b installs the global shortcut adapter. T05c binds it to the Mini
panel's full status and stop workflow.

## T05c personal controls decisions

Personal settings group the existing typed preferences by purpose and reuse the
section save and revision workflow. The profile retains `USER.md` and its
existing character limit. Standing instructions are explicit user-authored
content in `INSTRUCTIONS.md`, capped at 1,375 characters and logged in their own
prompt section. Core facts extracted after this change go to `MEMORY.md`.
Existing `USER.md` text remains the profile because older entries do not record
their authorship. The memory switch controls recall and extraction from the
memory stores without deleting files. Text editors compare the last loaded
content before replacing it.
Permission status can be inspected without asking to use the microphone or
send notifications.

The Electron client owns Mini and exposes its capability on desktop connections,
including those attached to a gateway. CLI and browser discovery return the
same capability ID with an unsupported-surface reason. The panel observes session summaries,
selects the most recently updated active top-level session, and sends Stop to
the existing host abort path. The panel can open that session in the main window,
which applies the normal unsaved-settings guard. Mini does not start runs or
receive their transcripts. A browser cannot access the native controls.

Usage shows the estimate for one selected retained session from its recorded
model token counts and the host's pricing table. Forked or imported history can
appear in its own estimate. The view does not sum across sessions. An unpriced
model has an unknown estimate, and a mix of known and unknown estimates exposes
only the priced subtotal.

## T06a export decisions

HTML transcripts treat every transcript line as data. The renderer emits its
own limited structural elements for headings, code blocks and collapsible tool
calls. Text and quoted attributes are escaped. The document's content security
policy permits its inline stylesheet and blocks external content, scripts and
form submissions. Session logs stay unchanged when exporting.

All transcript formats redact the current configured provider credentials,
credential environment values, and sun device-token literals. Redaction matches
literal text, including in nested string values. Short configured values are
matched at word boundaries to preserve ordinary words. JSONL exports retain
the event format and serialize the readable records. Redaction works on the
exported copy, while the original session remains the source for replay.

## T06b import decisions

A portable `.sunbundle` v1 is a gzip stream. The decompressed stream starts
with `SUNB1\n` and a four-byte unsigned big-endian manifest length. The UTF-8
JSON manifest contains `version: 1` and an ordered `entries` array. Each
entry declares `name`, `size` in bytes, and a lowercase hex `sha256`.
Exactly one `session.jsonl` comes first. The remaining entries are
`attachments/<lowercase-id>.<image-extension>` files. Payload bytes follow
in manifest order. The parser accepts regular image payloads only, compares
their signatures and digests, and rejects trailing data, duplicate paths,
links, and unreferenced payloads. Framing counts toward the 100 MiB inflated
limit. The compressed stream is capped at 101 MiB, the manifest at 2 MiB,
each attachment at 20 MiB, and the manifest at 10,000 entries. A transcript
can contain up to 200,000 events, and the rewritten log has a 100 MiB limit.
The gateway transfers bundles as authenticated binary streams. The CLI uses
the selected execution host for import and export and uses `--cwd` for a
replacement workspace on that host.

Validate before publication. The installer stages files under a private
temporary directory inside the sessions root. It allocates a fresh session
ID and rewrites image references to their installed locations. A single
directory rename publishes the log and attachments together. Flat legacy
logs remain readable. Legacy JSONL import can copy an image from an
existing owned attachment directory on the execution host. A foreign or
unsafe path is rejected with guidance to use a portable bundle.

The original workspace is reused when it exists on the execution host.
Otherwise the user supplies an existing absolute directory before install.
Imported records preserve conversational history and timestamps. Historical
operational events are replaced by inert records at the same sequence.
Historical approval grants, worktrees, jobs and automation proposals cannot
authorize local actions. Incomplete historical tool calls are recorded with
an interruption result. A newly imported session needs a fresh user turn to
run. Rewinding preserves that boundary and remaps compaction pointers after
dropping operational records. Older fork exports with a compaction pointer
beyond its own record use the preceding sequence as the limit. Memory
extraction starts after the imported boundary. The new session uses the receiving host's approval and sandbox settings.

## T06c storage decisions

Storage inventory is limited to the execution host's known managed roots.
Report sessions and their checkpoints, attachments, embedding caches, jobs,
browser profiles, and worktrees separately. Refuse cleanup if a bounded scan
cannot establish a complete inventory. Archive and unarchive continue to
update the same session ID. Cleanup may select inactive archived sessions,
unreferenced attachments, finished jobs, and the rebuildable embedding cache.
Worktrees use their dedicated Git workflow. An attachment referenced by any
retained session remains protected, even when the owner session is archived.
After moving a session log, a new preview can identify its orphaned images.

Browser profiles have a separate explicit confirmation. A profile is eligible
only when the host can establish that its browser is stopped. Moving it
removes the local sign-in data from the active profile. External CDP profiles
are outside the inventory. Cleanup acts on the host's copy of the selected
data. Provider retention is managed separately by the provider.

Preview binds selected resource IDs to the exact inventory revision. Confirm
recomputes ownership, liveness, references, and file identities under a
cooperating-writer lock. An operation journal precedes the first rename and
records the identity and progress of each item. On restart, an already moved
item is recognized at its trash destination. A replacement, changed
reference, or unverifiable source is skipped. Purge validates the trash item and moves it into the operation's private
purging directory before deletion. Recovery can finish that deletion after an
interruption without revisiting the original live path. The default trash grace
period is seven days. Optional age-based retention is off by default and applies
only to old archived sessions and unreferenced attachments.

## T07a hook trust decisions

Shell hook configuration has four existing event names. A hook may declare an
explicit stable ID and an enabled flag. A legacy entry receives an identity
derived from its source, event, and position. Trust binds the identity and
normalized fields to the exact source contents and canonical source path.
Editing the source invalidates its reviewed entries, including after a runner
has been created. An atomic user-local trust store records reviewed digests.
Batch review compares every displayed digest with the current files before
writing any grants. Imported projects and existing unreviewed hooks begin
untrusted.

Configuration diagnostics identify the source and event without returning raw
parse or execution exceptions. Matchers use a bounded conservative regex subset.
An invalid source that could contain a policy hook blocks tool dispatch. An
enabled matching `preToolUse` hook with `onFailure: "block"` also blocks if its
entry is invalid, its trust is missing, or it is removed during an active run.
Other untrusted hooks are skipped. A trust grant authorizes the configured
hook. The target tool still follows its ordinary approval policy.

## T07b execution decisions

A reviewed hook uses the host's shell sandbox and receives a restricted
environment. Credential values are redacted from the event preview and hook
output. Managed settings storage remains protected in supported sandboxes.
A shell hook receives at most 256 KiB of JSON input and can produce at most
64 KiB of combined output. Timeout, cancellation, and output overflow
terminate its process group. Docker invocations use a dedicated container so
cleanup can terminate the hook without stopping the session's container.

The fixture runner previews a named synthetic event in an existing absolute
workspace. Preview does not start a process or initialize a sandbox.
Execution requires a current reviewed digest and an explicit execute request.
The caller supplies an execution ID for cancellation. The host logs runtime
hook outcomes, while the existing user-message and tool-result records
contain the exact hook text used as model input.

## T07c hook review controls

Desktop and gateway web use the versioned hook inspection, review, and
fixture methods. The workspace stays explicit. The review panel displays
the source, normalized matcher, redacted command, and diagnostics. Batch
trust uses the displayed digests. Fixture execution requires a preview and
an explicit confirmation in the renderer. An in-flight fixture exposes
Cancel and retains the result after termination.

## T07d plugin inspection and revocation decisions

The installed plugin folder is the identity. Static inspection reads a bounded
`package.json` without importing JavaScript. The optional
`sun.requestedActions` array uses the fixed IDs `tools`, `knowledge`, `modes`,
`prompts`, `session-events`, `filesystem`, `network`, and `processes`.
Legacy packages without a declaration remain eligible for activation and show
an undeclared manifest. A malformed manifest is visible and blocks activation.
Requested actions are author disclosures. Enabled JavaScript runs with host
process privileges. The public response contains the declaration, lifecycle
state, and registration names. Raw manifest fields, plugin settings, and
activation exceptions stay outside this response.

The versioned enable/disable operation compares the settings revision and
updates only `plugins.disabled` in the user configuration. The host revokes
the target's registration generation in the same turn as a successful
disable, including during another run or an in-progress activation. Tools
queued for approval must check generation again at execution. The knowledge,
mode, prompt, and event registries also stop dispatching to the revoked
generation. Work already executing may finish. The host reports
`draining` and an in-flight count until settlement and records lifecycle
outcomes in the settings audit without input or result content. Re-enable is
available after draining; it activates the target without restarting its
neighbors. Reload replaces registrations and honors the current file. A CLI
without a running gateway can inspect installed manifests and change the
configuration for the next host start without activating JavaScript.

## T08a gateway identity and revocation decisions

The authenticated connection handshake reports a stable installation ID, a
new gateway ID for each process instance, the host label, protocol version,
and available capabilities. Host identity is separate from the endpoint and
from TLS certificate trust.

Device token writes use an atomic replacement under the same owner lock as
settings writes. Token validation never reinstates a revoked token when
recording last use. The gateway validates authority before dispatching a
buffered RPC and before delivering live events. Revocation closes existing
device event streams and releases their approver registrations. Pending
approvals with no remaining approver resolve as denied. Requests already
dispatched retain their lifecycle. Gateway approval replies require the
prompt ID issued by the current host.

## T08b reconnect decisions

Session creation, text or image sends, and automation starts accept a
client request ID bound to the authenticated principal and the gateway
instance. Identical retries return the first outcome, including when the
first call is still pending. Reusing the ID with a different operation or
payload fails. A bounded acceptance window prevents an expired ID from
executing again after its receipt is removed. IDs from another gateway
instance require the client to reconcile before submitting new work.
Legacy clients can use the existing calls without retry guarantees.

## T08c browser credential decision

The web renderer exchanges a fragment token for an opaque HttpOnly session
cookie. The gateway validates its device authority on use. Browser
credentials expire within 24 hours and are scoped to the live gateway
instance. The cookie uses SameSite Strict and Secure on HTTPS. The renderer
clears the token from the URL before the exchange and erases the legacy
local-storage key. The token is excluded from RPC payloads, browser storage,
and event-stream URLs.

## T08d desktop connection decisions

The desktop connection panel previews a TLS fingerprint without sending a
credential. Confirmation authorizes an authenticated handshake pinned to the
previewed certificate. The desktop stores the profile and token in the
private host-side remote registry and exposes only redacted metadata to the
renderer. Its selected profile is independent of the CLI default. A saved
profile binds subsequent requests to the authenticated installation ID.

When connected to a separate execution host, desktop user-scope preferences
use the local settings revision and host-scope settings use the remote
revision. A same-machine gateway continues sharing the desktop preferences.
A host switch reloads the renderer and invalidates old renderer dispatch.
A disconnected client shows its last received state. Before it can mutate
the host again, the event stream must reconnect and the client must refresh
identity, settings, sessions, and approvals. Drafts keep the revision they
were based on. Browser sessions can require a new sign-in after a restart.

## T09a structured review decisions

Review requests and outcomes are separate durable events linked by request
sequence. The request contains the exact model, system text, user payload,
and empty tool set before provider dispatch. Rule selection uses the
existing project and global rule sources. The digest covers candidate
paths and content, including files omitted from the provider request.
Omissions, malformed findings, and provider failures cannot pass an
enabled completion gate. Review reports are advisory and excluded from
ordinary conversation replay. Imported review history cannot authorize
completion of new work.

## T09b worktree inspection decisions

Worktree inspection verifies the canonical managed path, checked-out
branch, and Git administrative link before reading changes. It uses a
temporary copy of the index to include intent-to-add entries without
modifying the actual staging area. Code review uses the recorded Git base
and includes committed, tracked, and untracked candidate files. Binary
content contributes to the digest and is omitted from the model request.

## T09c worktree lifecycle decisions

The host resolves the selected base before creating the worktree. Branch
and path collisions retry at most five names. Mutations check the session
log, managed directory and Git repository identity under the host storage
lock. Active sessions, reviews, setup and background jobs using the tree
block mutation. A dirty source can be merged only after its changes are
committed. Discard and manual cleanup preserve dirty and unowned trees.
Cleanup compares the displayed inventory revision and rechecks each
selection. A clean worktree with an unmerged branch can be removed while
keeping the branch.

An optional setup command is a reviewed `sessionStart` hook marked
`worktreeSetup: true`. It runs only through the explicit setup action.
The owning host rechecks the current digest in the worktree and uses the
bounded hook runner. It records a start marker before dispatch and an
outcome after settlement. A start without an outcome requires the user to
inspect the workspace and acknowledge the interrupted setup. A worktree
never reruns a dispatched setup automatically.

## T10 browser origin and ownership decisions

Browser grants are a revisioned execution-host store of normalized origin
and action pairs. Unknown pairs produce a review request and stop the
operation. Only an explicit grant allows retry. Document navigation checks
each request before continuing it through CDP, including redirected
requests. Observation and mutation recheck the current page and current
permission. Managed tabs are assigned to one session. Tab generations,
snapshot references, and frame references cannot be reused after tab
replacement. Takeover revokes the agent lease and issues a private control
token. Handback invalidates prior references and requires a fresh snapshot.

One-time upload approvals bind reviewed bytes to the host's permission
revision and to the current session, origin, tab generation, document,
and control lease. Browser downloads inherit the profile's network
and login in an ephemeral Chromium target, check every destination
before dispatch, and stage bounded output under the session owner.
Native downloads are disabled for managed contexts. External contexts
require explicit delegation. See [spec 022](022-browser.md) for the
complete transfer contract.


## T11 Appshot decisions

Appshots are off by default and can be enabled on a supported desktop
with a local execution host. A user starts one capture of the frontmost
window. Capture from the composer is limited to windows owned by Sun
Harness. A global shortcut targets the foreground app. The preview
identifies the window actually captured, including
when the foreground changed. A desktop-only global shortcut can trigger
capture before focusing Sun Harness. Web and gateway hosts do not
expose native capture or confirmation routes.

After ending a macOS capture stream, allow the transient capture
indicator to clear before rechecking a different window in the same
foreground application. The captured window must match the final
foreground window identity before any image is returned.

The execution host keeps a single private draft in memory for up to
five minutes. The preview can be cancelled or prepared with a crop,
opaque redaction rectangles and optional text removal. Image edits
exclude the captured text to avoid reintroducing masked content.
The composer displays the prepared image before the user sends it.
Only an idle session accepts a prepared Appshot. Sending writes the
prepared image and flushes its SHA-256, MIME, byte count, timestamp,
actual window identity, dimensions and approved text to the session
before model dispatch. Preview bytes do not enter the session log.
Replay validates ownership, bytes and digest. Missing or corrupt
images are reported explicitly. Text-only models receive the logged
window description and the approved text. Portable exports preserve
attachment identity and metadata.

## T12 native control decisions

Native control is an explicit local desktop capability. The owner first
enables an application grant and assigns the current session to that
application. The runtime lease exists only in memory and expires. It
binds the session to the running application instance, the focused
window, and an opaque observation generation. A fresh snapshot replaces
previous references. The helper checks the exact target before reading
content or acting. Before the first observation, the assigned app must
come to the foreground. Once bound, a change of application or window
revokes the lease.

If Sun Harness is in front for review, wait briefly for the user to
return to the approved window. Native control does not activate apps.
A different external app or window cannot satisfy the pending action.
Native snapshots use the focused Accessibility tree. The first native
actions press an accessible control and set editable, non-secure text.
They do not inject global coordinates or keystrokes.

The native action path uses the runtime tool policy and rechecks the
lease, app grant, observation, OS permission, and private-window
boundary after approval. A single-use generation is consumed before
dispatch. The host persists an operation receipt before handing input
to the helper. If an outcome cannot be confirmed, the receipt stays
uncertain. Restart does not restore leases or replay pending actions.
Stop and takeover revoke ownership synchronously, abort the native
wait, and discard any later reply. An already-dispatched action may
have taken effect. Reacquiring control requires an explicit owner and
a fresh observation.

## T13 private credential decisions

Website credentials are separate from provider credentials. The desktop
broker stores an opaque reference, normalized HTTPS origin, account
label and revision. Passwords are sealed by Electron's macOS
Keychain-backed storage. The private vault document contains ciphertext
and metadata. The encrypted envelope authenticates the same metadata
before dispatch. The vault is outside settings, session exports and
model context. A missing or unavailable system key refuses create,
replacement and use. Deletion can remove the saved entry without
decrypting it. There is no alternate cipher or plaintext store.

The desktop user explicitly requests a private sign-in and chooses when
to fill the password. A single-use grant binds the reference revision,
the exact normalized HTTPS origin and the current top-level private
document. It expires after one minute. Closing, navigating, replacing
or deleting the entry invalidates the grant. The broker rechecks the
binding after decryption and immediately before dispatch. IPC responses
contain metadata or an allowlisted outcome. Audit records contain only
the operation, outcome and opaque reference.

Sign-in uses a sandboxed desktop window with a temporary browser
partition and a separate trusted control surface. The site has no
desktop bridge. No agent tool, browser frame stream, or gateway
receives the private tab. Navigation, form destination and network
requests are scoped to the reviewed HTTPS origin. Fill requires one
visible, enabled top-level password field and never submits the form.
The private window keeps all login state separate from harness browser
profiles, including after the user signs in. Appshot and future native
control cannot capture this window. The existing browser takeover
workflow remains available when a site needs another sign-in flow or
when the desktop vault is unavailable. Gateway, Docker, external
browser and other operating systems have no broker adapter in this
release.

## T14 execution target decisions

The execution target directory shows the current host, its local Docker
sandbox when configured and usable, and previously authenticated pinned
gateway installations. Remote target identity is the durable gateway host
ID. A connection must match that ID and advertise execution jobs before
the controller submits a job. Endpoint labels, target health, and job
artifacts are separate from account or cloud provisioning.

Starting a job is an explicit user action for a selected target and an
existing session on that target. The target session supplies the
workspace and sandbox. The controller commits an operation ID, target
and session before issuing the start. The target records the operation
and reserves its process identity before spawning. The same operation
with the same request returns its existing receipt. A conflicting
request with the same operation ID fails. A missing acknowledgement
puts the controller into reconciliation. Restart and refresh can query
the original operation without submitting its command again. A launch
reservation with an uncertain process remains visible and is never
replayed automatically.

The controller persists cancellation requested before dispatch. A
target acknowledgement is retained separately from the process outcome.
Job output remains on its originating target and is retrieved using that
target's verified identity. Controller state stores no gateway credentials
or command text. Authenticated remote jobs use the existing gateway
and detached process manager. This release provisions no infrastructure.

Managed Docker jobs use the recorded local Unix daemon and one
operation-labelled container. The configured image must already exist.
Cancellation verifies the container labels and ID before removal.
The wrapper checks the persisted cancellation marker before starting
the container. For Docker jobs, the allowlist mode leaves networking
disabled. Explicit target jobs record completion without an automatic
model response.
