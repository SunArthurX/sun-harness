import { appendFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionLog, deriveMessages, pendingToolCalls, needsApproval, BUILTIN_TOOLS } from '../src/index.js';
import { tempHome } from './helpers.js';

describe('session log', () => {
  beforeEach(() => tempHome());

  it('appends, reloads, and survives a torn last line', () => {
    const log = SessionLog.create({ mode: 'coding', cwd: '/tmp', model: 'mock/a' });
    log.append({ type: 'user/message', text: 'hi' });
    appendFileSync(log.file, '{"seq":2,"type":"assist');
    const again = SessionLog.open(log.id);
    expect(again.all()).toHaveLength(2);
    expect(SessionLog.list()[0]).toMatchObject({ id: log.id, status: 'idle', model: 'mock/a' });
  });

  it('derives paired messages and fills interrupted tool calls', () => {
    const log = SessionLog.create({ mode: 'coding', cwd: '/tmp', model: 'm' });
    log.append({ type: 'user/message', text: 'q' });
    log.append({ type: 'assistant/message', text: '', toolCalls: [{ id: 'a', name: 'x', arguments: '{}' }, { id: 'b', name: 'y', arguments: '{}' }], model: 'm' });
    log.append({ type: 'tool/result', callId: 'a', name: 'x', output: 'ok', isError: false });
    expect(pendingToolCalls(log.all()).map((c) => c.id)).toEqual(['b']);
    log.append({ type: 'user/message', text: 'next' });
    const msgs = deriveMessages(log.all());
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user']);
    expect(msgs[3].content).toContain('interrupted');
    expect(pendingToolCalls(log.all())).toEqual([]);
  });

  it('approval policy by mode and risk', () => {
    const bash = BUILTIN_TOOLS.find((t) => t.name === 'bash')!;
    const write = BUILTIN_TOOLS.find((t) => t.name === 'write_file')!;
    const read = BUILTIN_TOOLS.find((t) => t.name === 'read_file')!;
    expect(needsApproval(bash, {}, 'full-auto', '/w')).toBe(false);
    expect(needsApproval(bash, {}, 'auto-edit', '/w')).toBe(true);
    expect(needsApproval(write, { path: 'a.ts' }, 'auto-edit', '/w')).toBe(false);
    expect(needsApproval(write, { path: '../etc/x' }, 'auto-edit', '/w')).toBe(true);
    expect(needsApproval(write, { path: 'a.ts' }, 'suggest', '/w')).toBe(true);
    expect(needsApproval(read, { path: '/etc/hosts' }, 'suggest', '/w')).toBe(false);
  });
});
