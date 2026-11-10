import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HarnessHost, MockProvider, applyHunks, homePath, parsePatch, runEval, tolerantReplace, validateSuite, wireArguments } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

describe('tolerant replace', () => {
  it('exact, CRLF-normalized, and whitespace-insensitive matches', () => {
    expect(tolerantReplace('a\nb\n', 'b', 'c')).toMatchObject({ text: 'a\nc\n', how: 'exact' });
    expect(tolerantReplace('x\r\ny\r\nz', 'x\ny', 'X\nY')).toMatchObject({ text: 'X\r\nY\r\nz', how: 'newlines' });
    const file = 'function f() {\n    if (a) {\n        return 1;\n    }\n}\n';
    const r = tolerantReplace(file, 'if (a) {\n  return 1;\n}', 'if (a) {\n  return 2;\n}');
    expect(r.how).toBe('whitespace');
    expect(r.text).toBe('function f() {\n    if (a) {\n      return 2;\n    }\n}\n');
  });

  it('explains ambiguity and missing text with the closest region', () => {
    expect(() => tolerantReplace('k = 1\nk = 1\n', 'k = 1', 'k = 2')).toThrow(/matches 2 times/);
    expect(() => tolerantReplace('  a\n  b\n  a\n  b\n', 'a\nb', 'c')).toThrow(/2 places when whitespace is ignored \(lines 1, 3\)/);
    expect(() => tolerantReplace('alpha\nbeta\ngamma\n', 'beta\ndelta', 'x')).toThrow(/Closest region \(lines 1-4, 1\/2 lines match\)/);
    expect(tolerantReplace('a a a', 'a', 'b', true)).toMatchObject({ text: 'b b b', count: 3 });
  });

  it('wraps malformed tool-call JSON so strict providers accept the history', () => {
    expect(wireArguments('{"a":1}')).toBe('{"a":1}');
    expect(wireArguments('')).toBe('{}');
    expect(JSON.parse(wireArguments('{"path": "src/calc.js", "old_string": "x'))._invalid_json).toContain('src/calc.js');
    expect(JSON.parse(wireArguments('[1,2]'))).toEqual({ value: [1, 2] });
  });
});

describe('apply_patch', () => {
  it('parses add/update/delete/move and applies hunks with context', () => {
    const ops = parsePatch(['*** Begin Patch', '*** Add File: n.txt', '+hello', '*** Update File: a.js', '*** Move to: b.js', '@@ function f', ' function f() {', '-  return 1;', '+  return 2;', ' }', '*** Delete File: old.txt', '*** End Patch'].join('\n'));
    expect(ops.map((o) => [o.kind, o.path, o.moveTo])).toEqual([['add', 'n.txt', undefined], ['update', 'a.js', 'b.js'], ['delete', 'old.txt', undefined]]);
    expect(applyHunks('x\nfunction f() {\n  return 1;\n}\n', ops[1].hunks!, 'a.js')).toBe('x\nfunction f() {\n  return 2;\n}\n');
    expect(() => applyHunks('nothing here\n', ops[1].hunks!, 'a.js')).toThrow(/does not apply/);
    expect(() => parsePatch('*** Update File: x')).toThrow(/Begin Patch/);
  });
});

