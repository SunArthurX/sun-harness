import { mkdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { homePath, SessionLog, type HarnessHost } from '../src/index.js';
import { holdDataActivity } from '../src/settings/storage-lock.js';
import { StorageManager } from '../src/settings/storage.js';
import { mockHost, tempHome, tempWorkspace } from './helpers.js';

let host: HarnessHost;
let workspace: string;

beforeEach(async () => {
  tempHome();
  workspace = tempWorkspace();
  ({ host } = await mockHost({}));
});
afterEach(async () => { await host.dispose(); });

function attachment(owner: string, name = 'image.png'): string {
  const dir = homePath('attachments', owner);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, 'fixture attachment');
  return file;
}

describe('managed storage', () => {
  it('protects active sessions, unfinished jobs, and attachments shared by a retained session', () => {
    const owner = host.createSession({ cwd: workspace, title: 'Archived owner' });
    host.setSessionFlags(owner.id, { archived: true });
    const retaining = host.createSession({ cwd: workspace });
    const shared = attachment(owner.id);
    SessionLog.open(retaining.id).append({ type: 'user/message', text: 'shared', images: [{ path: shared, mime: 'image/png' }] });
    attachment(owner.id, 'orphan.png');
    const release = holdDataActivity(`session:${owner.id}`);
    try {
      const inventory = host.storageInventory();
      expect(inventory.items.find(item => item.id === `session:${owner.id}`)?.reason).toBe('ACTIVE');
      expect(inventory.items.find(item => item.label === 'image.png')?.reason).toBe('REFERENCED');
      expect(inventory.items.find(item => item.label === 'orphan.png')?.reason).toBe('ACTIVE');
    } finally {
      release();
    }
    mkdirSync(homePath('jobs'), { recursive: true });
    writeFileSync(homePath('jobs', 'working.json'), JSON.stringify({ id: 'working', sessionId: owner.id, state: 'running' }));
    const inventory = host.storageInventory();
    expect(inventory.items.find(item => item.id === `session:${owner.id}`)?.reason).toBe('ACTIVE');
    expect(inventory.items.find(item => item.id === 'job:working')?.reason).toBe('ACTIVE');
    expect(() => host.previewStorage([inventory.items.find(item => item.label === 'image.png')!.id])).toThrow(/ineligible/i);
  });

  it('rejects stale confirmation and restores an archive without changing the ID', () => {
    const session = host.createSession({ cwd: workspace });
    const id = `session:${session.id}`;
    host.setSessionFlags(session.id, { archived: true });
    const preview = host.previewStorage([id]);
    expect(host.setSessionFlags(session.id, { archived: false })).toMatchObject({ id: session.id });
    expect(() => host.moveStorage({ ids: [id], revision: preview.revision })).toThrow(/STALE/);
    expect(SessionLog.exists(session.id)).toBe(true);
    expect(host.listSessions().find(item => item.id === session.id)?.archived).toBeUndefined();
  });

  it('reconciles a rename before its progress record and preserves a new source at the same path', () => {
    const first = attachment('orphan-owner', 'first.png');
    const second = attachment('orphan-owner', 'second.png');
    const manager = new StorageManager({ rename: (from, to) => {
      renameSync(from, to);
      throw new Error('interrupted after rename');
    } });
    const ids = manager.inventory().items.map(item => item.id);
    const preview = manager.preview(ids);
    expect(() => manager.move({ ids, revision: preview.revision })).toThrow(/interrupted/);
    writeFileSync(first, 'new first file');
    writeFileSync(second, 'new second file');
    const restarted = new StorageManager();
    restarted.reconcile();
    expect(readFileSync(first, 'utf8')).toBe('new first file');
    expect(readFileSync(second, 'utf8')).toBe('new second file');
    expect(restarted.operations()[0]).toMatchObject({ moved: 1, skipped: 1, pending: 0 });
  });

  it('keeps automatic retention off until configured, then selects only expired eligible data', () => {
    const old = attachment('owner', 'old.png');
    const recent = attachment('owner', 'recent.png');
    const cache = homePath('kb-index', 'embeddings.json');
    mkdirSync(homePath('kb-index'), { recursive: true });
    writeFileSync(cache, '{}');
    const before = new Date('2026-01-01T00:00:00Z');
    const after = new Date('2026-01-15T00:00:00Z');
    utimesSync(old, before, before);
    utimesSync(cache, before, before);
    utimesSync(recent, after, after);
    const now = () => after;
    expect(new StorageManager({ now }).retain()).toBe(false);
    expect(readFileSync(old, 'utf8')).toBe('fixture attachment');
    const configured = new StorageManager({ now, preferences: () => ({ autoCleanupDays: 7, trashDays: 2 }) });
    expect(configured.retain()).toBe(true);
    expect(() => readFileSync(old)).toThrow();
    expect(readFileSync(recent, 'utf8')).toBe('fixture attachment');
    expect(readFileSync(cache, 'utf8')).toBe('{}');
    expect(configured.operations()[0]).toMatchObject({ moved: 1, purgeAfter: '2026-01-17T00:00:00.000Z' });
  });

  it('finishes a partially purged private directory without touching a new live profile', () => {
    const relative = 'browser/profiles/old';
    const profile = homePath(relative);
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'Cookies'), 'old cookies');
    writeFileSync(join(profile, 'Preferences'), 'old preferences');
    const initial = new StorageManager({ now: () => new Date('2026-01-01T00:00:00Z') });
    const ids = [initial.inventory(true).items.find(item => item.category === 'browserProfiles')!.id];
    const op = initial.move({ ids, revision: initial.preview(ids, true).revision, includeProfiles: true, confirmProfiles: true });
    const journalPath = homePath('trash', op.id, 'operation.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
    journal.entries[0].state = 'purging';
    writeFileSync(journalPath, JSON.stringify(journal));
    const purging = homePath('trash', op.id, 'purging', '0');
    renameSync(homePath('trash', op.id, 'files', '0'), purging);
    unlinkSync(join(purging, 'Cookies'));
    mkdirSync(profile);
    writeFileSync(join(profile, 'Cookies'), 'new cookies');
    new StorageManager({ now: () => new Date('2026-01-08T00:00:00Z') }).reconcile();
    expect(initial.operations()[0]).toMatchObject({ moved: 0, purged: 1, pending: 0 });
    expect(readFileSync(join(profile, 'Cookies'), 'utf8')).toBe('new cookies');
  });

  it('requires specific browser-profile confirmation and purges only after the grace period', () => {
    const profile = homePath('browser', 'profiles', 'stopped');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'Cookies'), 'synthetic sign-in data');
    const manager = new StorageManager({ now: () => new Date('2026-01-01T00:00:00Z') });
    const item = manager.inventory().items.find(item => item.category === 'browserProfiles')!;
    expect(() => manager.preview([item.id])).toThrow(/ineligible/i);
    const preview = manager.preview([item.id], true);
    expect(() => manager.move({ ids: [item.id], revision: preview.revision, includeProfiles: true })).toThrow(/confirmation/i);
    const moved = manager.move({ ids: [item.id], revision: preview.revision, includeProfiles: true, confirmProfiles: true });
    expect(moved).toMatchObject({ moved: 1, purgeAfter: '2026-01-08T00:00:00.000Z' });
    new StorageManager({ now: () => new Date('2026-01-07T23:59:59Z') }).reconcile();
    expect(manager.operations()[0].purged).toBe(0);
    new StorageManager({ now: () => new Date('2026-01-08T00:00:00Z') }).reconcile();
    expect(manager.operations()[0].purged).toBe(1);
  });
});
