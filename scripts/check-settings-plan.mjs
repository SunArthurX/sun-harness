import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pack = 'docs/plans/settings-competitors/';
const fixtureTasks = ['attachment-replay', 'permission-denial', 'validated-setting'];
const digest = /^[a-f0-9]{64}$/;

export function handoffFixtureInputs(base = root) {
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const source = join(base, 'evals/settings-qualification');
  const handoff = readFileSync(join(base, pack, 'handoff.md'), 'utf8');
  const quote = handoff.match(/^> Implement the first dependency-ready planned task[^\r\n]*(?:\r?\n>(?: [^\r\n]*)?)*/m)?.[0];
  if (!quote) throw new Error('Cannot locate the frozen handoff prompt.');
  const prompt = quote.split(/\r?\n/).map(line => line.replace(/^> ?/, '')).join('\n');
  const parts = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => join(entry.parentPath, entry.name))
    .sort()
    .map(path => [path.slice(source.length + 1), hash(readFileSync(path))]);
  return { prompt, promptSha256: hash(prompt), suiteSha256: hash(JSON.stringify(parts)) };
}

export function qualifiedRelease(report, fingerprints, hasArtifact) {
  if (!report || report.checkpoint !== 'post-t15' || report.result !== 'pass' || report.repetitions !== 3
    || report.expectedAttempts !== 9 || report.passed !== 9 || typeof report.model !== 'string' || !report.model.includes('/')
    || !digest.test(report.promptSha256) || report.promptSha256 !== fingerprints.promptSha256
    || !digest.test(report.suiteSha256) || report.suiteSha256 !== fingerprints.suiteSha256 || !Number.isFinite(Date.parse(report.finishedAt))
    || !Array.isArray(report.attempts) || report.attempts.length !== 9) return false;
  const expected = new Set(fixtureTasks.flatMap(task => [1, 2, 3].map(repeat => `${task}-${repeat}`)));
  return report.attempts.every(attempt => {
    if (!attempt) return false;
    const key = `${attempt.task}-${attempt.repetition}`;
    return expected.delete(key) && attempt.attempt === 1 && attempt.status === 'idle' && attempt.passed === true
      && Number.isInteger(attempt.toolCalls) && attempt.toolCalls > 0
      && attempt.diffFile === `${key}.diff` && attempt.acceptanceFile === `${key}.txt`
      && hasArtifact(attempt.diffFile) && hasArtifact(attempt.acceptanceFile);
  });
}

export function validatePlan(m, base = root) {
  const errors = [];
  const check = (ok, message) => { if (!ok) errors.push(message); };
  const file = (p) => typeof p === 'string' && !isAbsolute(p) && !relative(base, resolve(base, p)).startsWith('..') && existsSync(resolve(base, p));
  const nonempty = p => {
    if (!file(p)) return false;
    const info = statSync(resolve(base, p));
    return info.isFile() && info.size > 0;
  };
  check(m.version === 1, 'Unsupported manifest version');
  check(file(m.spec), 'Missing specification');
  const spec = file(m.spec) ? readFileSync(resolve(base, m.spec), 'utf8') : '';
  for (const name of ['README.md', 'research.md', 'implementation.md', 'tasks.md', 'handoff.md']) check(file(pack + name), `Missing ${name}`);
  const tasks = Array.isArray(m.tasks) ? m.tasks : [];
  const features = Array.isArray(m.features) ? m.features : [];
  const ids = new Set(tasks.map(t => t.id));
  check(ids.size === tasks.length && tasks.length >= 15, 'Duplicate or missing tasks');
  const expected = Array.from({ length: 29 }, (_, i) => `S${String(i + 1).padStart(2, '0')}`);
  check(features.length === 29 && new Set(features.map(f => f.id)).size === 29 && expected.every(id => features.some(f => f.id === id)), 'Screenshot coverage must contain S01-S29 exactly once');
  for (const f of features) {
    check(['adapt', 'new', 'defer'].includes(f.decision), `${f.id}: invalid disposition`);
    check(typeof f.reason === 'string' && f.reason.length > 20, `${f.id}: missing scope/reason`);
    check(f.decision === 'defer' ? f.task === null : ids.has(f.task), `${f.id}: invalid task mapping`);
  }
  const active = new Set(), visited = new Set();
  const visit = (id) => {
    if (active.has(id)) { errors.push(`Dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of tasks.find(t => t.id === id)?.dependsOn ?? []) if (ids.has(dep)) visit(dep);
    active.delete(id); visited.add(id);
  };
  for (const t of tasks) {
    check(['planned', 'in_progress', 'blocked', 'done'].includes(t.status), `${t.id}: invalid status`);
    check(Array.isArray(t.dependsOn) && t.dependsOn.every(d => ids.has(d) && d !== t.id), `${t.id}: invalid dependency`);
    check(Array.isArray(t.files) && t.files.length > 0, `${t.id}: missing file scope`);
    check(Array.isArray(t.acceptance) && t.acceptance.length > 0 && t.acceptance.every(a => spec.includes(a + ':')), `${t.id}: unknown acceptance ID`);
    visit(t.id);
    if (t.status === 'done' || t.status === 'in_progress') check(t.dependsOn.every(d => tasks.find(x => x.id === d)?.status === 'done'), `${t.id}: dependency not done`);
    if (t.status !== 'done') continue;
    if (!file(t.evidence)) { errors.push(`${t.id}: missing evidence`); continue; }
    try {
      const e = JSON.parse(readFileSync(resolve(base, t.evidence), 'utf8'));
      check(e.task === t.id && e.result === 'pass', `${t.id}: invalid evidence result`);
      check(t.acceptance.every(a => e.acceptance?.includes(a)), `${t.id}: acceptance evidence missing`);
      check(Array.isArray(e.commands) && e.commands.length > 0 && e.commands.every(c => c.exitCode === 0 && typeof c.command === 'string' && nonempty(c.outputFile)), `${t.id}: command evidence missing/failed`);
      for (const cmd of ['pnpm test', 'pnpm build']) check(e.commands?.some(c => c.command === cmd), `${t.id}: missing ${cmd}`);
      check(Array.isArray(e.artifacts) && e.artifacts.length > 0 && e.artifacts.every(file), `${t.id}: artifacts missing`);
      check(Array.isArray(e.manualChecks) && Array.isArray(e.limitations) && typeof e.rollback === 'string' && e.rollback.length > 10, `${t.id}: incomplete report`);
      if (t.id === 'T15') {
        const report = nonempty(e.qualificationReport) ? JSON.parse(readFileSync(resolve(base, e.qualificationReport), 'utf8')) : undefined;
        check(qualifiedRelease(report, handoffFixtureInputs(base), artifact => nonempty(join(dirname(e.qualificationReport), artifact))),
          'T15: missing nine first-attempt handoff passes for the current prompt and fixture suite');
      }
    } catch { errors.push(`${t.id}: unreadable evidence`); }
  }
  for (let i = 1; i <= 16; i++) {
    const a = `AC-${String(i).padStart(2, '0')}`;
    check(tasks.some(t => t.acceptance?.includes(a)), `Unmapped ${a}`);
  }
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const m = JSON.parse(readFileSync(resolve(root, pack, 'manifest.json'), 'utf8'));
    const errors = validatePlan(m);
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    else console.log(`Plan integrity passed: ${m.features.length} screenshot entries, ${m.tasks.length} tasks. Product implementation remains subject to behavioral acceptance.`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
