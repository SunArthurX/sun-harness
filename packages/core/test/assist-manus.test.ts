import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { appendDaily, readDaily, readUserProfile, renderSlides, saveUserFact, USER_PROFILE_MAX } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

describe('user profile and daily notes', () => {
  beforeEach(() => tempHome());

  it('keeps the user profile under the cap and records a daily line once', () => {
    expect(saveUserFact('Lives in Shanghai')).toMatch(/user profile/);
    expect(saveUserFact('Lives in Shanghai')).toMatch(/Already/);
    saveUserFact('x'.repeat(400));
    saveUserFact('y'.repeat(400));
    saveUserFact('z'.repeat(400));
    saveUserFact('Newest fact about weekends');
    expect(readUserProfile().length).toBeLessThanOrEqual(USER_PROFILE_MAX);
    expect(readUserProfile()).toContain('Newest fact about weekends');
    appendDaily('Talked about the deck', '2026-11-07');
    appendDaily('Talked about the deck', '2026-11-07');
    expect(readDaily('2026-11-07').match(/Talked about the deck/g)).toHaveLength(1);
  });
});

describe('slides', () => {
  it('renders an HTML deck and escapes notes', () => {
    const html = renderSlides('Q3', [{ title: 'Revenue', bullets: ['Up 10%'], notes: '<script>alert(1)</script>' }]);
    expect(html).toContain('Revenue');
    expect(html).toContain('Up 10%');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });
});

describe('skill slash, wide research, session search', () => {
  beforeEach(() => tempHome());

  it('loads a skill when the message is /name', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun', 'skills', 'deploy'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Ship it\n---\nStep 1: tag a release.');
    const { host } = await mockHost({ 'mock/a': [{ text: 'shipped', toolCalls: [] }] });
    const s = host.createSession({ cwd: ws, mode: 'agent' });
    await host.send(s.id, '/deploy the api');
    await host.wait(s.id);
    const msg = host.getEvents(s.id).find((e) => e.type === 'user/message') as { text: string; command?: { name: string } };
    expect(msg.command?.name).toBe('deploy');
    expect(msg.text).toContain('Step 1: tag a release.');
    expect(msg.text).toContain('User request: the api');
  });

  it('researches each item in its own subagent and writes one file', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('wide_research', { question: 'Compare tools', items: ['Alpha', 'Beta'] })] },
        { text: 'Alpha is fast. Source: https://alpha.example', toolCalls: [] },
        { text: 'Beta is cheap. Source: https://beta.example', toolCalls: [] },
        { text: 'Alpha is faster, Beta is cheaper.', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: ws, mode: 'agent' });
    await host.send(s.id, 'compare them');
    await host.wait(s.id);
    const report = readFileSync(join(ws, 'research', 'compare-tools.md'), 'utf8');
    expect(report).toContain('## Alpha');
    expect(report).toContain('https://beta.example');
    expect(host.listSessions().filter((x) => x.parent === s.id)).toHaveLength(2);
    expect(host.deliverables(s.id).some((d) => d.path.endsWith('compare-tools.md'))).toBe(true);
  });

  it('finds an earlier conversation', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({ 'mock/a': [{ text: 'noted', toolCalls: [] }, { text: '', toolCalls: [call('session_search', { query: 'ledger' })] }, { text: 'found it', toolCalls: [] }] });
    const first = host.createSession({ cwd: ws, mode: 'coding', title: 'Ledger decision' });
    await host.send(first.id, 'We will use the ledger format.');
    await host.wait(first.id);
    const second = host.createSession({ cwd: ws, mode: 'coding' });
    await host.send(second.id, 'what did we decide');
    await host.wait(second.id);
    const tool = host.getEvents(second.id).find((e) => e.type === 'tool/result') as { output: string };
    expect(tool.output).toContain('Ledger decision');
  });
});
