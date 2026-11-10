# 0015 — Scoped native computer control

## Context

Native controls change external application state. Browser ownership
does not identify a macOS application window or authorize OS actions.
An action can reach its target even if the response is lost.

## Decision

The local desktop owns the native adapter. A revisioned app-grant file
and a short-lived session lease govern every observation and action.
Hosts sharing a data directory contend for the same storage lease. The
lease captures the foreground process instance, window identity, and
single-use observation. The helper confirms the focused Accessibility
window, resolves a fingerprint of the control within it, and rechecks
OS permission and target identity before dispatch. The helper binds
requests to its parent process and receives input through a private pipe.
[Apple Accessibility APIs](https://developer.apple.com/documentation/applicationservices/axuielement_h)

The existing runtime tool policy handles approval. When the desktop
is foregrounded for review, the helper waits briefly for the user to
bring back the exact approved target. Observation results are untrusted
tool output. Press and set-text calls use accessible controls. Secure
fields and the private sign-in window are excluded.

Before dispatch, flush an operation record to the owning session log.
Consume its observation before calling the adapter. Preserve the intent
record if the action returns no verified outcome. Stop invalidates the
lease before ending the caller's wait and killing the helper. An adapter
that has not settled continues to hold the exclusive process claim.

## Consequences

Restart cannot restore a model's native element references. The user
must start a new assignment before taking another observation. Tool
approval and an app grant remain independent. Accessibility permission
is granted per signed build, and positive native acceptance requires
testing that exact build with a synthetic local application.
