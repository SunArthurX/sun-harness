import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildContextReport, contextReportHtml, estimateTextTokens, formatContextReport } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const ev = (seq: number, body: any) => ({ seq, ts: new Date(1_800_000_000_000 + seq * 1000).toISOString(), ...body });

describe('context report', () => {
  it('breaks the next request into categories and honors compaction', () => {
    const events: any[] = [
      ev(0, { type: 'session/meta', id: 's', title: 't', mode: 'coding', cwd: '/w', model: 'm', createdAt: '' }),
      ev(1, { type: 'user/message', text: 'old question that was compacted away '.repeat(50) }),
      ev(2, { type: 'assistant/message', text: 'old answer', toolCalls: [], model: 'm' }),
      ev(3, { type: 'context/compaction', summary: 'The user asked about X.', upToSeq: 2 }),
      ev(4, { type: 'user/message', source: 'memory', text: '[Relevant memories] prefers pnpm' }),
      ev(5, { type: 'user/message', text: 'look at this\n\n<attached file="src/big.ts">\n' + 'const x = 1;\n'.repeat(400) + '</attached>', images: [{ path: '/a/1.png', mime: 'image/png' }] }),
      ev(6, { type: 'assistant/message', text: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: '{"path":"a"}' }], model: 'm', usage: { inputTokens: 9000, outputTokens: 50, cachedTokens: 6000 } }),
      ev(7, { type: 'tool/result', callId: 'c1', name: 'read_file', output: 'y'.repeat(40_000), isError: false }),
    ];
    const r = buildContextReport({
      sessionId: 's',
      model: 'm',
      window: 64_000,
      compactAt: 20_000,
      system: [
        { title: 'Coding mode instructions', text: 'You are…'.repeat(20) },
        { title: 'Project rules', text: 'rule '.repeat(4000) },
        { title: 'Skills', text: 'skill '.repeat(9000) },
      ],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
      events,
    });
    const names = r.categories.map((c) => c.name);
    expect(names).toEqual(['System prompt', 'Tool definitions', 'Compaction summary', 'User messages', 'Attached files', 'Images', 'Recalled memories', 'Assistant messages', 'Tool results']);
    expect(r.categories.find((c) => c.name === 'Attached files')!.items[0].label).toBe('src/big.ts');
    expect(r.categories.find((c) => c.name === 'Images')!.tokens).toBe(1000);
    expect(r.categories.find((c) => c.name === 'Tool results')!.items[0]).toEqual({ label: 'read_file (1×)', tokens: 10_004 });
    // The compacted turn is not counted; only its summary is.
    expect(r.categories.find((c) => c.name === 'User messages')!.tokens).toBeLessThan(100);
    expect(r.totalTokens).toBe(r.categories.reduce((s, c) => s + c.tokens, 0));
    expect(r.lastRequest).toMatchObject({ inputTokens: 9000, cachedTokens: 6000 });
    expect(r.compactions).toBe(1);
    expect(r.suggestions.join(' ')).toMatch(/compaction threshold/);
    expect(r.suggestions.join(' ')).toMatch(/read_file #7 alone/);
    expect(r.suggestions.join(' ')).toMatch(/Project rules are/);
    expect(r.suggestions.join(' ')).toMatch(/skills index is/);
    const text = formatContextReport(r);
    expect(text).toMatch(/^Context · m · \d+(\.\d)?k \/ 64k tokens/);
    expect(text).toContain('Tool results');
    expect(contextReportHtml(r)).toMatch(/^<!doctype html>[\s\S]*Suggestions/);
    expect(estimateTextTokens('你好世界')).toBe(4);
  });
});

describe('host: context usage, flags, titles', () => {
  beforeEach(() => tempHome());

  it('measures a real session, including the system prompt and tools', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'AGENTS.md'), '# Rules\nAlways write tests.\n');
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n'.repeat(100));
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('read_file', { path: 'src/a.ts' })] }, { text: 'read it', toolCalls: [], usage: { inputTokens: 1234, outputTokens: 10 } }] });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'read @src/a.ts');
    await host.wait(s.id);
    const r = await host.contextUsage(s.id);
    expect(r.categories.find((c) => c.name === 'System prompt')!.items.map((i) => i.label)).toEqual(expect.arrayContaining(['Coding mode instructions', 'Environment', 'Project rules']));
    expect(r.categories.find((c) => c.name === 'Tool definitions')!.items.length).toBeGreaterThan(5);
    expect(r.categories.find((c) => c.name === 'Attached files')!.items[0].label).toBe('src/a.ts');
    expect(r.window).toBeGreaterThan(0);
    expect(r.lastRequest?.inputTokens).toBe(1234);
    const summary = host.listSessions().find((x) => x.id === s.id)!;
    expect(summary.contextTokens).toBe(1244);
    expect(summary.contextWindow).toBe(r.window);
    expect(await host.contextReportHtml(s.id)).toContain('Context · read @src/a.ts');
  });

  it('pins and archives sessions', async () => {
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: tempWorkspace() });
    expect(host.setSessionFlags(s.id, { pinned: true })).toMatchObject({ pinned: true });
    expect(host.setSessionFlags(s.id, { archived: true })).toMatchObject({ pinned: true, archived: true });
    expect(host.setSessionFlags(s.id, { pinned: false }).pinned).toBeUndefined();
  });

  it('writes a model title after the first run, but never over a rename', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: 'Use a CSV writer.', toolCalls: [] }, { text: '"CSV export for invoices."', toolCalls: [] }] }, { titles: 'model' });
    const s = host.createSession({ cwd: tempWorkspace() });
    await host.send(s.id, 'how do I export my invoices as csv from the billing tool, step by step please');
    await host.wait(s.id);
    for (let i = 0; i < 50 && host.listSessions().find((x) => x.id === s.id)!.title.startsWith('how'); i++) await new Promise((r) => setTimeout(r, 20));
    expect(host.listSessions().find((x) => x.id === s.id)!.title).toBe('CSV export for invoices');
    const t = host.createSession({ cwd: tempWorkspace() });
    host.renameSession(t.id, 'Mine');
    expect(await host.titleSession(t.id)).toBeUndefined();
  });
});
