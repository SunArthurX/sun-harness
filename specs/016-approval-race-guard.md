# 016 — Approval race guard

Status: implemented (iteration 9). Source: Claude Code 2.1.318 (permission prompts answered by stray keystrokes or before the prompt rendered).
Code: `host.ts` (`approve`, `PendingApproval.promptId`), `gateway.ts`, CLI `askApproval`, desktop `ApprovalCard`.

## Rules

1. **Prompt ids.** Every showing of an approval has a fresh `promptId` (and `requestedAt`). A call re-requested after a restart or resume gets a new id.
2. **Answers must match.** `approve(callId, decision, promptId?)` returns `false` (the gateway answers an error) for an unknown call, an already answered call, or a `promptId` that is not the current one. UIs always send the `promptId` they displayed.
3. **CLI.** When an approval prompt appears, the current half-typed line is cleared; any answer that arrives within 400 ms of the prompt being drawn was typed before it and is ignored (the prompt asks again). Only `y/yes`, `a/always`, `n/no` or an empty line (deny) are accepted.
4. **Desktop and web.** The approval card's buttons are disabled for 700 ms after it appears ("read first…"), focus is moved off the composer, and clicks before arming do nothing.
5. **Scoped approvers.** `registerApprover(scope)` registers a UI for the sessions it can show (a chat bot only for its chats). An approval that no registered approver can see is denied (specs/008), not left waiting.
