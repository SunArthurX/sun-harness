import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { buffer } from 'node:stream/consumers';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveMessages, HarnessHost, homePath, MockProvider, SessionLog, type AppshotAdapter } from '../src/index.js';
import { AppshotDrafts } from '../src/settings/capture.js';
import { tempHome, tempWorkspace, testConfig } from './helpers.js';

const clean = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6Q0AAAAASUVORK5CYII=', 'base64');
const raw = Buffer.concat([clean, Buffer.from('private fixture pixels')]);
const image = { mime: 'image/png' as const, width: 1, height: 1, data: raw.toString('base64') };
const actual = { appId: 'fixture.actual', windowId: 'two', title: 'Actual window' };
const intended = { appId: 'fixture.intended', windowId: 'one', title: 'Intended window' };
const mask = { x: 0, y: 0, width: 1, height: 1 };
const done = { text: 'Done', toolCalls: [] };
const adapter = (): AppshotAdapter => ({
  status: () => 'available',
  capture: async () => ({ ...image, ...actual, intendedWindow: intended, text: 'private text covered by the mask' }),
  render: async source => ({ ...source, data: clean.toString('base64') }),
});

let host: HarnessHost | undefined;
beforeEach(() => tempHome());
afterEach(async () => { await host?.dispose(); host = undefined; });

