import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessHost } from './host.js';
import { SessionLog } from './log.js';
import { ensureDir, homePath } from './paths.js';
import { runBestOfN } from './bestofn.js';
import { sessionMetrics, type SessionMetrics } from './telemetry.js';

export interface EvalTask {
  id: string;
  title: string;
  category: string;
  language: string;
  prompt: string;
  dir: string;
}

export interface EvalResult extends SessionMetrics {
  id: string;
  category: string;
  passed: boolean;
  status: string;
  reason?: string;
  sessionId: string;
  workspace: string;
  checkOutput: string;
}

export interface EvalRun {
  id: string;
  label: string;
  suite: string;
  model: string;
  startedAt: string;
  finishedAt: string;
  results: EvalResult[];
  summary: EvalSummary;
}

export interface EvalSummary {
  tasks: number;
  passed: number;
  passRate: number;
  avgSteps: number;
  avgToolCalls: number;
  toolErrorRate: number;
  editFailureRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Share of input tokens served from the prompt cache. */
  cacheHitRate: number;
  avgDurationMs: number;
  byCategory: Record<string, { tasks: number; passed: number }>;
}

export function loadSuite(suiteDir: string): EvalTask[] {
  const dir = resolve(suiteDir);
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, 'task.json')))
    .sort()
    .map((d) => ({ ...(JSON.parse(readFileSync(join(dir, d, 'task.json'), 'utf8')) as Omit<EvalTask, 'dir'>), dir: join(dir, d) }));
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Fresh git workspace with the task's repo/ committed (and setup.sh applied). Returns the base commit. */
export function prepareWorkspace(task: EvalTask): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), `sun-eval-${task.id}-`));
  cpSync(join(task.dir, 'repo'), dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'eval@sun-harness.local');
  git(dir, 'config', 'user.name', 'sun eval');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'eval base', '--allow-empty');
  const base = git(dir, 'rev-parse', 'HEAD');
  if (existsSync(join(task.dir, 'setup.sh'))) {
    const r = spawnSync('bash', [join(task.dir, 'setup.sh')], { cwd: dir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`setup.sh failed for ${task.id}: ${r.stderr}`);
  }
  return { dir, base };
}

/** Copy hidden tests in (only now, after the agent finished) and run check.sh. */
export function runCheck(task: EvalTask, dir: string, base: string): { passed: boolean; output: string } {
  const hidden = join(task.dir, 'hidden');
  if (existsSync(hidden)) cpSync(hidden, join(dir, '.eval-hidden'), { recursive: true });
  const r = spawnSync('bash', [join(task.dir, 'check.sh')], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, EVAL_BASE: base },
  });
  return { passed: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-4000) };
}