describe('edit tools in sessions', () => {
  let ws: string;
  beforeEach(() => {
    tempHome();
    ws = tempWorkspace();
    writeFileSync(join(ws, 'a.js'), 'const a = 1;\n');
    writeFileSync(join(ws, 'b.js'), 'const b = 1;\n');
  });

  it('allows anchored edits of unread files, refuses blind overwrites, and detects stale reads', async () => {
    writeFileSync(join(ws, 'u.js'), 'let u = 1;\n');
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('edit_file', { path: 'u.js', old_string: 'let u = 1;', new_string: 'let u = 2;' })] },
        { text: '', toolCalls: [call('read_file', { path: 'a.js' }), call('bash', { command: 'echo "// changed" >> a.js' }), call('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' })] },
        { text: '', toolCalls: [call('read_file', { path: 'a.js' }), call('edit_file', { path: 'a.js', old_string: 'const a = 1;', new_string: 'const a = 2;' }), call('edit_file', { path: 'a.js', old_string: 'const a = 2;', new_string: 'const a = 3;' })] },
        { text: '', toolCalls: [call('write_file', { path: 'new.js', content: 'x' }), call('write_file', { path: 'b.js', content: 'overwrite' }), call('write_file', { path: 'b.js', content: 'overwrite' })] },
        { text: 'done', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'go');
    await host.wait(s.id);
    const out = (host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[]).map((r) => `${r.name}:${r.isError ? 'ERR' : 'ok'}:${r.output.split('\n')[0].slice(0, 60)}`);
    expect(out[0]).toMatch(/edit_file:ok:Edited u.js/);
    expect(out[3]).toMatch(/edit_file:ERR:Error: a.js changed since you last read it/);
    expect(out[5]).toMatch(/edit_file:ok/);
    expect(out[6]).toMatch(/edit_file:ok/); // the session's own edit keeps the file fresh
    expect(out[7]).toMatch(/write_file:ok:Created new.js/);
    expect(out[8]).toMatch(/write_file:ERR:Error: b.js exists and was not read/);
    // The refusal handed over the content, so the repeated overwrite is now an informed one.
    expect(out[9]).toMatch(/write_file:ok:Overwrote b.js/);
    expect(readFileSync(join(ws, 'a.js'), 'utf8')).toContain('const a = 3;');
  });

  it('apply_patch is atomic across files and checkpoints support undo', async () => {
    const good = ['*** Begin Patch', '*** Update File: a.js', '-const a = 1;', '+const a = 10;', '*** Update File: b.js', '-const b = 1;', '+const b = 20;', '*** Add File: c.js', '+const c = 30;', '*** End Patch'].join('\n');
    const bad = ['*** Begin Patch', '*** Update File: a.js', '-const a = 10;', '+const a = 11;', '*** Update File: b.js', '-NOT THERE', '+x', '*** End Patch'].join('\n');
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'a.js' }), call('read_file', { path: 'b.js' }), call('apply_patch', { patch: good })] },
        { text: '', toolCalls: [call('apply_patch', { patch: bad })] },
        { text: 'done', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'patch');
    await host.wait(s.id);
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[2].output).toBe('M a.js\nM b.js\nA c.js');
    expect(results[3].isError).toBe(true);
    // Atomic: the failing second hunk left a.js untouched.
    expect(readFileSync(join(ws, 'a.js'), 'utf8')).toBe('const a = 10;\n');
    expect(host.listCheckpoints(s.id)).toHaveLength(1);
    const u = host.undo(s.id);
    expect(u.undone).toEqual(['cp-0001']);
    expect(readFileSync(join(ws, 'a.js'), 'utf8')).toBe('const a = 1;\n');
    expect(existsSync(join(ws, 'c.js'))).toBe(false);
    expect(host.getEvents(s.id).at(-1)).toMatchObject({ type: 'user/message', source: 'system' });
    expect(() => host.undo(s.id, { to: 'cp-0001' })).toThrow(/No undoable/);
  });

  it('capability gating hides tools whose backend is unavailable', async () => {
    const provider = new MockProvider([{ text: 'ok', toolCalls: [] }]);
    const plugin = homePath('plugins', 'availability-fixture');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'index.mjs'), `export default api => {
      for (const [name, ready] of [['dead_tool', false], ['live_tool', true]]) {
        api.registerTool({ name, description: name, parameters: { type: 'object' }, risk: 'read',
          available: async () => ready, execute: async () => '' });
      }
    };`);
    const host = new HarnessHost({ config: testConfig(), providerFactory: () => ({ provider, model: 'm' }), connectMcp: false, shellHooks: false });
    await host.init();
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hi');
    await host.wait(s.id);
    const names = provider.requests[0].tools.map((t) => t.name);
    expect(names).toContain('live_tool');
    expect(names).not.toContain('dead_tool');
  });
});

describe('eval runner', () => {
  beforeEach(() => tempHome());

  it('validates a suite and scores a run from the session log', async () => {
    const suite = mkdtempSync(join(tmpdir(), 'sun-suite-'));
    const t = join(suite, 'fix-it');
    mkdirSync(join(t, 'repo'), { recursive: true });
    mkdirSync(join(t, 'hidden'));
    writeFileSync(join(t, 'task.json'), JSON.stringify({ id: 'fix-it', title: 'Fix', category: 'bugfix', language: 'sh', prompt: 'make value.txt say 2' }));
    writeFileSync(join(t, 'repo', 'value.txt'), '1\n');
    writeFileSync(join(t, 'check.sh'), 'test "$(cat value.txt)" = 2\n');
    writeFileSync(join(t, 'solution.sh'), 'echo 2 > value.txt\n');
    expect(validateSuite(suite)).toEqual([expect.objectContaining({ id: 'fix-it', ok: true, failsUntouched: true, solvable: true })]);

    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('edit_file', { path: 'value.txt', old_string: 'NOT IN THE FILE', new_string: '2' })] },
        { text: '', toolCalls: [call('read_file', { path: 'value.txt' }), call('write_file', { path: 'value.txt', content: '2\n' })] },
        { text: 'done', toolCalls: [] },
      ],
    });
    const run = await runEval({ host, suiteDir: suite, label: 'unit', concurrency: 1 });
    expect(run.summary).toMatchObject({ tasks: 1, passed: 1, passRate: 1 });
    expect(run.results[0]).toMatchObject({ steps: 3, toolCalls: 3, toolErrors: 1, editCalls: 2, editFailures: 1 });
    expect(run.summary.editFailureRate).toBe(0.5);
  });
});

describe('loop breakers', () => {
  beforeEach(() => tempHome());

  it('shows the whole file after a second miss and flags identical failing calls', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'm.js'), 'export const a = 1;\nexport const b = 2;\n');
    const bad = { path: 'm.js', old_string: 'export const c = 3;', new_string: 'x' };
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'm.js' }), call('edit_file', bad)] },
        { text: '', toolCalls: [call('edit_file', bad)] },
        { text: '', toolCalls: [call('edit_file', bad)] },
        { text: 'giving up', toolCalls: [] },
      ],
    }, { verify: { enabled: false, maxAttempts: 0, timeoutMs: 1000 } });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'edit');
    await host.wait(s.id);
    const errs = (host.getEvents(s.id).filter((e) => e.type === 'tool/result' && e.name === 'edit_file') as any[]).map((r) => r.output);
    expect(errs[0]).toMatch(/old_string not found/);
    expect(errs[0]).not.toMatch(/\[harness\]/);
    expect(errs[1]).toMatch(/miss 2 in a row[\s\S]*1\|export const a = 1;[\s\S]*write_file/);
    expect(errs[1]).toMatch(/has now failed 2 times/);
    expect(errs[2]).toMatch(/has now failed 3 times/);
  });
});
