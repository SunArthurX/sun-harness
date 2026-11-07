import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, completePaths, expandCommand, expandMentions, loadCommands, priceOf, sessionCost, supportsVision, testable, unifiedDiff } from './ux-imports.js';
import { call, mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

describe('custom slash commands', () => {
  beforeEach(() => tempHome());

  it('loads project, user and compat commands with frontmatter and fills arguments', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun', 'commands', 'git'), { recursive: true });
    mkdirSync(join(ws, '.claude', 'commands'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'commands', 'review.md'), '---\ndescription: Review a file\nargument-hint: <file>\nmode: plan\n---\nReview $1 for bugs. Focus: $ARGUMENTS\n');
    writeFileSync(join(ws, '.sun', 'commands', 'git', 'pr.md'), 'Write a PR description for the current branch.\n');
    writeFileSync(join(ws, '.claude', 'commands', 'review.md'), 'shadowed by .sun\n');
    writeFileSync(join(ws, '.claude', 'commands', 'explain.md'), '# Explain the code\nExplain it simply.');
    const cmds = loadCommands(ws);
    expect(cmds.map((c) => `${c.name}:${c.scope}`)).toEqual(['explain:compat', 'git:pr:project', 'review:project']);
    expect(cmds.find((c) => c.name === 'explain')!.description).toBe('Explain the code');
    const r = expandCommand('/review src/a.ts "error handling"', cmds)!;
    expect(r.prompt).toBe('Review src/a.ts for bugs. Focus: src/a.ts "error handling"');
    expect(r.command.mode).toBe('plan');
    expect(expandCommand('/git:pr', cmds)!.prompt).toBe('Write a PR description for the current branch.');
    expect(expandCommand('/explain the parser', cmds)!.prompt).toBe('# Explain the code\nExplain it simply.\n\nthe parser');
    expect(expandCommand('/unknown x', cmds)).toBeUndefined();
  });

  it('expands commands in sessions, switches mode, and logs what was typed', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun', 'commands'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'commands', 'plan-it.md'), '---\nmode: plan\n---\nMake a plan for: $ARGUMENTS');
    const { host, providers } = await mockHost({ 'mock/a': [{ text: 'here is a plan', toolCalls: [] }] });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, '/plan-it add CSV export');
    await host.wait(s.id);
    const msg = host.getEvents(s.id).find((e) => e.type === 'user/message') as any;
    expect(msg.text).toBe('Make a plan for: add CSV export');
    expect(msg.command).toEqual({ name: 'plan-it', input: '/plan-it add CSV export' });
    expect(host.getEvents(s.id).some((e) => e.type === 'mode/switch' && (e as any).to === 'plan')).toBe(true);
    expect(providers.get('mock/a')!.requests[0].messages.at(-1)!.content).toBe('Make a plan for: add CSV export');
  });
});

describe('@mentions and path completion', () => {
  it('attaches files, lists folders, collects images, ignores emails and outside paths', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src'));
    writeFileSync(join(ws, 'src', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(join(ws, 'shot.png'), PNG);
    const r = expandMentions('look at @src/a.ts and @src/ and @shot.png, mail me@x.com, not @../etc/passwd or @missing.ts', ws);
    expect(r.text).toContain('<attached file="src/a.ts">\nexport const a = 1;\n\n</attached>');
    expect(r.text).toContain('<attached dir="src/">\na.ts\n</attached>');
    expect(r.images).toEqual([join(ws, 'shot.png')]);
    expect(r.text).not.toContain('<attached file="../');
    expect(r.files).toHaveLength(2);
    expect(expandMentions('Document @src/a.ts.', ws).files).toEqual([join(ws, 'src', 'a.ts')]);
  });

  it('completes paths by prefix, base name, and subsequence', () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, 'src', 'lib'), { recursive: true });
    writeFileSync(join(ws, 'src', 'lib', 'parser.ts'), '');
    writeFileSync(join(ws, 'README.md'), '');
    expect(completePaths(ws, 'src/')[0]).toBe('src/');
    expect(completePaths(ws, 'pars')).toContain('src/lib/parser.ts');
    expect(completePaths(ws, 'slp')).toContain('src/lib/parser.ts');
    expect(completePaths(ws, 'zzz')).toEqual([]);
  });
});

