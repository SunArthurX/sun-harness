import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildRepoMap, runBestOfN, typeDiagnostics, extractDefinitions, planTodos, sessionMetrics, syntaxDiagnostics } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

describe('repo map', () => {
  it('extracts definitions and ranks referenced files first', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src/money.ts'), 'export function splitCents(total: number, n: number) {\n  return [];\n}\nexport interface Money { cents: number }\n');
    writeFileSync(join(ws, 'src/a.ts'), "import { splitCents } from './money';\nexport function useA() { return splitCents(1, 2); }\n");
    writeFileSync(join(ws, 'src/b.ts'), "import { splitCents, Money } from './money';\nexport const useB = (m: Money) => splitCents(m.cents, 3);\n");
    writeFileSync(join(ws, 'tool.py'), 'class Runner:\n    def run(self, x):\n        pass\n\ndef main():\n    pass\n');
    const map = buildRepoMap(ws);
    expect(map.totalFiles).toBe(4);
    expect(map.files[0].path).toBe('src/money.ts');
    expect(map.text).toContain('1: export function splitCents(total: number, n: number)');
    expect(map.text).toContain('Runner');
    const q = buildRepoMap(ws, { query: 'runner' });
    expect(q.files.map((f) => f.path)).toEqual(['tool.py']);
    expect(extractDefinitions('def main():\n  pass', 'py')[0]).toMatchObject({ name: 'main', line: 1 });
  });
});

describe('post-edit diagnostics', () => {
  it('reports syntax errors for js, py, and json', () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'ok.js'), 'export const a = 1;\n');
    writeFileSync(join(ws, 'bad.mjs'), 'export const a = ;\n');
    writeFileSync(join(ws, 'bad.py'), 'def f(:\n  pass\n');
    writeFileSync(join(ws, 'bad.json'), '{"a": }');
    expect(syntaxDiagnostics(ws, join(ws, 'ok.js'))).toBeUndefined();
    expect(syntaxDiagnostics(ws, join(ws, 'bad.mjs'))).toMatch(/SyntaxError/);
    expect(syntaxDiagnostics(ws, join(ws, 'bad.py'))).toMatch(/SyntaxError|invalid syntax/);
    expect(syntaxDiagnostics(ws, join(ws, 'bad.json'))).toBeTruthy();
  });

  it('reports TypeScript type errors through the language service, incrementally', () => {
    const ws = mkdtempSync(join(fileURLToPath(new URL('.', import.meta.url)), '.tmp-ts-'));
    try {
      writeFileSync(join(ws, 'package.json'), '{"type":"module"}');
      writeFileSync(join(ws, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'nodenext' }, include: ['*.ts'] }));
      writeFileSync(join(ws, 'lib.ts'), 'export function twice(n: number): number {\n  return n * 2;\n}\n');
      writeFileSync(join(ws, 'main.ts'), "import { twice } from './lib.js';\nconst s: string = twice(2);\nexport { s };\n");
      const d = typeDiagnostics(ws, join(ws, 'main.ts'));
      expect(d?.join('\n')).toMatch(/line 2: TS2322 Type 'number' is not assignable to type 'string'/);
      // A later edit to another file is seen by the cached service (versions follow mtimes).
      writeFileSync(join(ws, 'lib.ts'), 'export function twice(n: number): string {\n  return String(n * 2);\n}\n');
      const later = new Date(Date.now() + 5000);
      utimesSync(join(ws, 'lib.ts'), later, later);
      expect(typeDiagnostics(ws, join(ws, 'main.ts'))).toEqual([]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('appends a warning to the edit tool result', async () => {
    tempHome();
    const ws = tempWorkspace();
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('write_file', { path: 'x.js', content: 'const = 1;\n' })] }, { text: 'done', toolCalls: [] }] }, { verify: { enabled: false, maxAttempts: 0, timeoutMs: 1000 } });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'write');
    await host.wait(s.id);
    const result = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(result.output).toContain('WARNING: errors after this edit');
  });
});