export function summarize(results: EvalResult[]): EvalSummary {
  const n = results.length || 1;
  const sum = (f: (r: EvalResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const byCategory: EvalSummary['byCategory'] = {};
  for (const r of results) {
    const c = (byCategory[r.category] ??= { tasks: 0, passed: 0 });
    c.tasks++;
    if (r.passed) c.passed++;
  }
  const calls = sum((r) => r.toolCalls);
  const edits = sum((r) => r.editCalls);
  return {
    tasks: results.length,
    passed: results.filter((r) => r.passed).length,
    passRate: results.filter((r) => r.passed).length / n,
    avgSteps: sum((r) => r.steps) / n,
    avgToolCalls: calls / n,
    toolErrorRate: calls ? sum((r) => r.toolErrors) / calls : 0,
    editFailureRate: edits ? sum((r) => r.editFailures) / edits : 0,
    totalInputTokens: sum((r) => r.inputTokens),
    totalOutputTokens: sum((r) => r.outputTokens),
    cacheHitRate: sum((r) => r.inputTokens) ? sum((r) => r.cachedTokens ?? 0) / sum((r) => r.inputTokens) : 0,
    avgDurationMs: sum((r) => r.durationMs) / n,
    byCategory,
  };
}

export interface RunEvalOptions {
  host: HarnessHost;
  suiteDir: string;
  suite?: string;
  label?: string;
  model?: string;
  only?: string[];
  concurrency?: number;
  /** Per-task wall clock limit. */
  timeoutMs?: number;
  onResult?: (r: EvalResult) => void;
  /** Best-of-N per task: N worktree candidates judged by the visible tests; cost metrics sum all candidates. */
  bestOf?: number;
}

async function runTask(o: RunEvalOptions, task: EvalTask): Promise<EvalResult> {
  const { host } = o;
  const { dir, base } = prepareWorkspace(task);
  if ((o.bestOf ?? 1) > 1) {
    const timeoutMs = o.timeoutMs ?? 10 * 60_000;
    const r = await runBestOfN(host, { cwd: dir, prompt: task.prompt, n: o.bestOf!, models: o.model ? [o.model] : undefined, apply: true, timeoutMs });
    const metrics = r.candidates.map((c) => sessionMetrics(SessionLog.open(c.sessionId).all()));
    const total = metrics.reduce((acc, m) => {
      for (const k of Object.keys(m) as (keyof typeof m)[]) if (typeof m[k] === 'number') (acc as any)[k] = ((acc as any)[k] ?? 0) + (m[k] as number);
      return acc;
    }, sessionMetrics([]));
    const check = runCheck(task, dir, base);
    return {
      id: task.id,
      category: task.category,
      passed: check.passed,
      status: r.winner?.status ?? 'no-candidate',
      reason: r.winner ? `best of ${o.bestOf}: ${r.candidates.map((c) => (c.verified === null ? '?' : c.verified ? '✓' : '✗')).join('')}` : 'no candidate changed anything',
      sessionId: r.winner?.sessionId ?? r.candidates[0]?.sessionId ?? '',
      workspace: dir,
      checkOutput: check.output,
      ...total,
      durationMs: Math.max(...metrics.map((m) => m.durationMs)),
    };
  }
  const s = host.createSession({ cwd: dir, mode: 'coding', model: o.model, approval: 'full-auto', title: `[eval] ${task.id}` });
  await host.send(s.id, task.prompt, 'user', { noDetect: true });
  const deadline = Date.now() + (o.timeoutMs ?? 10 * 60_000);
  let timedOut = false;
  while (host.isRunning(s.id) || host.listJobs(s.id).some((j) => j.state === 'running')) {
    if (Date.now() > deadline) {
      timedOut = true;
      host.abort(s.id);
      for (const j of host.listJobs(s.id)) if (j.state === 'running') host.killJob(j.id);
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  await host.wait(s.id);
  const log = SessionLog.open(s.id);
  const st = log.status();
  const check = runCheck(task, dir, base);
  return {
    id: task.id,
    category: task.category,
    passed: check.passed,
    status: timedOut ? 'timeout' : st.status,
    reason: st.reason,
    sessionId: s.id,
    workspace: dir,
    checkOutput: check.output,
    ...sessionMetrics(log.all()),
  };
}

/** Run a suite with bounded concurrency; results are saved to ~/.sun/evals/<id>.json. */
export async function runEval(o: RunEvalOptions): Promise<EvalRun> {
  const tasks = loadSuite(o.suiteDir).filter((t) => !o.only?.length || o.only.includes(t.id));
  const startedAt = new Date().toISOString();
  const results: EvalResult[] = [];
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++];
      let r: EvalResult;
      try {
        r = await runTask(o, t);
      } catch (e) {
        r = { id: t.id, category: t.category, passed: false, status: 'error', reason: (e as Error).message, sessionId: '', workspace: '', checkOutput: '', ...sessionMetrics([]) };
      }
      results.push(r);
      o.onResult?.(r);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency ?? 3, tasks.length)) }, worker));
  results.sort((a, b) => a.id.localeCompare(b.id));
  const model = o.model || o.host.config.defaultModel;
  const id = `${startedAt.replace(/[:.]/g, '-').slice(0, 19)}-${(o.label ?? 'run').replace(/[^\w-]/g, '_')}`;
  const run: EvalRun = { id, label: o.label ?? 'run', suite: o.suite ?? 'coding', model, startedAt, finishedAt: new Date().toISOString(), results, summary: summarize(results) };
  ensureDir(homePath('evals'));
  writeFileSync(homePath('evals', `${id}.json`), JSON.stringify(run, null, 2));
  return run;
}