describe('diffs, pricing, vision', () => {
  it('produces a unified diff with context', () => {
    const d = unifiedDiff('a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nb\nc\nd\nE\nf\ng\nh\n', 'x.txt');
    expect(d).toBe(['--- a/x.txt', '+++ b/x.txt', '@@ -2,7 +2,7 @@', ' b', ' c', ' d', '-e', '+E', ' f', ' g', ' h'].join('\n'));
    expect(unifiedDiff('same', 'same', 'x')).toBe('');
    expect(unifiedDiff('', 'new\n', 'n.txt')).toContain('+new');
  });

  it('prices sessions with cache discounts and prefix rules', () => {
    expect(priceOf('anthropic/claude-sonnet-4-5', DEFAULT_PRICING)?.input).toBe(3);
    const events: any[] = [
      { type: 'assistant/message', model: 'deepseek/deepseek-chat', usage: { inputTokens: 1_000_000, cachedTokens: 900_000, outputTokens: 100_000 } },
      { type: 'assistant/message', model: 'mystery/model', usage: { inputTokens: 10, outputTokens: 1 } },
    ];
    const c = sessionCost(events, DEFAULT_PRICING);
    expect(c.usd).toBeCloseTo((100_000 * 0.28 + 900_000 * 0.028 + 100_000 * 0.42) / 1e6, 6);
    expect(c.unpriced).toEqual(['mystery/model']);
  });

  it('knows which models see images', () => {
    const cfg = testConfig();
    expect(supportsVision(cfg, 'qwen/qwen3-vl-plus')).toBe(true);
    expect(supportsVision(cfg, 'anthropic/claude-sonnet-4-5')).toBe(true);
    expect(supportsVision(cfg, 'deepseek/deepseek-chat')).toBe(false);
    expect(supportsVision({ ...cfg, providers: { ...cfg.providers, deepseek: { ...cfg.providers.deepseek, vision: true } } }, 'deepseek/deepseek-chat')).toBe(true);
  });
});

