import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, SessionLog, deriveMessages } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

describe('agent loop', () => {
  let ws: string;
  beforeEach(() => {
    tempHome();
    ws = tempWorkspace();
  });

  it('runs tools, logs every step, and ends idle', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: 'Creating file', toolCalls: [call('write_file', { path: 'hello.txt', content: 'hi' })] },
        { text: 'Reading back', toolCalls: [call('read_file', { path: 'hello.txt' })] },
        { text: 'All done.', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'make hello.txt');
    const r = await host.wait(s.id);
    expect(r?.status).toBe('idle');
    expect(readFileSync(join(ws, 'hello.txt'), 'utf8')).toBe('hi');
    const events = host.getEvents(s.id);
    const types = events.map((e) => e.type);
    expect(types).toContain('request/header');
    expect(types.filter((t) => t === 'tool/result')).toHaveLength(2);
    const readResult = events.find((e) => e.type === 'tool/result' && e.name === 'read_file') as any;
    expect(readResult.output).toContain('1|hi');
    // The model saw the tool result paired with its call.
    const lastReq = providers.get('mock/a')!.requests.at(-1)!;
    expect(lastReq.messages.filter((m) => m.role === 'tool')).toHaveLength(2);
    expect(lastReq.system).toContain('sun-harness');
    expect(host.listSessions()[0].title).toBe('make hello.txt');
  });

  it('reports unknown tools and invalid JSON back to the model', async () => {
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [{ id: 'x1', name: 'nope', arguments: '{}' }, { id: 'x2', name: 'read_file', arguments: '{bad' }] }, { text: 'ok', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'go');
    await host.wait(s.id);
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[0].isError).toBe(true);
    expect(results[0].output).toContain('Unknown tool');
    expect(results[1].output).toContain('Invalid JSON');
  });

  it('asks for approval in suggest mode; deny is fed back, allow_always is remembered', async () => {
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('bash', { command: 'echo one' }, 'b1')] },
          { text: '', toolCalls: [call('bash', { command: 'echo two' }, 'b2')] },
          { text: '', toolCalls: [call('bash', { command: 'echo three' }, 'b3')] },
          { text: 'finished', toolCalls: [] },
        ],
      },
      { approval: 'suggest' },
    );
    const decisions = ['deny', 'allow_always'] as const;
    let i = 0;
    host.registerApprover();
    host.subscribe((e) => {
      if (e.kind === 'approvals' && e.approvals.length) setTimeout(() => host.approve(e.approvals[0].callId, decisions[i++]), 5);
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'run commands');
    const r = await host.wait(s.id);
    expect(r?.status).toBe('idle');
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[0].output).toContain('denied');
    expect(results[1].output).toContain('two');
    expect(results[2].output).toContain('three');
    // Third call needed no approval thanks to allow_always.
    expect(host.getEvents(s.id).filter((e) => e.type === 'approval/request')).toHaveLength(2);
  });

  it('auto-edit allows workspace writes without asking but asks for writes outside', async () => {
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('write_file', { path: 'in.txt', content: 'x' }, 'w1'), call('write_file', { path: '/tmp/sun-outside-test.txt', content: 'x' }, 'w2')] },
          { text: 'ok', toolCalls: [] },
        ],
      },
      { approval: 'auto-edit' },
    );
    host.registerApprover();
    host.subscribe((e) => {
      if (e.kind === 'approvals' && e.approvals.length) setTimeout(() => host.approve(e.approvals[0].callId, 'deny'), 5);
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'write');
    await host.wait(s.id);
    const reqs = host.getEvents(s.id).filter((e) => e.type === 'approval/request') as any[];
    expect(reqs.map((r) => r.callId)).toEqual(['w2']);
    expect(existsSync(join(ws, 'in.txt'))).toBe(true);
  });

  it('denies instead of hanging when no approver is attached (headless), with a reason for the model', async () => {
    const { host } = await mockHost(
      { 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo hi' })] }, { text: 'continued without bash', toolCalls: [] }] },
      { approval: 'suggest' },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'run it');
    expect((await host.wait(s.id))?.status).toBe('idle');
    const res = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(res.output).toContain('headless run');
    expect(host.getEvents(s.id).find((e) => e.type === 'approval/decision')).toMatchObject({ decision: 'deny' });
  });

  it('denyInsteadOfPrompting denies even with an approver attached', async () => {
    const { host } = await mockHost(
      { 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo hi' })] }, { text: 'ok', toolCalls: [] }] },
      { approval: 'suggest', denyInsteadOfPrompting: true },
    );
    host.registerApprover();
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'run it');
    await host.wait(s.id);
    expect((host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output).toContain('denyInsteadOfPrompting');
  });

  it('pauses durably on quota and resumes on another model', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [new ProviderError('quota', 'HTTP 402: Insufficient Balance', 402)],
      'mock/b': [{ text: 'Recovered on model b', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hello');
    const r1 = await host.wait(s.id);
    expect(r1).toMatchObject({ status: 'paused', reason: 'quota' });
    expect(host.listSessions()[0]).toMatchObject({ status: 'paused', statusReason: 'quota' });

    // Simulate an app restart: a fresh log read sees the same paused state.
    expect(SessionLog.open(s.id).status().status).toBe('paused');

    host.resume(s.id, { model: 'mock/b' });
    const r2 = await host.wait(s.id);
    expect(r2?.status).toBe('idle');
    expect(SessionLog.open(s.id).last('assistant/message')?.text).toBe('Recovered on model b');
    expect(SessionLog.open(s.id).currentModel()).toBe('mock/b');
    // The resumed request carried the original user message exactly once.
    const req = providers.get('mock/b')!.requests[0];
    expect(req.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual(['hello']);
  });

  it('resumes on the same model once quota is restored (auto-resume tick)', async () => {
    const { host } = await mockHost(
      { 'mock/a': [new ProviderError('quota', 'quota exceeded', 429), { text: 'back', toolCalls: [] }] },
      { autoResume: { enabled: true, intervalMinutes: 0 } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hello');
    expect((await host.wait(s.id))?.status).toBe('paused');
    // Titled from the first message even though the model never answered.
    expect(host.listSessions().find((x) => x.id === s.id)?.title).toBe('hello');
    const tick = await host.backgroundTick(new Date(Date.now() + 1000), { intel: false });
    expect(tick.resumed).toEqual([s.id]);
    expect((await host.wait(s.id))?.status).toBe('idle');
  });

  it('switches to fallback models automatically on quota', async () => {
    const { host } = await mockHost(
      { 'mock/a': [new ProviderError('quota', 'insufficient_quota', 429)], 'mock/c': [{ text: 'from c', toolCalls: [] }] },
      { fallbackModels: ['mock/c'] },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hi');
    expect((await host.wait(s.id))?.status).toBe('idle');
    const sw = SessionLog.open(s.id).last('model/switch');
    expect(sw).toMatchObject({ from: 'mock/a', to: 'mock/c' });
  });

  it('retries transient errors with backoff', async () => {
    const { host } = await mockHost({
      'mock/a': [new ProviderError('rate_limit', '429', 429, 1), new ProviderError('network', 'ECONNRESET', undefined, 1), { text: 'ok', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'hi');
    expect((await host.wait(s.id))?.status).toBe('idle');
  });

  it('pauses after max steps and can be resumed', async () => {
    const loop = Array.from({ length: 4 }, () => ({ text: '', toolCalls: [call('list_dir', {})] }));
    const { host, providers } = await mockHost({ 'mock/a': [...loop, { text: 'done', toolCalls: [] }] }, { maxSteps: 2 });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'loop');
    expect((await host.wait(s.id))).toMatchObject({ status: 'paused', reason: 'max_steps' });
    host.resume(s.id);
    expect((await host.wait(s.id))).toMatchObject({ status: 'paused', reason: 'max_steps' });
    host.resume(s.id);
    // Finishing exactly on the last allowed step is idle, not paused.
    expect((await host.wait(s.id))?.status).toBe('idle');
    expect(providers.get('mock/a')!.requests).toHaveLength(5);
  });

  it('aborts a running bash command', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'sleep 20' })] }] });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'sleep');
    setTimeout(() => host.abort(s.id), 300);
    const r = await host.wait(s.id);
    expect(r?.status).toBe('aborted');
  });

  it('queues messages sent during a run', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [async () => (await new Promise((r) => setTimeout(r, 100)), { text: 'first', toolCalls: [] }), { text: 'second', toolCalls: [] }],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'one');
    await new Promise((r) => setTimeout(r, 40));
    await host.send(s.id, 'two');
    await host.wait(s.id);
    // Steering: "two" arrived during the first model call and was answered in the same run.
    const reqs = providers.get('mock/a')!.requests;
    expect(reqs).toHaveLength(2);
    expect(reqs[1].messages.map((m: any) => m.content)).toEqual(['one', 'first', 'two']);
    expect(SessionLog.open(s.id).last('assistant/message')?.text).toBe('second');
    expect(SessionLog.open(s.id).all().filter((e) => e.type === 'run/status' && e.status === 'running')).toHaveLength(1);
  });

  it('delivers messages after the run when steering is "after-run"', async () => {
    const { host, providers } = await mockHost(
      { 'mock/a': [async () => (await new Promise((r) => setTimeout(r, 100)), { text: 'first', toolCalls: [] }), { text: 'second', toolCalls: [] }] },
      { steering: 'after-run' },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'one');
    await host.send(s.id, 'two');
    await host.wait(s.id);
    await new Promise((r) => setTimeout(r, 50));
    await host.wait(s.id);
    expect(providers.get('mock/a')!.requests[0].messages.map((m: any) => m.content)).toEqual(['one']);
    expect(SessionLog.open(s.id).last('assistant/message')?.text).toBe('second');
  });

  it('steers between steps, never between a tool call and its result', async () => {
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('bash', { command: 'sleep 0.3; echo done' })] },
        { text: 'finished', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'run it');
    await new Promise((r) => setTimeout(r, 150));
    await host.send(s.id, 'also mention the time');
    await host.wait(s.id);
    const second = providers.get('mock/a')!.requests[1].messages.map((m: any) => m.role);
    expect(second).toEqual(['user', 'assistant', 'tool', 'user']);
  });

  it('compacts long history into a summary event', async () => {
    const big = 'x'.repeat(4000);
    const { host, providers } = await mockHost(
      {
        'mock/a': [
          { text: big, toolCalls: [] },
          { text: big, toolCalls: [] },
          { text: 'SUMMARY: talked about x', toolCalls: [] }, // compaction call
          { text: 'answer after compaction', toolCalls: [] },
        ],
      },
      { compaction: { thresholdTokens: 1500, keepRecent: 1 } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'q1');
    await host.wait(s.id);
    await host.send(s.id, 'q2');
    await host.wait(s.id);
    await host.send(s.id, 'q3');
    await host.wait(s.id);
    const events = host.getEvents(s.id);
    const comp = events.find((e) => e.type === 'context/compaction') as any;
    expect(comp.summary).toContain('SUMMARY');
    const msgs = deriveMessages(events);
    expect(msgs[0].content).toContain('Summary of the earlier conversation');
    expect(msgs.at(-1)!.content).toBe('answer after compaction');
    const lastReq = providers.get('mock/a')!.requests.at(-1)!;
    expect(lastReq.messages.some((m) => m.content === big)).toBe(false);
  });

  it('marks sessions interrupted by a crash as paused on init', async () => {
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: ws });
    SessionLog.open(s.id).append({ type: 'run/status', status: 'running' });
    const { host: host2 } = await mockHost({});
    expect(host2.listSessions().find((x) => x.id === s.id)).toMatchObject({ status: 'paused', statusReason: 'interrupted' });
    void host;
  });

  it('edit_file enforces unique matches', async () => {
    writeFileSync(join(ws, 'a.txt'), 'foo foo bar');
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', old_string: 'foo', new_string: 'baz' })] },
        { text: '', toolCalls: [call('edit_file', { path: 'a.txt', old_string: 'bar', new_string: 'qux' })] },
        { text: 'ok', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'edit');
    await host.wait(s.id);
    const results = host.getEvents(s.id).filter((e) => e.type === 'tool/result') as any[];
    expect(results[1].isError).toBe(true);
    expect(results[1].output).toContain('matches 2 times');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('foo foo qux');
  });

  it('runs a subagent through the task tool and returns its report', async () => {
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('task', { prompt: 'research X' })] },
        { text: 'sub report: X is great', toolCalls: [] },
        { text: 'Parent got the report', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws, mode: 'agent' });
    await host.send(s.id, 'delegate');
    await host.wait(s.id);
    const res = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(res.output).toContain('X is great');
    const child = host.listSessions().find((x) => x.parent === s.id);
    expect(child).toBeTruthy();
  });
});

