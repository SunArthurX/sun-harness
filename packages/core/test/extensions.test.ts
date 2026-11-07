import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  HarnessHost,
  LocalMarkdownKB,
  McpManager,
  MockProvider,
  acceptProposal,
  addProposal,
  addSchedule,
  dueTasks,
  homePath,
  listProposals,
  loadPlugins,
  loadProjectContext,
  parseCron,
  readMemory,
  saveMemoryFact,
  tokenize,
} from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('rules loader (anti-drift context)', () => {
  beforeEach(() => tempHome());

  it('collects AGENTS.md hierarchy, .sun/rules, cursor rules and specs', () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'AGENTS.md'), '# Root rules\nUse English.');
    writeFileSync(join(ws, 'CLAUDE.md'), 'ignored because AGENTS.md exists');
    mkdirSync(join(ws, 'pkg'));
    writeFileSync(join(ws, 'pkg', 'CLAUDE.md'), 'Package rule');
    mkdirSync(join(ws, '.sun', 'rules'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'rules', 'style.md'), 'Prefer small functions.');
    writeFileSync(join(ws, '.sun', 'rules', 'db.md'), '---\nalwaysApply: false\ndescription: Database migrations\n---\nUse migrations.');
    mkdirSync(join(ws, '.cursor', 'rules'), { recursive: true });
    writeFileSync(join(ws, '.cursor', 'rules', 'a.mdc'), '---\nalwaysApply: true\n---\nCursor rule');
    mkdirSync(join(ws, 'specs'));
    writeFileSync(join(ws, 'specs', '001-x.md'), '# 001 — Feature X\n');
    writeFileSync(homePath('AGENTS.md'), 'Global rule');

    const ctx = loadProjectContext(join(ws, 'pkg'));
    const sources = ctx.rules.map((r) => r.source);
    expect(sources).toEqual(['~/.sun/AGENTS.md (global)', './AGENTS.md', 'pkg/CLAUDE.md', '.sun/rules/style.md', '.cursor/rules/a.mdc']);
    expect(ctx.optionalRules[0]).toMatchObject({ description: 'Database migrations' });
    expect(ctx.specs).toEqual([{ path: 'specs/001-x.md', title: '001 — Feature X' }]);
  });

  it('puts rules, specs, skills and memory into the system prompt', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'AGENTS.md'), 'RULE-MARKER');
    mkdirSync(join(ws, '.sun', 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: How to deploy\n---\nStep 1: build.');
    saveMemoryFact('User prefers pnpm', 'Preferences');
    const { host, providers } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('load_skill', { name: 'deploy' })] }, { text: 'ok', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'deploy please');
    await host.wait(s.id);
    const req = providers.get('mock/a')!.requests[0];
    expect(req.system).toContain('RULE-MARKER');
    expect(req.system).toContain('- deploy: How to deploy');
    expect(req.system).toContain('User prefers pnpm');
    const res = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(res.output).toContain('Step 1: build.');
    // The system prompt is logged (model-visible means logged).
    expect(host.getEvents(s.id).find((e) => e.type === 'request/header')).toMatchObject({ systemPrompt: req.system });
  });
});

describe('knowledge base', () => {
  beforeEach(() => tempHome());

  it('tokenizes CJK into bigrams', () => {
    expect(tokenize('知识库 search')).toEqual(['search', '知识', '识库']);
  });

  it('ranks markdown chunks with BM25 and supports adding notes', async () => {
    const root = homePath('kb');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'rust.md'), '# Rust notes\n\n## Ownership\nBorrow checker rules and lifetimes.\n\n## Async\nTokio runtime.');
    writeFileSync(join(root, 'cooking.md'), '# Cooking\n\nHow to make 红烧肉 with soy sauce.');
    const kb = new LocalMarkdownKB([root]);
    const hits = await kb.search('borrow checker lifetimes', 3);
    expect(hits[0].title).toBe('Rust notes › Ownership');
    const zh = await kb.search('红烧肉', 3);
    expect(zh[0].source).toContain('cooking.md');
    const file = await kb.add('Harness idea', 'Use append-only logs.');
    expect(readFileSync(file, 'utf8')).toContain('append-only');
    expect((await kb.search('append-only logs', 1))[0].source).toBe(file);
    expect((await kb.stats()).documents).toBe(3);
  });

  it('kb_search tool works through the host, company provider is reserved/off by default', async () => {
    mkdirSync(homePath('kb'), { recursive: true });
    writeFileSync(join(homePath('kb'), 'n.md'), '# Note\nThe secret word is pineapple.');
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('kb_search', { query: 'secret word' })] }, { text: 'ok', toolCalls: [] }] });
    expect(host.knowledgeProviders().map((p) => p.id)).toEqual(['personal']);
    const s = host.createSession({ cwd: tempWorkspace() });
    await host.send(s.id, 'what is the secret word');
    await host.wait(s.id);
    expect((host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output).toContain('pineapple');
  });
});

