import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { describeCron, listSchedules, missedRun, missedTasks, nextRuns, parseSchedule, updateSchedule } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const NOW = new Date(2026, 10, 7, 16, 40, 0); // Sat 7 Nov 2026 16:40 local

describe('natural-language schedules', () => {
  const cases: [string, string | RegExp, string][] = [
    ['Every weekday at 9am summarize my unread emails', '0 9 * * 1-5', 'summarize my unread emails'],
    ['every monday and thursday at 10:30 check the PR queue', '30 10 * * 1,4', 'check the PR queue'],
    ['every 30 minutes check if the site is up', '*/30 * * * *', 'check if the site is up'],
    ['every month on the 1st at 8am send me the invoice summary', '0 8 1 * *', 'send me the invoice summary'],
    ['daily at 18:00 write a short report', '0 18 * * *', 'write a short report'],
    ['每个工作日早上9点帮我总结邮件', '0 9 * * 1-5', '帮我总结邮件'],
    ['每周一下午3点半检查一下PR', '30 15 * * 1', '检查一下PR'],
    ['每天晚上8点提醒我写日报', '0 20 * * *', '提醒我写日报'],
    ['每隔15分钟检查一下网站', '*/15 * * * *', '检查一下网站'],
    ['每月1号上午10点汇总发票', '0 10 1 * *', '汇总发票'],
  ];
  for (const [text, cron, prompt] of cases) {
    it(`parses "${text}"`, () => {
      const r = parseSchedule(text, NOW)!;
      expect(r.cron).toEqual(cron);
      expect(r.prompt).toBe(prompt);
    });
  }

  it('parses one-shot times only with a scheduling verb', () => {
    const tomorrow = parseSchedule('Remind me tomorrow at 3pm to call Alex', NOW)!;
    expect(new Date(tomorrow.at!).getHours()).toBe(15);
    expect(new Date(tomorrow.at!).getDate()).toBe(8);
    expect(tomorrow.prompt).toBe('Remind me to call Alex');
    expect(new Date(parseSchedule('2小时后提醒我喝水', NOW)!.at!).getTime()).toBe(NOW.getTime() + 2 * 3600_000);
    expect(new Date(parseSchedule('明天下午3点提醒我给Alex打电话', NOW)!.at!).getHours()).toBe(15);
    expect(parseSchedule('the build takes 2 hours on CI', NOW)).toBeUndefined();
    expect(parseSchedule('tomorrow at 3pm we have a demo', NOW)).toBeUndefined();
    expect(parseSchedule('tomorrow at 3pm', NOW, { explicit: true })?.at).toBeTruthy();
  });

  it('does not mistake ordinary coding prompts for schedules', () => {
    for (const t of ['every function should have a docstring', 'fix the daily report generator bug', 'refactor the monthly billing job', 'make hourly rate configurable', 'add a cron parser']) expect(parseSchedule(t, NOW)).toBeUndefined();
  });

  it('computes next runs, missed runs, and descriptions', () => {
    expect(nextRuns('0 9 * * 1-5', NOW, 2).map((d) => [d.getDay(), d.getHours()])).toEqual([
      [1, 9],
      [2, 9],
    ]);
    const missed = missedRun('0 9 * * *', new Date(2026, 10, 6, 10, 0), new Date(2026, 10, 7, 12, 0));
    expect(missed?.getDate()).toBe(7);
    expect(missedRun('0 9 * * *', new Date(2026, 10, 7, 9, 30), new Date(2026, 10, 7, 12, 0))).toBeUndefined();
    expect(describeCron('30 10 * * 1,4')).toBe('every Monday, Thursday at 10:30');
    expect(describeCron('*/15 * * * *')).toBe('every 15 minutes');
  });
});

