# 008 — Approval policy: fail closed

Status: implemented (iteration 1, from intel 2026-11-07: Claude Code 2.1.317–2.1.319).
Code: `host.ts` (`registerApprover`, `requestApproval`), `hooks.ts` (`onFailure`).

## Decision

Autonomy degrades to the safe state. When a human decision is needed but cannot be obtained, the call is **denied with a reason**, never silently allowed and never left hanging.

## Rules

1. Approval modes and risks are defined in 001. `allow_always` is per session and derived from the log.
2. A UI that can answer approvals registers with `host.registerApprover()` (desktop window; CLI only when stdin is a TTY).
3. If no approver is registered (piped `sun run`, launchd, closed window) **or** `denyInsteadOfPrompting` is true, an approval request resolves immediately to `deny` with a reason. The reason is logged on `approval/decision` and returned to the model as the tool result, so the run continues.
3a. Approvers are scoped (`registerApprover(scope)`): an approval is only awaited if a registered approver can see its session; every answer must quote the current `promptId` (see `specs/016-approval-race-guard.md`).
4. `preToolUse` hooks with `onFailure: "block"` veto the call when the hook crashes, times out, or exits non-zero (other than the explicit exit 2 block). Default `ignore` keeps that behavior for reviewed hooks. Decision (T07a): missing trust or an invalid enabled policy hook also blocks when it applies. An invalid source that may contain a policy hook blocks because its policy cannot be determined.

## Why

Observed in the field: a blocked prompt in a headless run hangs forever; a broken policy hook silently disables the policy. Both are availability-vs-safety trade-offs where the safe default is "deny and explain".