describe('memory', () => {
  beforeEach(() => tempHome());
  it('appends facts under sections and dedupes', () => {
    saveMemoryFact('Name is Arthur', 'Profile');
    saveMemoryFact('Likes TypeScript', 'Preferences');
    saveMemoryFact('Works on sun-harness', 'Profile');
    expect(saveMemoryFact('Name is Arthur', 'Profile')).toBe('Already remembered.');
    const m = readMemory();
    expect(m.indexOf('Works on sun-harness')).toBeLessThan(m.indexOf('## Preferences'));
  });
});

describe('schedules', () => {
  beforeEach(() => tempHome());
  it('parses cron and finds due tasks', () => {
    const m = parseCron('*/15 9-17 * * 1-5');
    expect(m(new Date(2026, 10, 9, 9, 30))).toBe(true); // Monday
    expect(m(new Date(2026, 10, 8, 9, 30))).toBe(false); // Sunday
    expect(() => parseCron('* *')).toThrow();
    const t = addSchedule({ title: 't', prompt: 'p', at: '2020-01-01T00:00:00Z', mode: 'assistant', cwd: '/tmp' });
    expect(dueTasks([t]).map((x) => x.id)).toEqual([t.id]);
  });

  it('host runs due scheduled tasks as new sessions', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: 'Reminder delivered', toolCalls: [] }] });
    addSchedule({ title: 'drink water', prompt: 'Remind me to drink water', at: new Date(Date.now() - 1000).toISOString(), mode: 'assistant', cwd: tempWorkspace() });
    const r = await host.backgroundTick(new Date(), { intel: false });
    expect(r.scheduled).toHaveLength(1);
    await host.wait(r.scheduled[0]);
    expect(host.getEvents(r.scheduled[0]).some((e) => e.type === 'assistant/message')).toBe(true);
    expect((await host.backgroundTick(new Date(), { intel: false })).scheduled).toHaveLength(0);
  });
});

describe('evolution', () => {
  beforeEach(() => tempHome());
  it('reflects a session into proposals and applies accepted ones', async () => {
    const { host } = await mockHost({
      'mock/a': [
        { text: 'done', toolCalls: [] },
        {
          text:
            '```json\n[{"type":"memory","title":"pnpm","content":"User prefers pnpm","rationale":"said so","section":"Preferences"},' +
            '{"type":"skill","title":"Release flow","content":"1. bump\\n2. tag","rationale":"repeated","skillName":"release-flow","skillDescription":"Use when releasing"},' +
            '{"type":"rule","title":"tests","content":"Always run tests before finishing.","rationale":"forgot"}]\n```',
          toolCalls: [],
        },
      ],
    });
    const s = host.createSession({ cwd: tempWorkspace() });
    await host.send(s.id, 'I always use pnpm');
    await host.wait(s.id);
    const props = await host.reflect(s.id);
    expect(props.map((p) => p.type)).toEqual(['memory', 'skill', 'rule']);
    for (const p of props) acceptProposal(p.id);
    expect(readMemory()).toContain('User prefers pnpm');
    expect(readFileSync(homePath('skills', 'release-flow', 'SKILL.md'), 'utf8')).toContain('name: release-flow');
    expect(readFileSync(homePath('AGENTS.md'), 'utf8')).toContain('Always run tests');
    expect(host.listSkills(tempWorkspace()).some((x) => x.name === 'release-flow')).toBe(true);
    expect(listProposals('pending')).toHaveLength(0);
    expect(readFileSync(homePath('evolution', 'journal.md'), 'utf8')).toContain('accepted skill');
  });

  it('dedupes proposals by type+title', () => {
    const a = addProposal({ type: 'feature', title: 'X', content: 'c', rationale: 'r', source: { kind: 'manual', ref: '' } });
    const b = addProposal({ type: 'feature', title: 'x', content: 'c2', rationale: 'r', source: { kind: 'manual', ref: '' } });
    expect(a.id).toBe(b.id);
  });
});