export function listEvalRuns(): { id: string; label: string; model: string; passRate: number; tasks: number; startedAt: string }[] {
  const dir = ensureDir(homePath('evals'));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as EvalRun)
    .map((r) => ({ id: r.id, label: r.label, model: r.model, passRate: r.summary.passRate, tasks: r.summary.tasks, startedAt: r.startedAt }))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function loadEvalRun(idOrLabel: string): EvalRun {
  const dir = ensureDir(homePath('evals'));
  const f = existsSync(join(dir, `${idOrLabel}.json`)) ? `${idOrLabel}.json` : readdirSync(dir).filter((x) => x.endsWith(`-${idOrLabel}.json`)).sort().pop();
  if (!f) throw new Error(`No eval run ${idOrLabel}`);
  return JSON.parse(readFileSync(join(dir, f), 'utf8'));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatEvalReport(run: EvalRun): string {
  const s = run.summary;
  const lines = [
    `# Eval ${run.label} (${run.model})`,
    '',
    `Pass rate **${pct(s.passRate)}** (${s.passed}/${s.tasks}) · avg steps ${s.avgSteps.toFixed(1)} · avg tool calls ${s.avgToolCalls.toFixed(1)} · tool error rate ${pct(s.toolErrorRate)} · edit failure rate ${pct(s.editFailureRate)} · tokens ${s.totalInputTokens} in (${pct(s.cacheHitRate ?? 0)} cached) / ${s.totalOutputTokens} out · avg ${(s.avgDurationMs / 1000).toFixed(1)} s`,
    '',
    '| Task | Category | Result | Steps | Tool errors | Edit failures | Status |',
    '|---|---|---|---|---|---|---|',
    ...run.results.map((r) => `| ${r.id} | ${r.category} | ${r.passed ? 'pass' : 'FAIL'} | ${r.steps} | ${r.toolErrors} | ${r.editFailures} | ${r.status}${r.reason ? ` (${r.reason})` : ''} |`),
  ];
  return lines.join('\n');
}

export function compareEvalRuns(a: EvalRun, b: EvalRun): string {
  const d = (x: number, y: number, p = false) => {
    const v = y - x;
    return `${v >= 0 ? '+' : ''}${p ? (v * 100).toFixed(1) + ' pp' : v.toFixed(1)}`;
  };
  const rows = [...new Set([...a.results.map((r) => r.id), ...b.results.map((r) => r.id)])].sort().map((id) => {
    const x = a.results.find((r) => r.id === id);
    const y = b.results.find((r) => r.id === id);
    const mark = (r?: EvalResult) => (r ? (r.passed ? 'pass' : 'FAIL') : '—');
    const change = x && y && x.passed !== y.passed ? (y.passed ? '▲ fixed' : '▼ regressed') : '';
    return `| ${id} | ${mark(x)} | ${mark(y)} | ${change} |`;
  });
  const sa = a.summary;
  const sb = b.summary;
  return [
    `# ${a.label} → ${b.label}`,
    '',
    `| Metric | ${a.label} | ${b.label} | Δ |`,
    '|---|---|---|---|',
    `| Pass rate | ${pct(sa.passRate)} | ${pct(sb.passRate)} | ${d(sa.passRate, sb.passRate, true)} |`,
    `| Avg steps | ${sa.avgSteps.toFixed(1)} | ${sb.avgSteps.toFixed(1)} | ${d(sa.avgSteps, sb.avgSteps)} |`,
    `| Tool error rate | ${pct(sa.toolErrorRate)} | ${pct(sb.toolErrorRate)} | ${d(sa.toolErrorRate, sb.toolErrorRate, true)} |`,
    `| Edit failure rate | ${pct(sa.editFailureRate)} | ${pct(sb.editFailureRate)} | ${d(sa.editFailureRate, sb.editFailureRate, true)} |`,
    `| Input tokens | ${sa.totalInputTokens} | ${sb.totalInputTokens} | ${d(sa.totalInputTokens, sb.totalInputTokens)} |`,
    `| Cache hit rate | ${pct(sa.cacheHitRate ?? 0)} | ${pct(sb.cacheHitRate ?? 0)} | ${d(sa.cacheHitRate ?? 0, sb.cacheHitRate ?? 0, true)} |`,
    '',
    `| Task | ${a.label} | ${b.label} | Change |`,
    '|---|---|---|---|',
    ...rows,
  ].join('\n');
}

/**
 * Sanity check of a suite: every task must FAIL on its untouched repo (no free passes) and PASS after its
 * reference solution.sh (the check is fair and the task solvable). Reference solutions are never shown to agents.
 */
export function validateSuite(suiteDir: string): { id: string; ok: boolean; failsUntouched: boolean; solvable: boolean | null; output: string }[] {
  return loadSuite(suiteDir).map((t) => {
    const untouched = prepareWorkspace(t);
    const before = runCheck(t, untouched.dir, untouched.base);
    let solvable: boolean | null = null;
    let output = before.passed ? before.output.slice(-300) : '';
    if (existsSync(join(t.dir, 'solution.sh'))) {
      const solved = prepareWorkspace(t);
      const r = spawnSync('bash', [join(t.dir, 'solution.sh')], { cwd: solved.dir, encoding: 'utf8' });
      const after = r.status === 0 ? runCheck(t, solved.dir, solved.base) : { passed: false, output: r.stderr };
      solvable = after.passed;
      if (!after.passed) output = after.output.slice(-600);
    }
    return { id: t.id, ok: !before.passed && solvable !== false, failsUntouched: !before.passed, solvable, output };
  });
}
