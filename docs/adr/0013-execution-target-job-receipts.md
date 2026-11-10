# 0013 — Durable execution target job receipts

## Context

The gateway can restart or lose a reply after accepting a job. Repeating
a shell launch in that situation can duplicate workspace changes.
Remote installations also need stable identity across gateway process
restarts. Docker is a local execution environment with a different
cancellation boundary from a detached host process.

## Decision

Use the pinned gateway's durable host identity as the remote target
key. Before dispatch, write a private controller record with an
operation ID and request digest. The provider reserves a deterministic
process job ID in its durable job record before spawning. A detached
wrapper publishes its PID before running the user command. The
controller reconciles using the original operation ID and the provider
job receipt. It never replays a launch with an uncertain outcome.

Record cancellation intent before signalling a process or removing a
container. Store the provider acknowledgement independently of the
process result. A Docker job uses a uniquely labelled container on the
recorded local socket and checks that identity before removing it.
Read output through the verified originating target.

## Consequences

A lost reply or gateway restart leaves an inspectable operation
without creating a second command. An unconfirmed process reservation
can remain in reconciliation. Output and workspace files stay on
the target. The target uses a session's existing workspace and sandbox.
Credentials stay in the existing connection storage and the controller
records contain request digests rather than command text.
