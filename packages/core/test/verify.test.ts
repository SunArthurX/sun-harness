import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HarnessHost, MockProvider, detectVerifyCommands, homePath } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

describe('verify loop (done gate)', () => {
  let ws: string;
  beforeEach(() => {
    tempHome();
    ws = tempWorkspace();
    writeFileSync(join(ws, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'node check.mjs' } }));
    writeFileSync(join(ws, 'check.mjs'), "import { readFileSync } from 'node:fs';\nif (readFileSync('value.txt', 'utf8').trim() !== 'good') { console.error('value.txt must say good'); process.exit(1); }\n");
    writeFileSync(join(ws, 'value.txt'), 'start\n');
  });

  it('feeds a failing verification back to the model and finishes when it passes', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'value.txt' }), call('write_file', { path: 'value.txt', content: 'bad\n' })] },
        { text: 'Done!', toolCalls: [] },
        { text: '', toolCalls: [call('write_file', { path: 'value.txt', content: 'good\n' })] },
        { text: 'Fixed and verified.', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'set the value');
    expect((await host.wait(s.id))?.status).toBe('idle');
    const ev = host.getEvents(s.id);
    const verifies = ev.filter((e) => e.type === 'verify/result') as any[];
    expect(verifies.map((v) => v.passed)).toEqual([false, true]);
    const feedback = ev.find((e) => e.type === 'user/message' && e.source === 'verify') as any;
    expect(feedback.text).toContain('value.txt must say good');
    expect(feedback.text).toContain('$ npm test --silent');
    expect(providers.get('mock/a')!.requests).toHaveLength(4);
  });

  it('stops after maxAttempts and does not verify when nothing was edited', async () => {
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('read_file', { path: 'value.txt' }), call('write_file', { path: 'value.txt', content: 'bad\n' })] },
          { text: 'done', toolCalls: [] },
          { text: '', toolCalls: [call('write_file', { path: 'value.txt', content: 'still bad\n' })] },
          { text: 'done again', toolCalls: [] },
          { text: 'chat only', toolCalls: [] },
        ],
      },
      { verify: { enabled: true, maxAttempts: 1, timeoutMs: 30_000 } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'go');
    await host.wait(s.id);
    let ev = host.getEvents(s.id);
    expect(ev.filter((e) => e.type === 'verify/result').map((e: any) => e.passed)).toEqual([false, false]);
    expect(ev.filter((e) => e.type === 'user/message' && e.source === 'verify')).toHaveLength(1);
    await host.send(s.id, 'just chat');
    await host.wait(s.id);
    ev = host.getEvents(s.id);
    expect(ev.filter((e) => e.type === 'verify/result')).toHaveLength(2);
  });

  it('detects verify commands from project conventions, and .sun/project.json overrides them', () => {
    expect(detectVerifyCommands(ws)).toEqual(['npm test --silent']);
    const py = tempWorkspace();
    mkdirSync(join(py, 'tests'));
    writeFileSync(join(py, 'tests', 'test_x.py'), '');
    expect(detectVerifyCommands(py)[0]).toMatch(/pytest|unittest discover -s tests/);
    const node = tempWorkspace();
    writeFileSync(join(node, 'a.test.mjs'), '');
    expect(detectVerifyCommands(node)).toEqual(['node --test']);
    mkdirSync(join(node, '.sun'));
    writeFileSync(join(node, '.sun', 'project.json'), JSON.stringify({ verify: ['make check'] }));
    expect(detectVerifyCommands(node)).toEqual(['make check']);
    expect(detectVerifyCommands(tempWorkspace())).toEqual([]);
  });
});

describe('parallel read-only tool calls', () => {
  beforeEach(() => tempHome());
  it('runs consecutive read calls concurrently and logs them in order', async () => {
    const provider = new MockProvider([{ text: '', toolCalls: [call('slow_read', { n: 1 }), call('slow_read', { n: 2 }), call('slow_read', { n: 3 })] }, { text: 'ok', toolCalls: [] }]);
    const plugin = homePath('plugins', 'parallel-fixture');
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'index.mjs'), `export default api => api.registerTool({
      name: 'slow_read', description: 'Fixture', parameters: { type: 'object' }, risk: 'read',
      execute: async ({ n }) => {
        await new Promise(resolve => setTimeout(resolve, 250 - n * 50));
        return 'r' + n;
      },
    });`);
    const host = new HarnessHost({ config: testConfig(), providerFactory: () => ({ provider, model: 'm' }), connectMcp: false, shellHooks: false });
    await host.init();
    const s = host.createSession({ cwd: tempWorkspace() });
    const t0 = Date.now();
    await host.send(s.id, 'go');
    await host.wait(s.id);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[]).map((r) => r.output)).toEqual(['r1', 'r2', 'r3']);
  });
});
