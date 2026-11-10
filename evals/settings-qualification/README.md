# Settings qualification suite

Three synthetic repositories exercise the Settings handoff after T04 and T15.
They use the exact quoted prompt in the handoff document. Each task exposes only
its fixture, requirements and visible tests. The judge enforces a file allowlist
and runs its fixed acceptance tests after the attempt.

Build first, then validate the fixtures offline on macOS:

```sh
pnpm build
node scripts/settings-qualification.mjs --validate
```

Run three repetitions with an explicitly selected configured model and an unused
output directory:

```sh
node scripts/settings-qualification.mjs \
  --model deepseek/deepseek-chat \
  --checkpoint post-t04 \
  --out /tmp/sun-settings-qualification-evidence
```

The runner uses a temporary Sun state directory and fresh fixture repositories.
Agent edits are restricted to task files. The visible test tool and hidden judge
run Node in a sandbox with network and writes denied. Each result includes the
prompt hash, fixture hash, requested model, status, duration, diff and test log.
A run that pauses or fails a fixed check remains a non-pass. Production unit tests
do not contact a model.
