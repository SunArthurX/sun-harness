# ADR 0010 — Revisioned settings and capability boundaries

Status: accepted for planning; implementation pending T02–T14.

## Context

The runtime already serves desktop, web, CLI and bots. Settings currently merge a partial object directly into a JSON file; desktop and gateway expose the runtime config. Native capture, app control, provider credentials and remote jobs require different trust and lifecycle boundaries.

## Decision

Keep HarnessHost as the business API. Add a validated settings service with revisioned writes and redacted read DTOs. Add a capability descriptor registry that references the existing extension/tool registry rather than replacing it. Inject native and secure-storage adapters from Electron main; web gets explicit unsupported capabilities. Execution targets stay provider-independent and local-first.

Use a single authoritative writer when attached to a gateway, plus cross-process locking and revision checks for remaining local CLI writers. Read provenance without introducing a new project-wide config layer in the first release. User preferences and host runtime settings have explicit scope. Runtime configuration changes apply at safe boundaries and return restart/reload information.

Native capture and computer actions are extension adapters; core defines interfaces only. Secrets are brokered outside model context. Review and attachment requests gain durable input events. Independent settings audit records are not injected into the model unless they actually affect its input.

Decision (T05c): Mini is an Electron window with a narrow IPC interface for
active-run status, Stop, and opening a chat. The same host owns runs and their
abort controllers whether Electron runs it locally or attaches to a gateway.
The web renderer has no Mini capability.

Decision (T06b): keep flat session logs readable and publish imported logs and
attachments as a single directory under the sessions root. Validation and
attachment writes happen in a private sibling directory. A rename publishes
the unit. The gateway streams the portable format without passing binary
payloads through JSON RPC. Import resets operational authority to the
receiving host and records the historical sequence boundary in session
metadata.

Decision (T06c): archive state remains in session events. Storage cleanup
operates on bounded owned roots and uses a separate journal. The storage
lock serializes confirmed moves and short file writes. Long-running host
work publishes activity markers so cleanup can prove an item is inactive
without holding the lock during a model request or browser operation.

Decision (T07a–b): configured hooks acquire local trust by source digest.
Runtime and fixture dispatch share the reviewed command boundary and bounded
process runner. Docker hooks use an invocation container so termination does
not remove the session's shell sandbox. Settings receive a redacted inspection
view and model-visible hook text uses the normal durable events.

Decision (T07c): keep plugin declaration inspection separate from JavaScript
activation. A plugin management write updates its disabled state through the
settings transaction and revokes its registration generation on the owning
host. Registered asynchronous calls that already started retain their
original lifecycle. The host records when they finish draining. Other
plugins remain registered.

Decision (T08a–c): a stable installation identity and a gateway-instance
identity accompany the authenticated protocol handshake. Revocation is
checked on live events and before queued dispatch. Short-lived retry
receipts are bound to the authenticated principal and the live gateway,
with only a digest of the operation payload retained. Browser bootstrap
credentials are exchanged for opaque HttpOnly sessions.

Decision (T08d): desktop connections share the host-side remote registry
with a separate selected-profile field. The main process pins the reviewed
certificate and installation ID before routing renderer calls. A renderer
document is bound to one routing generation. The desktop merges local UI
preferences into the remote settings view and checks each write against the
revision of its own store. Reconnect keeps host writes paused until the
event stream and fresh host data are available.

Decision (T09): reviews persist the exact provider request before dispatch
and bind validated findings to a digest of the candidate changes. Managed
worktree inspection uses a temporary index. Lifecycle mutations recheck
Git ownership and host activity before acting. Cleanup keeps unmerged
branches, and reviewed setup uses a durable start and outcome marker.

## Consequences

More DTOs, migration tests and transport parity tests are required. Legacy clients need an explicit protocol error or a compatibility adapter; secret-bearing config responses are removed. Web cannot control the desktop merely because it uses the same renderer. Family services, public cloud hosting and custom animated pets remain separate future product decisions. New adapters must prove cancellation, restart and approval semantics before being advertised as ready.