describe('plugins', () => {
  beforeEach(() => tempHome());
  it('loads an ESM plugin that contributes a tool, a mode and a prompt section', async () => {
    const dir = homePath('plugins', 'hello');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.mjs'),
      `export default function (api) {
        api.registerTool({ name: 'hello', description: 'Say hello', parameters: { type: 'object', properties: { who: { type: 'string' } } }, risk: 'read',
          execute: async (a) => 'Hello, ' + a.who + '!' });
        api.registerMode({ id: 'poet', label: 'Poet', description: 'Writes poems', prompt: 'You are a poet.' });
        api.registerPromptSection('Plugin note', 'PLUGIN-MARKER');
      }`,
    );
    const broken = homePath('plugins', 'broken');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, 'index.mjs'), 'export const nothing = 1;');

    const provider = new MockProvider([{ text: '', toolCalls: [call('hello', { who: 'Arthur' })] }, { text: 'ok', toolCalls: [] }]);
    const host = new HarnessHost({ config: testConfig(), providerFactory: () => ({ provider, model: 'm' }), connectMcp: false, shellHooks: false });
    await host.init();
    expect(host.pluginStates.find((p) => p.name === 'hello')).toMatchObject({ status: 'loaded' });
    expect(host.pluginStates.find((p) => p.name === 'broken')).toMatchObject({ status: 'error' });
    expect(host.listModes().map((m) => m.id)).toContain('poet');
    const s = host.createSession({ cwd: tempWorkspace(), mode: 'poet' });
    await host.send(s.id, 'greet');
    await host.wait(s.id);
    expect((host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output).toBe('Hello, Arthur!');
    expect(provider.requests[0].system).toContain('You are a poet.');
    expect(provider.requests[0].system).toContain('PLUGIN-MARKER');
  });

  it('respects the disabled list', async () => {
    const dir = homePath('plugins', 'off');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), 'export default () => { throw new Error("should not load") }');
    const states = await loadPlugins(
      { addTool() {}, addKnowledge() {}, addMode() {}, addPrompt() {}, addListener() {} },
      { disabled: ['off'], settings: {} },
    );
    expect(states[0].status).toBe('disabled');
  });
});

describe('hooks', () => {
  beforeEach(() => tempHome());
  it('preToolUse exit 2 blocks the call; postToolUse adds context', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun'), { recursive: true });
    writeFileSync(
      join(ws, '.sun', 'hooks.json'),
      JSON.stringify({
        preToolUse: [{ matcher: '^bash$', command: 'grep -q "rm -rf" && { echo "dangerous command" >&2; exit 2; } || exit 0' }],
        postToolUse: [{ matcher: 'list_dir', command: 'echo checked-by-hook' }],
      }),
    );
    const provider = new MockProvider([
      { text: '', toolCalls: [call('bash', { command: 'rm -rf /tmp/nothing' }), call('list_dir', {})] },
      { text: 'ok', toolCalls: [] },
    ]);
    const host = new HarnessHost({ config: testConfig(), providerFactory: () => ({ provider, model: 'm' }), connectMcp: false, loadPlugins: false });
    await host.init();
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'go');
    await host.wait(s.id);
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[0].output).toContain('Blocked by hook: dangerous command');
    expect(results[1].output).toContain('checked-by-hook');
  });

  it('onFailure "block" makes a crashing policy hook fail closed; default ignores it', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun'), { recursive: true });
    writeFileSync(
      join(ws, '.sun', 'hooks.json'),
      JSON.stringify({
        preToolUse: [
          { matcher: '^list_dir$', command: 'exit 7', onFailure: 'block' },
          { matcher: '^read_file$', command: 'exit 7' },
        ],
      }),
    );
    writeFileSync(join(ws, 'a.txt'), 'A');
    const provider = new MockProvider([{ text: '', toolCalls: [call('list_dir', {}), call('read_file', { path: 'a.txt' })] }, { text: 'ok', toolCalls: [] }]);
    const host = new HarnessHost({ config: testConfig(), providerFactory: () => ({ provider, model: 'm' }), connectMcp: false, loadPlugins: false });
    await host.init();
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'go');
    await host.wait(s.id);
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[0].output).toContain('failing closed');
    expect(results[1].output).toContain('1|A');
  });
});

describe('mcp', () => {
  beforeEach(() => tempHome());
  it('connects to a stdio MCP server and exposes namespaced tools', async () => {
    const ws = tempWorkspace();
    writeFileSync(
      join(ws, '.mcp.json'),
      JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [join(here, 'fixtures', 'echo-mcp.mjs')] }, off: { command: 'nope', disabled: true } } }),
    );
    const m = new McpManager();
    await m.connectAll(ws);
    expect(m.servers.get('echo')).toMatchObject({ status: 'ready', tools: ['echo', 'slow'] });
    expect(m.servers.get('off')?.status).toBe('disabled');
    const tool = m.listTools().find((t) => t.name === 'mcp__echo__echo')!;
    expect(tool.risk).toBe('exec');
    const out = await tool.execute({ text: 'ping' }, { cwd: ws, sessionId: 's', signal: new AbortController().signal, services: {} });
    expect(out).toBe('echo: ping');
    await m.closeAll();
  });
});
