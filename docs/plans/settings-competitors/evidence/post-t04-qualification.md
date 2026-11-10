# Post-T04 smaller-model qualification

Date: 2026-11-07 (Asia/Shanghai). The strict gate remains 9/9.
The three independent fixture tasks each ran in three fresh Git workspaces.
The fixture suite passed offline validation. Every untouched fixture failed and
each frozen reference solution passed before live runs.

| Model reference | Passed | Observed outcome |
|---|---:|---|
| `glm/glm-4.5-air` | 0/9 | Provider quota paused all nine attempts before any tool call or reported model tokens. These attempts provide no coding quality evidence. |
| `deepseek/deepseek-chat` | 8/9 | Settings 3/3, permission denial 3/3, replay 2/3. The strict gate was not met. |

The failed replay attempt reached the step limit. Its added EACCES test supplied
an attachment and called the reader, but the stub returned an Error object
instead of throwing it. The test expected a thrown exception. The acceptance
output and final diff support this diagnosis. The fixed acceptance tests and
scope checks were retained, and the failing attempt was not replaced.

- [Fixture validation](post-t04-fixture-validation.txt)
- [GLM report and artifact index](qualification-post-t04/report.json)
- [DeepSeek report and artifact index](qualification-post-t04-deepseek/report.json)
- [Failed replay acceptance output](qualification-post-t04-deepseek/attachment-replay-3.txt)
- [Failed replay diff](qualification-post-t04-deepseek/attachment-replay-3.diff)

Both runs use the same prompt and suite hashes. The reports record the requested
model ID, run duration, token counts, outcome, diff and test output for each
attempt. The provider adapter does not report an immutable backend revision.
These are synthetic fixture results. A provider pause and an incomplete run
remain non-passes. The model had no arbitrary shell tool and test execution ran
without network or file writes. The post-T15 repetition remains part of the plan.
