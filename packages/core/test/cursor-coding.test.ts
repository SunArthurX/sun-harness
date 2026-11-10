import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { BUILTIN_TOOLS, clearCodebaseIndex, expandMentions, pathIgnored, ruleGlobsMatch, searchCodebase } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

describe('ignore files and rule globs', () => {
  it('matches gitignore-like patterns and Cursor rule globs', () => {
    expect(pathIgnored(['secret.ts', 'keys/**', '!keys/public.txt'], 'secret.ts')).toBe(true);
    expect(pathIgnored(['secret.ts', 'keys/**', '!keys/public.txt'], 'keys/a.pem')).toBe(true);
    expect(pathIgnored(['secret.ts', 'keys/**', '!keys/public.txt'], 'keys/public.txt')).toBe(false);
    expect(pathIgnored(['*.pem'], 'src/a.ts')).toBe(false);
    expect(ruleGlobsMatch('*.ts', 'a.ts')).toBe(true);
    expect(ruleGlobsMatch('*.ts', 'src/a.ts')).toBe(false);
    expect(ruleGlobsMatch('src/**/*.ts, scripts/**/*.mjs', 'src/a.ts')).toBe(true);
    expect(ruleGlobsMatch('src/**/*.ts', 'src/pkg/a.ts')).toBe(true);
  });

  it('refuses to read an ignored file and skips it in @mentions', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, '.cursorignore'), 'secret.ts\n');
    writeFileSync(join(ws, 'secret.ts'), 'export const token = "sk-live";\n');
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
    const read = BUILTIN_TOOLS.find((t) => t.name === 'read_file')!;
    await expect(read.execute({ path: 'secret.ts' }, { cwd: ws, sessionId: 's', signal: new AbortController().signal, services: {} })).rejects.toThrow(/cursorignore/);
    const mentioned = expandMentions('open @secret.ts and @src/a.ts', ws);
    expect(mentioned.text).toContain('ignored by .cursorignore');
    expect(mentioned.text).toContain('export const a = 1');
    expect(mentioned.text).not.toContain('sk-live');
  });
});

describe('codebase search and cursor mentions', () => {
  it('finds a symbol and a phrase, and expands @codebase, @rule, and @git', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'), { recursive: true });
    mkdirSync(join(ws, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(ws, 'src', 'pay.ts'), '/** unique-ledger-token */\nexport function chargeInvoice(id: string) {\n  return id;\n}\n');
    writeFileSync(join(ws, '.cursor', 'rules', 'api.mdc'), '---\nalwaysApply: false\n---\nNever log tokens.\n');
    clearCodebaseIndex(ws);
    const symbol = searchCodebase(ws, 'chargeInvoice');
    expect(symbol[0]).toMatchObject({ path: 'src/pay.ts', line: 2 });
    const phrase = searchCodebase(ws, 'unique-ledger-token');
    expect(phrase.some((h) => h.path === 'src/pay.ts' && h.text.includes('unique-ledger-token'))).toBe(true);
    const text = expandMentions('@codebase chargeInvoice\n@rule api\n@git', ws).text;
    expect(text).toContain('src/pay.ts:2');
    expect(text).toContain('Never log tokens.');
    expect(text).toContain('<attached git>');
  });
});

