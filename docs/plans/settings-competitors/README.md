# Settings and competitor adoption execution pack

T01–T15 are complete within their recorded scope. See the [task manifest](manifest.json) and [release acceptance](evidence/T15.json). Research date: 2026-11-07 (Asia/Shanghai).
Baseline HEAD: `17398f10df01d1606f8789db46e3669cc7e8c459`.
The working tree already contained substantial 0.8–0.11 work when this pack was authored. Preserve it. HEAD alone is not a complete snapshot of the inspected implementation.

## Read in this order

1. Repository `AGENTS.md`, `specs/000-vision.md`, and applicable nested instructions.
2. `research.md`: project map, evidence, screenshot inventory and prioritization.
3. `specs/032-settings-and-capability-management.md`: normative behavior and acceptance IDs.
4. `docs/adr/0010-settings-capability-boundaries.md`: architecture decisions.
5. `implementation.md`: contracts, migration, sequencing and failure behavior.
6. `tasks.md` and `manifest.json`: bounded execution units and dependencies.
7. `handoff.md`: exact instructions for a fresh implementation agent.

This pack contains the design, an executable plan-integrity harness, and implementation evidence. The final live run measured nine first-attempt passes with one model and three bounded fixtures. Small tasks, explicit contracts, and fixed acceptance checks make the handoff reproducible.

## Entry commands

```sh
node scripts/check-settings-plan.mjs
node --test scripts/check-settings-plan.test.mjs
pnpm test
pnpm build
```

The first two commands work offline without model credentials. They validate plan coverage, dependencies, required files and completion evidence, not the correctness of future implementations. Future behavioral tests and human review remain mandatory.

## Release slices

- Foundation: T01–T04, reliable settings, capability visibility, searchable bilingual navigation.
- Everyday controls: T05–T07, preferences, import/storage/privacy, plugin and hook governance.
- Coding and browsing: T08–T10, remote connections, review/Git/worktrees, browser permissions.
- Native context: T11–T12, Appshots and explicitly enabled computer control.
- Optional extensions: T13–T14, credential broker and self-hosted execution targets.
- Release validation: T15, full matrix and model handoff evaluation.

Family-account services and a public hosted cloud are deferred with explicit reasons. A deferred item must not acquire a fake toggle or a success response. Every screenshot entry has a recorded disposition.
