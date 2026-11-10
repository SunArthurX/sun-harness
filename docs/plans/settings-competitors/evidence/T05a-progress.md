# T05a — Preference persistence checkpoint

T05 is in progress. T05a added validated, revisioned preference persistence
through the existing host settings service. This checkpoint does not satisfy all
of AC-05.

- Existing configuration receives additive defaults. Unknown keys survive writes.
- A new session without an explicit mode uses the configured default. The local
  CLI repository folder applies to Coding and Plan. Agent and Assistant retain
  their dedicated default workspace.
- Quiet hours handle overnight intervals and daylight-saving transitions using
  the configured timezone. Shortcut validation rejects reserved and colliding
  bindings before any write.
- The memory switch stops new automatic memory context and extraction and
  preserves the explicit user profile. The voice switch blocks transcription
  before provider access and prevents the CLI from starting a recording.
- The settings DTO exposes the supported preferences and readiness fields without
  returning credential values or unknown raw configuration.

Verification: [Vitest](T05a-test.txt), [build](T05a-build.txt),
[typecheck](T05a-typecheck.txt), [desktop and web smoke](T05a-e2e.txt).
The normal test run recorded 237 passes and one pre-existing skip.

T05b applies appearance and notification preferences, handles voice cancellation,
and integrates the shortcut registry with the desktop OS. T05c adds the settings
sections, profile, Mini, and usage estimates. Those behaviors require their own
acceptance evidence before closing T05.
