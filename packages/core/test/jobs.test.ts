import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { HarnessHost, JobManager, MockProvider, SessionLog, type JobResult } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace, testConfig } from './helpers.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const until = async (f: () => boolean, ms = 10_000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe('background jobs', () => {
  let ws: string;
  beforeEach(() => {
    tempHome();
    ws = tempWorkspace();
  });

  it('bash background returns at once and the result is delivered into the session later', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('bash', { command: 'sleep 0.4; echo build ok', background: true })] },
        { text: 'Build started; I will report when it ends.', toolCalls: [] },
        { text: 'The build finished: build ok', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'build it');
    expect((await host.wait(s.id))?.status).toBe('idle');
    const started = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(started.output).toMatch(/Started background job job-/);
    expect(host.getEvents(s.id).some((e) => e.type === 'job/started')).toBe(true);

    await until(() => host.getEvents(s.id).some((e) => e.type === 'job/finished'));
    await until(() => !host.isRunning(s.id) && providers.get('mock/a')!.requests.length === 3);
    const delivered = host.getEvents(s.id).find((e) => e.type === 'user/message' && e.source === 'job') as any;
    expect(delivered.text).toContain('build ok');
    expect(delivered.text).toMatch(/done \(exit 0\)/);
    expect(SessionLog.open(s.id).last('assistant/message')?.text).toContain('build ok');
  });

  it('job_status shows output; job_kill stops a job without a delivery run', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('bash', { command: 'echo started; sleep 30', background: true })] },
        { text: 'running', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'serve');
    await host.wait(s.id);
    const [job] = host.listJobs(s.id);
    expect(job.state).toBe('running');
    await until(() => host.jobOutput(job.id).includes('started'));
    expect(host.killJob(job.id)).toBe(true);
    await until(() => host.getEvents(s.id).some((e) => e.type === 'job/finished'));
    expect(host.getEvents(s.id).find((e) => e.type === 'job/finished')).toMatchObject({ state: 'killed' });
    await new Promise((r) => setTimeout(r, 100));
    expect(providers.get('mock/a')!.requests).toHaveLength(2);
  });

  it('promotes slow tool calls to background jobs and reports their result later', async () => {
    const results: JobResult[] = [];
    const jm = new JobManager(() => undefined, (r) => results.push(r));
    const fast = await jm.promoteIfSlow('s', 't', {}, async () => 'quick', 200);
    expect(fast).toBe('quick');
    const slow = await jm.promoteIfSlow('s', 't', {}, () => new Promise((r) => setTimeout(() => r('late answer'), 150)), 30);
    expect(slow).toMatch(/moved to background job/);
    await until(() => results.length === 1);
    expect(results[0].tail).toBe('late answer');
    expect(results[0].job.state).toBe('done');
    await expect(jm.promoteIfSlow('s', 't', {}, async () => Promise.reject(new Error('boom')), 100)).rejects.toThrow('boom');
  });

  it('slow MCP tools are promoted through the host and delivered', async () => {
    writeFileSync(join(ws, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [join(here, 'fixtures', 'echo-mcp.mjs')], trust: true } } }));
    const provider = new MockProvider([
      { text: '', toolCalls: [call('mcp__echo__slow', { ms: 500 })] },
      { text: 'waiting for the slow tool', toolCalls: [] },
      { text: 'got it', toolCalls: [] },
    ]);
    const host = new HarnessHost({
      config: { ...testConfig(), jobs: { promoteAfterMs: 100 } },
      providerFactory: () => ({ provider, model: 'm' }),
      loadPlugins: false,
      shellHooks: false,
    });
    await host.init();
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'call slow');
    await host.wait(s.id);
    expect((host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output).toMatch(/moved to background job/);
    await until(() => provider.requests.length === 3 && !host.isRunning(s.id));
    expect((host.getEvents(s.id).find((e) => e.type === 'user/message' && e.source === 'job') as any).text).toContain('slow done after 500ms');
    await host.dispose();
  });

  it('marks jobs that were running when the app stopped as lost', async () => {
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: ws });
    SessionLog.open(s.id).append({ type: 'job/started', jobId: 'job-x', name: 'bash', command: 'npm run dev' });
    const { host: again } = await mockHost({});
    expect(again.getEvents(s.id).find((e) => e.type === 'job/finished')).toMatchObject({ jobId: 'job-x', state: 'lost' });
  });
});