describe('file-scoped rules and /review', () => {
  beforeEach(() => tempHome());

  it('attaches a glob rule after the matching file is read', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    mkdirSync(join(ws, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(ws, '.cursor', 'rules', 'ts.mdc'), '---\nglobs: src/**/*.ts\ndescription: TypeScript style\n---\nUse named exports only.\n');
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('read_file', { path: 'src/a.ts' })] }, { text: 'read it', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws, mode: 'coding' });
    await host.send(s.id, 'read the file');
    await host.wait(s.id);
    const headers = host.getEvents(s.id).filter((e) => e.type === 'request/header');
    expect(headers[0] && headers[0].type === 'request/header' && headers[0].systemPrompt).not.toContain('Use named exports only.');
    const last = headers.at(-1);
    expect(last && last.type === 'request/header' && last.systemPrompt).toContain('Use named exports only.');
  });

  it('reviews the session diff and logs the report', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    const { host, providers } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('write_file', { path: 'src/a.ts', content: 'export const a = 2;\n' })] }, { text: 'done', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws, mode: 'coding' });
    expect(await host.reviewSession(s.id)).toBe('No file changes to review.');
    await host.send(s.id, 'add a');
    await host.wait(s.id);
    providers.get('mock/a')!.push({ text: '{"findings":[]}', toolCalls: [] });
    expect(await host.reviewSession(s.id)).toBe('No findings in the reviewed changes.');
    expect(host.getEvents(s.id)).toContainEqual(expect.objectContaining({ type: 'review/report', review: expect.objectContaining({ state: 'passed' }) }));
  });

  it('logs the exact provider request before dispatch and makes an edited result stale', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'AGENTS.md'), 'Review global invariants in the diff.');
    const { host, providers } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('write_file', { path: 'calc.js', content: 'export const total = 0;\n' })] }, { text: 'done', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws, mode: 'coding' });
    await host.send(s.id, 'change calculation');
    await host.wait(s.id);
    const finding = { id: 'total', severity: 'high', path: 'calc.js', startLine: 1, endLine: 1,
      title: 'Constant total', explanation: 'The result is always zero.', evidence: 'export const total = 0;' };
    providers.get('mock/a')!.push(request => {
      const recorded = host.getEvents(s.id).find(e => e.type === 'review/request');
      const { signal: _signal, onDelta: _onDelta, ...wire } = request;
      expect(recorded).toMatchObject({ type: 'review/request', modelRef: 'mock/a', request: wire });
      expect(JSON.stringify(wire.messages)).toContain('Review global invariants');
      expect(wire.tools).toEqual([]);
      host.renameSession(s.id, 'Renamed during review');
      return { text: JSON.stringify({ findings: [finding] }), toolCalls: [] };
    });
    await host.reviewSession(s.id);
    const status = host.reviewStatus(s.id);
    expect(status).toMatchObject({ state: 'findings', report: { findings: [finding], omissions: [] } });
    const log = host.getEvents(s.id);
    expect(log.map(event => event.seq)).toEqual(log.map((_, i) => i));
    expect(log.at(-2)).toMatchObject({ type: 'session/title', title: 'Renamed during review' });
    const request = log.find(e => e.type === 'review/request')!;
    expect(status.report?.requestSeq).toBe(request.seq);
    writeFileSync(join(ws, 'calc.js'), 'export const total = 1;\n');
    expect(host.reviewStatus(s.id)).toMatchObject({ state: 'stale', report: { findings: [finding] } });
    const imported = host.importSession(host.exportSession(s.id, 'jsonl'), { cwd: ws });
    expect(host.getEvents(imported.id)).toContainEqual(expect.objectContaining({ type: 'review/report', text: expect.stringContaining('Constant total') }));
  });

  it('rejects paths, unchanged lines and fabricated evidence without publishing findings', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'calc.js'), 'const first = 1;\nconst total = 1;\n');
    const { host, providers } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [
        call('read_file', { path: 'calc.js' }),
        call('write_file', { path: 'calc.js', content: 'const first = 1;\nconst total = 2;\n' }),
      ] }, { text: 'done', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws, mode: 'coding' });
    await host.send(s.id, 'change calculation');
    await host.wait(s.id);
    const valid = { id: 'f', severity: 'high', path: 'calc.js', startLine: 2, endLine: 2, title: 'Issue',
      explanation: 'An issue on this line.', evidence: 'const total = 2;' };
    for (const override of [
      { path: '../calc.js' }, { startLine: 1, endLine: 1, evidence: 'const first = 1;' },
      { startLine: 2, endLine: 4 }, { evidence: 'fabricated code' }, { severity: 'urgent' },
    ]) {
      providers.get('mock/a')!.push({ text: JSON.stringify({ findings: [{ ...valid, ...override }] }), toolCalls: [] });
      await host.reviewSession(s.id);
      expect(host.reviewStatus(s.id)).toMatchObject({ state: 'failed', report: { error: 'INVALID_RESPONSE', findings: [] } });
    }
    providers.get('mock/a')!.push({ text: JSON.stringify({ findings: [valid] }), toolCalls: [] });
    await host.reviewSession(s.id);
    expect(host.reviewStatus(s.id)).toMatchObject({ state: 'findings', report: { findings: [valid] } });
  });

  it('pauses a coding run when the candidate exceeds the review budget and can resume after a complete review', async () => {
    const ws = tempWorkspace();
    const { host, providers } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('write_file', { path: 'big.js', content: 'x'.repeat(1024) + '\n' })] }, { text: 'done', toolCalls: [] }],
    }, { review: { model: '', minimumSeverity: 'high', rules: 'none', diffBytes: 512, completionGate: true } });
    const s = host.createSession({ cwd: ws, mode: 'coding' });
    await host.send(s.id, 'write a file');
    expect(await host.wait(s.id)).toMatchObject({ status: 'paused', reason: 'review_required' });
    expect(host.reviewStatus(s.id)).toMatchObject({ state: 'incomplete', report: {
      findings: [], omissions: [{ path: 'big.js', reason: 'over-budget' }],
    } });
    expect(providers.get('mock/a')!.requests).toHaveLength(2);
    writeFileSync(join(ws, 'big.js'), 'small file\n');
    providers.get('mock/a')!.push({ text: '{"findings":[]}', toolCalls: [] });
    host.resume(s.id);
    expect(await host.wait(s.id)).toMatchObject({ status: 'idle' });
    expect(host.reviewStatus(s.id)).toMatchObject({ state: 'passed' });
    const events = host.getEvents(s.id);
    expect(events.map(e => e.seq)).toEqual(events.map((_, i) => i));
  });

  it('lists the workspace for the Files pane and refuses to leave it', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
    const { host } = await mockHost({ 'mock/a': [] });
    const s = host.createSession({ cwd: ws });
    expect(host.listWorkspace(s.id, 'src')).toEqual([{ name: 'a.ts', dir: false }]);
    expect(() => host.listWorkspace(s.id, '..')).toThrow(/workspace/);
  });
});