describe('approval race guard', () => {
  beforeEach(() => tempHome());

  it('answers must match the current prompt; unknown or stale answers are rejected', async () => {
    const { host } = await mockHost(
      { 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo guarded' }, 'g1')] }, { text: 'ok', toolCalls: [] }] },
      { approval: 'suggest' },
    );
    host.registerApprover();
    const seen: string[] = [];
    host.subscribe((e) => {
      if (e.kind === 'approvals' && e.approvals.length) seen.push(e.approvals[0].promptId);
    });
    const s = host.createSession({ cwd: tempWorkspace() });
    await host.send(s.id, 'go');
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 10));
    const [pending] = host.pendingApprovals();
    expect(pending.promptId).toMatch(/[0-9a-f-]{36}/);
    expect(Date.parse(pending.requestedAt)).toBeGreaterThan(0);
    expect(host.approve('no-such-call', 'allow')).toBe(false);
    expect(host.approve('g1', 'allow', 'stale-prompt')).toBe(false);
    expect(host.pendingApprovals()).toHaveLength(1);
    expect(host.approve('g1', 'allow', pending.promptId)).toBe(true);
    expect(host.approve('g1', 'deny', pending.promptId)).toBe(false); // already answered
    await host.wait(s.id);
    expect((host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output).toContain('guarded');
  });

  it('a re-issued prompt after a restart gets a new prompt id, so an answer to the old one cannot apply', async () => {
    const first = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo x' }, 'r1')] }] }, { approval: 'suggest' });
    first.host.registerApprover();
    const ws = tempWorkspace();
    const s = first.host.createSession({ cwd: ws });
    await first.host.send(s.id, 'go');
    for (let i = 0; i < 100 && !first.host.pendingApprovals().length; i++) await new Promise((r) => setTimeout(r, 10));
    const oldPrompt = first.host.pendingApprovals()[0].promptId;
    first.host.abort(s.id);
    await first.host.wait(s.id);

    const second = await mockHost({ 'mock/a': [{ text: 'done', toolCalls: [] }] }, { approval: 'suggest' });
    second.host.registerApprover();
    second.host.resume(s.id);
    for (let i = 0; i < 100 && !second.host.pendingApprovals().length; i++) await new Promise((r) => setTimeout(r, 10));
    const fresh = second.host.pendingApprovals()[0];
    expect(fresh.callId).toBe('r1');
    expect(fresh.promptId).not.toBe(oldPrompt);
    expect(second.host.approve('r1', 'allow', oldPrompt)).toBe(false);
    expect(second.host.approve('r1', 'deny', fresh.promptId)).toBe(true);
    await second.host.wait(s.id);
  });
});
