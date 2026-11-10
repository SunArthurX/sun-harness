import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deriveMessages, homePath, pendingToolCalls, SessionLog, type HarnessHost, type SessionEventBody } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6Q0AAAAASUVORK5CYII=', 'base64');
const time = '2026-01-01T00:00:00Z';
const transcript = (cwd: string, ...events: SessionEventBody[]) => [
  { type: 'session/meta', id: 'foreign', title: 'Imported fixture', mode: 'coding', model: 'mock/a', cwd, createdAt: time, approval: 'full-auto', sandbox: 'off' },
  ...events,
].map((body, seq) => JSON.stringify({ seq, ts: time, ...body })).join('\n');

let host: HarnessHost;
let workspace: string;

beforeEach(async () => {
  tempHome();
  workspace = tempWorkspace();
  ({ host } = await mockHost({}, { approval: 'suggest' }));
});

afterEach(async () => { await host.dispose(); });

describe('legacy transcript import boundary', () => {
  it('rejects foreign and symlinked image paths before publishing a log', () => {
    const foreign = join(workspace, 'foreign.png');
    writeFileSync(foreign, 'outside the owned attachment root');
    expect(() => host.importSession(transcript(workspace, {
      type: 'user/message', text: 'read this', images: [{ path: foreign, mime: 'image/png' }],
    }))).toThrow(/attachment|bundle/i);
    const dir = join(homePath('attachments'), 'fixture');
    mkdirSync(dir, { recursive: true });
    const linked = join(dir, 'linked.png');
    symlinkSync(foreign, linked);
    expect(() => host.importSession(transcript(workspace, {
      type: 'user/message', text: 'read linked image', images: [{ path: linked, mime: 'image/png' }],
    }))).toThrow(/attachment/i);
    expect(host.listSessions()).toEqual([]);
    expect(readdirSync(SessionLog.dir())).toEqual([]);
  });

  it('requires an explicit workspace when the old directory is absent', () => {
    const missing = join(workspace, 'missing');
    const saved = transcript(missing, { type: 'user/message', text: 'archived text' });
    expect(() => host.importSession(saved)).toThrow(/workspace/i);
    expect(host.listSessions()).toEqual([]);
    const selected = join(workspace, 'selected');
    mkdirSync(selected);
    const imported = host.importSession(saved, { cwd: selected });
    expect(imported.cwd).toBe(realpathSync(selected));
    expect(imported.id).not.toBe('foreign');
  });

  it('cannot reuse historical approvals, jobs, tools, or proposals', async () => {
    const marker = join(workspace, 'ran.txt');
    const saved = transcript(workspace,
      { type: 'user/message', text: 'First old turn' },
      { type: 'assistant/message', text: '', model: 'mock/a', toolCalls: [call('write_file', { path: marker, content: 'unsafe' }, 'old-call')] },
      { type: 'approval/request', callId: 'old-call', name: 'write_file', arguments: '{}', risk: 'write' },
      { type: 'approval/decision', callId: 'old-call', decision: 'allow_always' },
      { type: 'job/started', jobId: 'old-job', name: 'bash', command: 'must not run' },
      { type: 'automation/proposal', proposalId: 'old-proposal', title: 'Old', prompt: 'must not run', cron: '0 0 * * *', description: 'old' },
      { type: 'run/status', status: 'awaiting_approval' },
    );
    const imported = host.importSession(saved);
    expect(imported.status).toBe('idle');
    expect(host.getEvents(imported.id)[0]).not.toHaveProperty('approval');
    expect(host.getEvents(imported.id)[0]).not.toHaveProperty('sandbox');
    expect(host.getEvents(imported.id).map(event => event.type)).not.toContain('approval/decision');
    expect(host.getEvents(imported.id).map(event => event.type)).not.toContain('job/started');
    expect(() => host.resolveProposal(imported.id, 'old-proposal', 'both')).toThrow(/proposal/i);
    host.resume(imported.id);
    expect(await host.wait(imported.id)).toBeUndefined();
    expect(existsSync(marker)).toBe(false);
    expect(host.listAutomations()).toEqual([]);
    expect(host.pendingApprovals()).toEqual([]);
    const modelHistory = deriveMessages(host.getEvents(imported.id));
    expect(modelHistory.at(-1)).toMatchObject({ role: 'tool', toolCallId: 'old-call' });
  });
});