describe('sessions: images, diffs on tool results, cost, rewind, export/import, search, compact', () => {
  beforeEach(() => tempHome());

  it('stores pasted images as attachments and sends them only to vision models', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'ui.png'), PNG);
    const { host, providers } = await mockHost({ 'mock/a': [{ text: 'I see it', toolCalls: [] }, { text: 'text only', toolCalls: [] }] }, { providers: { ...testConfig().providers, mock: { type: 'openai', baseUrl: 'x', noKey: true, models: ['a'], vision: ['a'] } } });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'what is wrong in @ui.png', 'user', { images: [{ data: PNG.toString('base64'), mime: 'image/png' }] });
    await host.wait(s.id);
    const msg = host.getEvents(s.id).find((e) => e.type === 'user/message') as any;
    expect(msg.images).toHaveLength(2);
    expect(readFileSync(msg.images[0].path)).toEqual(PNG);
    expect(providers.get('mock/a')!.requests[0].messages.at(-1)!.images).toHaveLength(2);
    host.switchModel(s.id, 'mock/b');
    providers.set('mock/b', new (providers.get('mock/a')!.constructor as any)([{ text: 'no vision', toolCalls: [] }], 'mock/b'));
    await host.send(s.id, 'and now?');
    await host.wait(s.id);
    const req = providers.get('mock/b')!.requests[0];
    expect(req.messages.find((m: any) => m.role === 'user')!.content).toMatch(/2 image\(s\) attached; mock\/b cannot see images/);
    expect(req.messages.some((m: any) => m.images)).toBe(false);
  });

  it('logs diffs for edits, estimates cost, rewinds with file restore, exports and imports, searches', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'a.txt'), 'one\n');
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('write_file', { path: 'b.txt', content: 'first\n' })] },
          { text: 'wrote b', toolCalls: [], usage: { inputTokens: 1000, outputTokens: 100 } },
          { text: '', toolCalls: [call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' })] },
          { text: 'edited a', toolCalls: [] },
        ],
      },
      { verify: { enabled: false, maxAttempts: 0, timeoutMs: 1000 }, pricing: { 'mock/a': { input: 1, output: 2 } } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'create b');
    await host.wait(s.id);
    await host.send(s.id, 'now change a — needle phrase');
    await host.wait(s.id);
    const edit = host.getEvents(s.id).find((e) => e.type === 'tool/result' && e.name === 'edit_file') as any;
    expect(edit.diff).toContain('-one\n+two');
    expect(host.cost(s.id).usd).toBeCloseTo((1000 * 1 + 100 * 2) / 1e6, 9);

    const second = host.getEvents(s.id).filter((e) => e.type === 'user/message')[1];
    const r = host.fork(s.id, { beforeSeq: second.seq, restoreFiles: true });
    expect(r.text).toBe('now change a — needle phrase');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('one\n');
    expect(readFileSync(join(ws, 'b.txt'), 'utf8')).toBe('first\n');
    const forked = host.getEvents(r.session.id);
    expect((forked[0] as any).forkOf).toEqual({ session: s.id, seq: second.seq });
    expect(forked.filter((e) => e.type === 'user/message').map((e: any) => e.text)).toEqual(['create b']);
    expect(host.listCheckpoints(r.session.id)).toHaveLength(1);

    const md = host.exportSession(s.id, 'markdown');
    expect(md).toMatch(/## User\n\ncreate b/);
    expect(md).toContain('```diff');
    expect(host.exportSession(s.id, 'html')).toMatch(/^<!doctype html>[\s\S]*<h2>User<\/h2>/);
    const imported = host.importSession(host.exportSession(s.id, 'jsonl'));
    expect(imported.id).not.toBe(s.id);
    // 2 typed messages + the note the undo appended to the original session.
    expect(host.getEvents(imported.id).filter((e) => e.type === 'user/message')).toHaveLength(3);

    expect(host.searchSessions('needle phrase').map((x) => x.id)).toEqual(expect.arrayContaining([s.id, imported.id]));
    expect(host.searchSessions('needle phrase')[0].snippet).toContain('needle phrase');
    expect(testable).toBe(true);
  });

  it('compacts on demand', async () => {
    const ws = tempWorkspace();
    const steps = Array.from({ length: 8 }, (_, i) => ({ text: `answer ${i}`, toolCalls: [] }));
    const { host } = await mockHost({ 'mock/a': [...steps, { text: 'SUMMARY of the chat', toolCalls: [] }] }, { compaction: { ...testConfig().compaction, keepRecent: 2 } });
    const s = host.createSession({ cwd: ws });
    for (let i = 0; i < 8; i++) {
      await host.send(s.id, `question ${i}`);
      await host.wait(s.id);
    }
    expect(await host.compact(s.id)).toBe(true);
    const c = host.getEvents(s.id).find((e) => e.type === 'context/compaction') as any;
    expect(c.summary).toBe('SUMMARY of the chat');
  });
});

describe('bots: custom commands and /cost', () => {
  beforeEach(() => tempHome());

  it('expands a custom command typed in chat and answers /cost', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun', 'commands'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'commands', 'standup.md'), 'Summarize yesterday for my standup: $ARGUMENTS');
    const { host } = await mockHost({ 'mock/a': [{ text: 'done', toolCalls: [] }] });
    const said: string[] = [];
    const { BotBridge } = await import('../src/bots/bridge.js');
    const bridge = new BotBridge(host, { platform: 'test', maxLength: 4000, send: async (_c: string, t: string) => void said.push(t) } as any, { defaultMode: 'assistant', approvals: 'deny', allowedUsers: ['u'], cwd: ws });
    await bridge.handle({ chatId: 'c', userId: 'u', text: '/standup billing service' });
    const sid = bridge.sessionOf('c')!;
    await host.wait(sid);
    expect((host.getEvents(sid).find((e) => e.type === 'user/message') as any).text).toBe('Summarize yesterday for my standup: billing service');
    await bridge.handle({ chatId: 'c', userId: 'u', text: '/cost' });
    expect(said.at(-1)).toMatch(/mock\/a|No usage yet/);
  });
});
