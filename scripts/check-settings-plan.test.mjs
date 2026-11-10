import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handoffFixtureInputs, qualifiedRelease, validatePlan } from './check-settings-plan.mjs';
const original = JSON.parse(readFileSync(new URL('../docs/plans/settings-competitors/manifest.json', import.meta.url), 'utf8'));
const copy = () => {
  const plan = structuredClone(original);
  for (const task of plan.tasks) task.status = 'planned';
  return plan;
};
test('current plan is coherent', () => assert.deepEqual(validatePlan(original), []));
test('missing screenshot entry is rejected', () => { const m = copy(); m.features.pop(); assert.ok(validatePlan(m).some(e => e.includes('coverage'))); });
test('unknown dependency is rejected', () => { const m = copy(); m.tasks[0].dependsOn = ['T99']; assert.ok(validatePlan(m).some(e => e.includes('dependency'))); });
test('dependency cycle is rejected', () => { const m = copy(); m.tasks[0].dependsOn = ['T02']; assert.ok(validatePlan(m).some(e => e.includes('cycle'))); });
test('fake completion without evidence is rejected', () => { const m = copy(); m.tasks[0].status = 'done'; m.tasks[0].evidence = 'nonexistent-plan-evidence.json'; assert.ok(validatePlan(m).some(e => e.includes('missing evidence'))); });
test('unknown acceptance is rejected', () => { const m = copy(); m.tasks[0].acceptance = ['AC-99']; assert.ok(validatePlan(m).some(e => e.includes('unknown acceptance'))); });
test('unimplemented dependency blocks starting work', () => { const m = copy(); m.tasks[1].status = 'in_progress'; assert.ok(validatePlan(m).some(e => e.includes('dependency not done'))); });
test('unexplained deferral is rejected', () => { const m = copy(); m.features[7].reason = ''; assert.ok(validatePlan(m).some(e => e.includes('reason'))); });
test('outside-repository specification is rejected', () => { const m = copy(); m.spec = '/etc/hosts'; assert.ok(validatePlan(m).some(e => e.includes('specification'))); });

const fingerprints = { promptSha256: '1'.repeat(64), suiteSha256: '2'.repeat(64) };

test('the live prompt includes the full public quote and excludes the separate procedure', () => {
  const { prompt } = handoffFixtureInputs();
  assert.match(prompt, /^Implement the first dependency-ready planned task/);
  assert.match(prompt, /\n\nVerify the required behavior/);
  assert.match(prompt, /\n\nWork within the run budget/);
  assert.doesNotMatch(prompt, /## Start/);
});

function releaseReport() {
  return {
    checkpoint: 'post-t15', result: 'pass', model: 'fixture/model', repetitions: 3, expectedAttempts: 9, passed: 9,
    ...fingerprints, finishedAt: '2026-11-09T12:00:00Z',
    attempts: ['attachment-replay', 'permission-denial', 'validated-setting'].flatMap(task => [1, 2, 3].map(repetition => ({
      task, repetition, attempt: 1, status: 'idle', passed: true, toolCalls: 3,
      diffFile: `${task}-${repetition}.diff`, acceptanceFile: `${task}-${repetition}.txt`,
    }))),
  };
}

test('release accepts nine distinct first-attempt passes with artifact evidence', () => {
  assert.equal(qualifiedRelease(releaseReport(), fingerprints, () => true), true);
});

test('release rejects old, repeated, retried, unfinished, or undocumented results', () => {
  for (const change of [
    report => { report.checkpoint = 'post-t04'; },
    report => { report.promptSha256 = '3'.repeat(64); },
    report => { report.suiteSha256 = '4'.repeat(64); },
    report => { report.attempts[8] = report.attempts[7]; },
    report => { report.attempts[0].attempt = 2; },
    report => { report.attempts[0].status = 'paused'; },
    report => { report.attempts[0].passed = false; },
    report => { report.attempts[0].diffFile = '../other.diff'; },
  ]) {
    const report = releaseReport();
    change(report);
    assert.equal(qualifiedRelease(report, fingerprints, () => true), false);
  }
  assert.equal(qualifiedRelease(releaseReport(), fingerprints, file => file !== 'attachment-replay-1.txt'), false);
});