describe('plan mode', () => {
  beforeEach(() => tempHome());

  it('is read-only and switches to coding with todos when the plan is approved', async () => {
    const ws = tempWorkspace();
    const plan = '## Plan\n1. Add the function to src/a.ts\n2. Add a test in test/a.test.ts\n';
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('exit_plan_mode', { plan })] },
        { text: '', toolCalls: [call('write_file', { path: 'a.txt', content: 'hi\n' })] },
        { text: 'implemented', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws, mode: 'plan' });
    await host.send(s.id, 'add a function');
    await host.wait(s.id);
    const reqs = providers.get('mock/a')!.requests;
    const firstTools = reqs[0].tools.map((t) => t.name);
    expect(firstTools).toContain('exit_plan_mode');
    expect(firstTools).toContain('read_file');
    expect(firstTools).not.toContain('write_file');
    expect(firstTools).not.toContain('bash');
    expect(reqs[1].tools.map((t) => t.name)).toContain('write_file');
    expect(reqs[1].tools.map((t) => t.name)).not.toContain('exit_plan_mode');
    const ev = host.getEvents(s.id);
    expect(ev.some((e) => e.type === 'mode/switch' && (e as any).to === 'coding')).toBe(true);
    const todos = ev.find((e) => e.type === 'todo/update') as any;
    expect(todos.items.map((i: any) => i.content)).toEqual(['Add the function to src/a.ts', 'Add a test in test/a.test.ts']);
  });

  it('asks for approval of the plan outside full-auto', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('exit_plan_mode', { plan: '- step one' })] }, { text: 'ok', toolCalls: [] }] }, { approval: 'auto-edit' });
    const seen: string[] = [];
    host.registerApprover();
    host.subscribe((e) => {
      if (e.kind === 'approvals' && e.approvals.length) {
        if (!seen.includes(e.approvals[0].name)) seen.push(e.approvals[0].name);
        setTimeout(() => host.approve(e.approvals[0].callId, 'deny'), 5);
      }
    });
    const s = host.createSession({ cwd: ws, mode: 'plan' });
    await host.send(s.id, 'plan it');
    await host.wait(s.id);
    expect(seen).toEqual(['exit_plan_mode']);
    expect(host.getEvents(s.id).some((e) => e.type === 'mode/switch')).toBe(false);
  });

  it('parses plan steps into todos', () => {
    expect(planTodos('Intro\n- [ ] first step\n* second step\n3) third step\nnot a step').map((t) => t.content)).toEqual(['first step', 'second step', 'third step']);
  });
});

describe('prompt cache telemetry', () => {
  it('sums cached input tokens', () => {
    const m = sessionMetrics([
      { type: 'assistant/message', seq: 1, ts: 0, usage: { inputTokens: 100, outputTokens: 5, cachedTokens: 80 } } as any,
      { type: 'assistant/message', seq: 2, ts: 1, usage: { inputTokens: 120, outputTokens: 5, cachedTokens: 100 } } as any,
    ]);
    expect(m.cachedTokens).toBe(180);
  });
});

describe('best-of-N', () => {
  it('runs candidates in worktrees, picks the one whose tests pass, and applies it', async () => {
    tempHome();
    const dir = mkdtempSync(join(tmpdir(), 'sun-bon-'));
    const git = (...a: string[]) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
    writeFileSync(join(dir, 'check.mjs'), "import { readFileSync } from 'node:fs';\nif (readFileSync('value.txt', 'utf8').trim() !== 'good') process.exit(1);\n");
    writeFileSync(join(dir, 'value.txt'), 'start\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    const attempt = (value: string) => [
      { text: '', toolCalls: [call('read_file', { path: 'value.txt' }), call('write_file', { path: 'value.txt', content: `${value}\n` })] },
      { text: 'done', toolCalls: [] },
    ];
    const { host } = await mockHost({ 'mock/a': attempt('bad'), 'mock/b': attempt('good') }, { verify: { enabled: false, maxAttempts: 0, timeoutMs: 30_000 } });
    const r = await runBestOfN(host, { cwd: dir, prompt: 'make it good', n: 2, models: ['mock/a', 'mock/b'], apply: true });
    expect(r.candidates.map((c) => [c.model, c.verified])).toEqual([
      ['mock/b', true],
      ['mock/a', false],
    ]);
    expect(r.winner?.model).toBe('mock/b');
    expect(r.applied).toBe(true);
    expect(readFileSync(join(dir, 'value.txt'), 'utf8')).toBe('good\n');
  });
});