function entry(name: string, payload: Buffer) {
  return { name, size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') };
}

function encode(entries: object[], payloads: Buffer[]) {
  const manifest = Buffer.from(JSON.stringify({ version: 1, entries }));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(manifest.length);
  return gzipSync(Buffer.concat([Buffer.from('SUNB1\n'), length, manifest, ...payloads]));
}

describe('portable session bundles', () => {
  it('round-trips image bytes across homes and restart, under a new session ID', async () => {
    const source = host.createSession({ cwd: workspace });
    const log = SessionLog.open(source.id);
    const dir = log.attachmentDir();
    mkdirSync(dir, { recursive: true });
    const image = join(dir, '1.png');
    writeFileSync(image, PNG);
    log.append({ type: 'user/message', text: 'portable history', images: [{ path: image, mime: 'image/png' }] });
    const local = host.importSession(host.exportSession(source.id, 'jsonl'));
    expect(local.id).not.toBe(source.id);
    const legacyImage = SessionLog.open(local.id).last('user/message')?.images?.[0].path;
    expect(legacyImage).toBeDefined();
    expect(legacyImage).not.toBe(image);
    expect(host.readAttachment(legacyImage!).data).toBe(PNG.toString('base64'));

    const packed = await buffer(host.exportSessionBundle(source.id));
    await host.dispose();
    tempHome();
    ({ host } = await mockHost({}));
    const imported = await host.importSessionBundle(Readable.from([packed]));
    expect(imported.id).not.toBe(source.id);
    expect(imported.cwd).toBe(realpathSync(workspace));
    const installed = SessionLog.open(imported.id).last('user/message')?.images?.[0].path;
    expect(installed).toBeDefined();
    expect(readFileSync(installed!)).toEqual(PNG);
    expect(host.readAttachment(installed!)).toEqual({ data: PNG.toString('base64'), mime: 'image/png' });

    await host.dispose();
    ({ host } = await mockHost({}));
    expect(host.listSessions().map(item => item.id)).toEqual([imported.id]);
    expect(deriveMessages(host.getEvents(imported.id)).at(-1)).toMatchObject({
      content: 'portable history', images: [{ data: PNG.toString('base64'), mime: 'image/png' }],
    });
  });

  it('rejects paths, links, size bombs, bad digests, extra bytes and missing references without publishing', async () => {
    const image = 'attachments/example.png';
    const log = Buffer.from(transcript(workspace, { type: 'user/message', text: 'image', images: [{ path: image, mime: 'image/png' }] }));
    const session = entry('session.jsonl', log);
    const attachment = entry(image, PNG);
    const cases: [Buffer, RegExp][] = [
      [encode([session, entry('/escape.png', PNG)], [log, PNG]), /path/i],
      [encode([session, entry('attachments/../escape.png', PNG)], [log, PNG]), /path/i],
      [encode([session, entry('attachments\\escape.png', PNG)], [log, PNG]), /path/i],
      [encode([session, attachment, attachment], [log, PNG, PNG]), /duplicate/i],
      [encode([session, { ...attachment, kind: 'symlink' }], [log, PNG]), /entry/i],
      [encode([session, { ...attachment, size: 20 * 1024 * 1024 + 1 }], [log, PNG]), /size/i],
      [encode([{ ...session, size: 100 * 1024 * 1024 }, attachment], [log, PNG]), /size/i],
      [encode([session, { ...attachment, sha256: '0'.repeat(64) }], [log, PNG]), /digest/i],
      [encode([session, attachment], [log, PNG, Buffer.alloc(100 * 1024 * 1024)]), /trailing|size/i],
      [encode([session, attachment], [log, PNG.subarray(0, 10)]), /truncated/i],
      [encode([session], [log]), /attachment/i],
      [encode([session, entry(image, Buffer.from('script'))], [log, Buffer.from('script')]), /image/i],
    ];
    for (const [payload, reason] of cases) {
      await expect(Promise.resolve().then(() => host.importSessionBundle(Readable.from([payload])))).rejects.toThrow(reason);
      expect(host.listSessions()).toEqual([]);
      expect(readdirSync(SessionLog.dir())).toEqual([]);
    }
  });

  it('exports rewound compactions with sequence pointers that survive reimport', () => {
    const s = host.createSession({ cwd: workspace });
    const log = SessionLog.open(s.id);
    log.append({ type: 'user/message', text: 'Compacted turn' });
    log.append({ type: 'run/status', status: 'running' });
    log.append({ type: 'session/title', title: 'Compaction test' });
    log.append({ type: 'assistant/message', text: 'Historical response', model: 'mock/a', toolCalls: [] });
    log.append({ type: 'context/compaction', summary: 'Compacted history', upToSeq: 4 });
    log.append({ type: 'user/message', text: 'Recent turn' });
    log.append({ type: 'assistant/message', text: 'Recent response', model: 'mock/a', toolCalls: [] });
    log.append({ type: 'user/message', text: 'Rewind target' });
    const forked = host.fork(s.id, { beforeSeq: 8 }).session;
    const imported = host.importSession(host.exportSession(forked.id, 'jsonl'));
    expect(SessionLog.open(imported.id).last('context/compaction')?.upToSeq).toBe(2);
    expect(deriveMessages(host.getEvents(imported.id)).map(message => message.content)).toEqual([
      '[Summary of the earlier conversation]\nCompacted history', 'Understood. Continuing from the summary.', 'Recent turn', 'Recent response',
    ]);
  });

  it('keeps a rewind of historical pending tools inert until a new user turn', async () => {
    const saved = transcript(workspace,
      { type: 'user/message', text: 'First old turn' },
      { type: 'assistant/message', text: '', model: 'mock/a', toolCalls: [call('write_file', { path: 'never.txt', content: 'unsafe' }, 'old-call')] },
      { type: 'user/message', text: 'Second old turn' },
    );
    const imported = host.importSession(saved);
    const forked = host.fork(imported.id, { beforeSeq: 3 }).session;
    expect(pendingToolCalls(host.getEvents(forked.id))).toEqual([]);
    host.resume(forked.id);
    expect(await host.wait(forked.id)).toBeUndefined();
    await host.send(forked.id, 'New turn');
    await host.wait(forked.id);
    expect(SessionLog.open(forked.id).last('assistant/message')?.text).toBe('done');
    expect(existsSync(join(workspace, 'never.txt'))).toBe(false);
  });
});