describe('Appshot draft and durable replay', () => {
  it('sends only the prepared image, verifies it on replay, and preserves the receipt in portable history', async () => {
    const native = adapter();
    const render = vi.spyOn(native, 'render');
    const provider = new MockProvider();
    host = new HarnessHost({ config: testConfig(), connectMcp: false, shellHooks: false, loadPlugins: false,
      nativeCapabilities: { appshots: native }, providerFactory: () => ({ provider, model: 'vision' }) });
    await host.init();
    const workspace = tempWorkspace();
    const session = host.createSession({ cwd: workspace, model: 'mock/vision' });
    const other = host.createSession({ cwd: workspace });
    const preview = await host.captureAppshot(session.id);
    expect(preview).toMatchObject({ ...actual, intendedWindow: intended, targetChanged: true });
    expect(existsSync(homePath('attachments', session.id))).toBe(false);
    expect(host.getEvents(session.id)).toHaveLength(1);
    await expect(host.prepareAppshot(other.id, preview.id, { masks: [], includeText: true })).rejects.toThrow(/DRAFT_STALE/);
    host.cancelAppshot(session.id, preview.id);
    await expect(host.sendAppshotMessage(session.id, 'Never sent', [], preview.id)).rejects.toThrow(/DRAFT_STALE/);
    expect(host.getEvents(session.id)).toHaveLength(1);

    const fresh = await host.captureAppshot(session.id);
    await expect(host.prepareAppshot(session.id, fresh.id, { masks: [{ ...mask, width: 2 }], includeText: true }))
      .rejects.toThrow(/EDITS_INVALID/);
    const prepared = await host.prepareAppshot(session.id, fresh.id, { masks: [mask], includeText: true });
    expect(render).toHaveBeenCalledWith(image, { masks: [mask], includeText: true });
    expect(prepared.metadata.text).toBeUndefined();
    expect(prepared.data).toBe(clean.toString('base64'));
    expect(existsSync(homePath('attachments', session.id))).toBe(false);

    provider.push(request => {
      const events = SessionLog.open(session.id).all();
      const event = events.find(entry => entry.type === 'user/message');
      const [attachment] = event?.images ?? [];
      expect(attachment?.appshot).toMatchObject({ ...actual, bytes: clean.length,
        sha256: createHash('sha256').update(clean).digest('hex') });
      expect(readFileSync(attachment!.path)).toEqual(clean);
      expect(request.messages.at(-1)).toMatchObject({ role: 'user', images: [{ mime: image.mime, data: prepared.data }] });
      expect(request.messages.at(-1)?.content).toContain('Actual window');
      expect(JSON.stringify(events)).not.toContain(raw.toString('base64'));
      expect(JSON.stringify(events)).not.toContain('private text');
      return done;
    });
    await host.sendAppshotMessage(session.id, 'Describe the Appshot', [], prepared.id);
    await host.wait(session.id);
    await expect(host.sendAppshotMessage(session.id, 'Duplicate', [], prepared.id)).rejects.toThrow(/DRAFT_STALE/);
    const events = SessionLog.open(session.id).all();
    const event = events.find(entry => entry.type === 'user/message')!;
    expect(events.some(entry => entry.type === 'request/header' && entry.vision === true)).toBe(true);
    const bundle = await buffer(host.exportSessionBundle(session.id));
    const imported = await host.importSessionBundle(Readable.from([bundle]), { cwd: workspace });
    const importedEvents = SessionLog.open(imported.id).all();
    expect(importedEvents.find(entry => entry.type === 'user/message')?.images?.[0]?.appshot).toEqual(event.images?.[0]?.appshot);
    expect(deriveMessages(importedEvents)[0]).toEqual(deriveMessages(events)[0]);

    await host.dispose();
    host = undefined;
    expect(deriveMessages(SessionLog.open(session.id).all())[0]).toMatchObject({
      images: [{ mime: image.mime, data: prepared.data }],
    });
    writeFileSync(event.images![0].path, raw);
    const replay = deriveMessages(SessionLog.open(session.id).all())[0];
    expect(replay).not.toHaveProperty('images');
    expect(replay.content).toContain('1 attached image(s) no longer available');
  });

  it('projects the approved text on text-only models and reports permission denial', async () => {
    const native = adapter();
    const provider = new MockProvider();
    host = new HarnessHost({ config: testConfig(), connectMcp: false, shellHooks: false, loadPlugins: false,
      nativeCapabilities: { appshots: native }, providerFactory: () => ({ provider, model: 'text-only' }) });
    await host.init();
    const session = host.createSession({ cwd: tempWorkspace() });
    const status = vi.spyOn(native, 'status').mockReturnValue({ state: 'unavailable', reasonCode: 'APPSHOT_SCREEN_PERMISSION' });
    await expect(host.captureAppshot(session.id)).rejects.toThrow(/APPSHOT_SCREEN_PERMISSION/);
    status.mockRestore();

    const preview = await host.captureAppshot(session.id);
    const prepared = await host.prepareAppshot(session.id, preview.id, { masks: [], includeText: true });
    provider.push(request => {
      expect(request.messages.at(-1)).not.toHaveProperty('images');
      expect(request.messages.at(-1)?.content).toContain('private text covered by the mask');
      expect(request.messages.at(-1)?.content).toContain('cannot see images');
      return done;
    });
    await host.sendAppshotMessage(session.id, 'Read my approved text', [], prepared.id);
    await host.wait(session.id);
    expect(host.getEvents(session.id).some(entry => entry.type === 'request/header' && entry.vision === false)).toBe(true);
  });

  it('expires private drafts and bounds the extracted text', async () => {
    vi.useFakeTimers();
    const drafts = new AppshotDrafts();
    try {
      const native = adapter();
      vi.spyOn(native, 'capture').mockResolvedValue({ ...image, ...actual, text: 'a'.repeat(20_001) });
      const preview = await drafts.capture('first', native);
      expect(preview.text).toHaveLength(20_000);
      expect(preview.textTruncated).toBe(true);
      await expect(drafts.capture('other', native)).rejects.toThrow(/DRAFT_BUSY/);
      vi.advanceTimersByTime(5 * 60_000);
      await expect(drafts.prepare('first', preview.id, { masks: [], includeText: true }, native)).rejects.toThrow(/DRAFT_STALE/);
      const next = await drafts.capture('other', native);
      expect(next.id).not.toBe(preview.id);
    } finally { drafts.dispose(); vi.useRealTimers(); }
  });
});