describe('automations in the host', () => {
  beforeEach(() => tempHome());

  it('turns a scheduling message into a proposal instead of answering, then creates the automation', async () => {
    const ws = tempWorkspace();
    const { host, providers } = await mockHost({ 'mock/a': [{ text: 'answered now', toolCalls: [] }] });
    const s = host.createSession({ cwd: ws, mode: 'assistant' });
    await host.send(s.id, 'every weekday at 9am summarize my unread emails');
    expect(providers.get('mock/a')!.requests).toHaveLength(0);
    const p = host.getEvents(s.id).find((e) => e.type === 'automation/proposal') as any;
    expect(p).toMatchObject({ cron: '0 9 * * 1-5', prompt: 'summarize my unread emails', description: 'every weekday at 09:00' });
    const { automation } = host.resolveProposal(s.id, p.proposalId, 'create');
    expect(automation).toMatchObject({ cron: '0 9 * * 1-5', mode: 'assistant', source: s.id, enabled: true });
    expect(automation!.nextRun).toBeTruthy();
    const ack = host.getEvents(s.id).at(-1) as any;
    expect(ack).toMatchObject({ type: 'assistant/message', model: 'harness' });
    expect(ack.text).toMatch(/Scheduled “summarize my unread emails” — every weekday at 09:00/);
    expect(() => host.resolveProposal(s.id, p.proposalId, 'run')).toThrow(/already answered/);
    expect(providers.get('mock/a')!.requests).toHaveLength(0);
  });

  it('answers normally when the user chooses "run" (and skips detection when asked)', async () => {
    const ws = tempWorkspace();
    const { host, providers } = await mockHost({ 'mock/a': [{ text: 'ok, here it is', toolCalls: [] }, { text: 'second', toolCalls: [] }] });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'remind me in 2 hours to stretch');
    const p = host.getEvents(s.id).find((e) => e.type === 'automation/proposal') as any;
    host.resolveProposal(s.id, p.proposalId, 'run');
    await host.wait(s.id);
    expect(providers.get('mock/a')!.requests[0].messages.at(-1)!.content).toBe('remind me in 2 hours to stretch');
    await host.send(s.id, 'every day at 9 check the logs', 'user', { noDetect: true });
    await host.wait(s.id);
    expect(providers.get('mock/a')!.requests).toHaveLength(2);
  });

  it('creates, previews, pauses, edits, runs, and catches up automations', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({ 'mock/a': [{ text: 'run 1 done', toolCalls: [] }, { text: 'catch-up done', toolCalls: [] }] });
    expect(host.previewSchedule('每天晚上8点')).toMatchObject({ cron: '0 20 * * *', description: 'every day at 20:00' });
    expect(host.previewSchedule('0 9 * * 1-5')?.next).toHaveLength(3);
    expect(host.previewSchedule('whenever you feel like it')).toBeUndefined();
    const a = host.createAutomation({ prompt: 'check the logs', schedule: 'every day at 9am', cwd: ws, mode: 'assistant' });
    expect(a.description).toBe('every day at 09:00');
    expect(() => host.createAutomation({ prompt: 'x', schedule: 'sometime' })).toThrow(/Could not understand/);
    expect(host.updateAutomation(a.id, { enabled: false }).nextRun).toBeUndefined();
    expect(host.updateAutomation(a.id, { enabled: true, schedule: 'every weekday at 10:15' }).cron).toBe('15 10 * * 1-5');
    const seen: string[] = [];
    host.subscribe((e) => e.kind === 'automation' && seen.push(e.status));
    const sid = await host.runAutomation(a.id);
    await host.wait(sid);
    await new Promise((r) => setTimeout(r, 20));
    expect(listSchedules()[0].runs![0]).toMatchObject({ sessionId: sid, status: 'idle' });
    expect(seen).toEqual(['running', 'idle']);
    // Catch-up: the 10:15 run on Friday was missed (lastRun Friday 08:00, now Friday 12:00).
    updateSchedule(a.id, { lastRun: new Date(2026, 10, 6, 8, 0).toISOString() });
    expect(missedTasks(listSchedules(), new Date(2026, 10, 6, 12, 0), missedRun).map((t) => t.id)).toEqual([a.id]);
    const r = await host.backgroundTick(new Date(2026, 10, 6, 12, 0), { intel: false });
    expect(r.scheduled).toHaveLength(1);
    await host.wait(r.scheduled[0]);
    expect((host.getEvents(r.scheduled[0]).find((e) => e.type === 'user/message') as any).text).toMatch(/catch-up run/);
    expect(listSchedules()[0].runs![0].catchUp).toBe(true);
    host.deleteAutomation(a.id);
    expect(host.listAutomations()).toEqual([]);
  });
});

describe('file changes per session and per turn', () => {
  beforeEach(() => tempHome());

  it('reports added, modified and deleted files, per turn and for the session, and reverts one file', async () => {
    const ws = tempWorkspace();
    writeFileSync(join(ws, 'a.txt'), 'one\n');
    writeFileSync(join(ws, 'gone.txt'), 'bye\n');
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'two' }), call('write_file', { path: 'new/b.txt', content: 'b\n' })] },
          { text: 'turn 1', toolCalls: [] },
          { text: '', toolCalls: [call('read_file', { path: 'a.txt' }), call('edit_file', { path: 'a.txt', old_string: 'two', new_string: 'three' }), call('read_file', { path: 'gone.txt' }), call('apply_patch', { patch: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch' })] },
          { text: 'turn 2', toolCalls: [] },
        ],
      },
      { verify: { enabled: false, maxAttempts: 0, timeoutMs: 1000 } },
    );
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'first');
    await host.wait(s.id);
    await host.send(s.id, 'second');
    await host.wait(s.id);
    const all = host.sessionChanges(s.id);
    expect(all.map((c) => [c.path, c.status, c.additions, c.deletions])).toEqual([
      ['a.txt', 'modified', 1, 1],
      ['gone.txt', 'deleted', 0, 1],
      ['new/b.txt', 'added', 1, 0],
    ]);
    expect(all[0].diff).toContain('-one\n+three');
    const users = host.getEvents(s.id).filter((e) => e.type === 'user/message');
    const ends = host.getEvents(s.id).filter((e) => e.type === 'run/status' && e.status === 'idle');
    const turn1 = host.sessionChanges(s.id, { fromSeq: users[0].seq, toSeq: ends[0].seq });
    expect(turn1.map((c) => c.path)).toEqual(['a.txt', 'new/b.txt']);
    expect(turn1[0].diff).toContain('-one\n+two');
    const turn2 = host.sessionChanges(s.id, { fromSeq: users[1].seq });
    expect(turn2.find((c) => c.path === 'a.txt')!.diff).toContain('-two\n+three');

    host.revertFile(s.id, 'a.txt');
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('one\n');
    expect(host.getEvents(s.id).some((e) => e.type === 'file/revert')).toBe(true);
    expect((host.getEvents(s.id).at(-1) as any).text).toMatch(/reverted a\.txt/);
    expect(host.sessionChanges(s.id).map((c) => c.path)).toEqual(['gone.txt', 'new/b.txt']);
    // The revert itself is a checkpoint: undo brings the edit back.
    host.undo(s.id, { steps: 1 });
    expect(readFileSync(join(ws, 'a.txt'), 'utf8')).toBe('three\n');

    expect(host.readSessionFile(s.id, 'new/b.txt').content).toBe('b\n');
    expect(() => host.readSessionFile(s.id, '../../etc/hosts')).toThrow(/inside the session workspace/);
  });
});
