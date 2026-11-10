import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homePath } from '../paths.js';
import { DEFAULT_STORAGE, type StoragePreferences } from './preferences.js';
import { record } from './schema.js';
import {
  fingerprintStorageFile, managedStat, scanStorage, storageAnchor, storageHash, STORAGE_CATEGORIES, validStoragePath,
  type InventoryItem, type StorageCategory, type StorageInventory, type StorageItem,
} from './storage-inventory.js';
import { withStorageLock } from './storage-lock.js';

const DAY = 86_400_000;
const MAX_SELECTION = 1000;
const MAX_OPERATION_FILES = 4 * MAX_SELECTION;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const operationId = /^[a-f0-9-]{36}$/;
const digest = /^[a-f0-9]{64}$/;

export interface StoragePreview {
  revision: string;
  items: StorageItem[];
  bytes: number;
  includesProfiles: boolean;
}
export interface StorageConfirmation {
  ids: string[];
  revision: string;
  includeProfiles?: boolean;
  confirmProfiles?: boolean;
}
export interface StorageOperation {
  id: string;
  createdAt: string;
  purgeAfter: string;
  bytes: number;
  pending: number;
  moved: number;
  skipped: number;
  purged: number;
}

type FileState = 'pending' | 'moved' | 'skipped' | 'purging' | 'purged';
interface Entry {
  resource: string;
  category: StorageCategory;
  path: string;
  identity: string;
  anchor: string;
  version: string;
  bytes: number;
  state: FileState;
}
interface Journal {
  version: 1;
  id: string;
  createdAt: string;
  purgeAfter: string;
  entries: Entry[];
}
interface Options {
  preferences?: () => StoragePreferences;
  sessionActive?: (id: string) => boolean;
  now?: () => Date;
  rename?: typeof renameSync;
}

function summary(journal: Journal): StorageOperation {
  const result: StorageOperation = {
    id: journal.id, createdAt: journal.createdAt, purgeAfter: journal.purgeAfter,
    bytes: 0, pending: 0, moved: 0, skipped: 0, purged: 0,
  };
  for (const entry of journal.entries) {
    result[entry.state === 'purging' ? 'pending' : entry.state]++;
    if (entry.state === 'moved') result.bytes += entry.bytes;
  }
  return result;
}

function fsyncDirectory(path: string) {
  if (process.platform === 'win32') return;
  const fd = openSync(homePath(path), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function save(journal: Journal): void {
  const dir = `trash/${journal.id}`;
  const tmp = homePath(dir, `operation-${randomUUID()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(journal), { flag: 'wx', mode: 0o600, flush: true });
    renameSync(tmp, homePath(dir, 'operation.json'));
    fsyncDirectory(dir);
  } finally {
    rmSync(tmp, { force: true });
  }
}

function validEntry(entry: unknown): entry is Entry {
  return record(entry) && typeof entry.resource === 'string'
    && typeof entry.category === 'string' && STORAGE_CATEGORIES.some(category => category === entry.category)
    && typeof entry.path === 'string' && validStoragePath(entry.category as StorageCategory, entry.path)
    && typeof entry.anchor === 'string' && digest.test(entry.anchor)
    && typeof entry.identity === 'string' && digest.test(entry.identity)
    && typeof entry.version === 'string' && digest.test(entry.version)
    && typeof entry.bytes === 'number' && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0
    && ['pending', 'moved', 'skipped', 'purging', 'purged'].some(state => state === entry.state);
}

function journals(): Journal[] {
  const stat = managedStat('trash');
  if (!stat?.isDirectory()) return [];
  const dir = opendirSync(homePath('trash'));
  const result: Journal[] = [];
  try {
    for (let i = 0; i < 30_000; i++) {
      const entry = dir.readSync();
      if (!entry) break;
      const id = entry.name;
      if (!entry.isDirectory() || !operationId.test(id)) continue;
      const file = `trash/${id}/operation.json`;
      const info = managedStat(file);
      if (!info?.isFile() || info.size > BigInt(MAX_JOURNAL_BYTES)) continue;
      try {
        const data: unknown = JSON.parse(readFileSync(homePath(file), 'utf8'));
        if (!record(data) || data.version !== 1 || data.id !== id
          || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))
          || typeof data.purgeAfter !== 'string' || !Number.isFinite(Date.parse(data.purgeAfter))
          || !Array.isArray(data.entries) || data.entries.length > MAX_OPERATION_FILES
          || !data.entries.every(validEntry)) continue;
        if (new Set(data.entries.map(item => item.path)).size !== data.entries.length) continue;
        result.push({
          version: 1, id, createdAt: data.createdAt, purgeAfter: data.purgeAfter, entries: data.entries,
        });
      } catch { /* Ignore unrecognized journals and leave their files in place. */ }
    }
  } finally {
    dir.closeSync();
  }
  return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
}

export class StorageManager {
  constructor(private readonly options: Options = {}) {}

  private scan(includeProfiles = false) {
    return scanStorage({ includeProfiles, sessionActive: this.options.sessionActive });
  }

  inventory(includeProfiles = false): StorageInventory {
    return withStorageLock(() => this.scan(includeProfiles === true).inventory);
  }

  private selection(ids: string[], includeProfiles: boolean, expected?: string) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_SELECTION || ids.some(id => typeof id !== 'string')
      || new Set(ids).size !== ids.length) throw new Error('STORAGE_INVALID: Choose managed data to clean up.');
    const { inventory, records } = this.scan(includeProfiles);
    if (!inventory.complete) throw new Error('STORAGE_INCOMPLETE: The inventory could not be fully verified.');
    const sorted = [...ids].sort();
    const revision = storageHash([inventory.revision, sorted, includeProfiles]);
    if (expected !== undefined && revision !== expected) throw new Error('STORAGE_STALE: Preview the current inventory before moving data.');
    const candidates = new Map(records.map(item => [item.id, item]));
    const selected = sorted.map(id => candidates.get(id));
    if (selected.some(item => !item || item.reason)) throw new Error('STORAGE_INELIGIBLE: A selected item is ineligible for cleanup.');
    return { revision, selected: selected as InventoryItem[] };
  }

  preview(ids: string[], includeProfiles = false): StoragePreview {
    return withStorageLock(() => {
      const { revision, selected } = this.selection(ids, includeProfiles === true);
      return {
        revision,
        items: selected.map(({ files: _files, ...item }) => item),
        bytes: selected.reduce((sum, item) => sum + item.bytes, 0),
        includesProfiles: selected.some(item => item.category === 'browserProfiles'),
      };
    });
  }

  move(input: StorageConfirmation): StorageOperation {
    return withStorageLock(() => {
      if (!input || typeof input.revision !== 'string' || !digest.test(input.revision)) {
        throw new Error('STORAGE_STALE: Preview the current inventory before moving data.');
      }
      const { selected } = this.selection(input.ids, input.includeProfiles === true, input.revision);
      if (selected.some(item => item.category === 'browserProfiles') && input.confirmProfiles !== true) {
        throw new Error('STORAGE_CONFIRM_PROFILE: Browser-profile cleanup needs explicit confirmation.');
      }
      return this.start(selected);
    });
  }

  operations(): StorageOperation[] {
    return withStorageLock(() => journals().slice(0, 50).map(summary));
  }

  reconcile(): boolean {
    return withStorageLock(() => {
      let changed = false;
      const now = (this.options.now?.() ?? new Date()).getTime();
      for (const journal of journals()) {
        if (journal.entries.some(entry => entry.state === 'pending')) {
          const snapshot = this.scan(journal.entries.some(entry => entry.category === 'browserProfiles'));
          if (snapshot.inventory.complete) changed = this.resume(journal, snapshot.records) || changed;
        }
        if (Date.parse(journal.purgeAfter) <= now && !journal.entries.some(entry => entry.state === 'pending')) this.purge(journal);
      }
      return changed;
    });
  }

  retain(): boolean {
    const days = this.options.preferences?.()?.autoCleanupDays ?? 0;
    if (!Number.isSafeInteger(days) || days < 1 || days > 3650) return false;
    return withStorageLock(() => {
      const cutoff = (this.options.now?.() ?? new Date()).getTime() - days * DAY;
      const { inventory, records } = this.scan();
      if (!inventory.complete) return false;
      const old = records.filter(item => !item.reason && (item.id.startsWith('session:') || item.category === 'attachments')
        && Date.parse(item.updatedAt) <= cutoff).slice(0, MAX_SELECTION);
      return old.length > 0 && this.start(old).moved > 0;
    });
  }

  private start(selected: InventoryItem[]): StorageOperation {
    const now = this.options.now?.() ?? new Date();
    const configured = this.options.preferences?.()?.trashDays;
    const trashDays = configured && Number.isSafeInteger(configured) && configured <= 365 && configured > 0
      ? configured : DEFAULT_STORAGE.trashDays;
    const journal: Journal = {
      version: 1, id: randomUUID(), createdAt: now.toISOString(), purgeAfter: new Date(now.getTime() + trashDays * DAY).toISOString(),
      entries: selected.flatMap(item => item.files.map(file => ({
        resource: item.id, category: item.category, path: file.path, identity: file.identity, anchor: file.anchor,
        version: file.version, bytes: file.bytes, state: 'pending' as const,
      }))),
    };
    if (journal.entries.some(entry => !validEntry(entry))) throw new Error('STORAGE_INELIGIBLE: Invalid managed resource.');
    const root = homePath('trash');
    mkdirSync(root, { mode: 0o700, recursive: true });
    if (!lstatSync(root).isDirectory()) throw new Error('Invalid managed trash directory.');
    const path = `trash/${journal.id}`;
    mkdirSync(homePath(path), { mode: 0o700 });
    mkdirSync(homePath(path, 'files'), { mode: 0o700 });
    mkdirSync(homePath(path, 'purging'), { mode: 0o700 });
    save(journal);
    fsyncDirectory('trash');
    this.resume(journal, selected);
    return summary(journal);
  }

  private resume(journal: Journal, records: InventoryItem[]): boolean {
    let changed = false;
    const candidates = new Map(records.filter(item => !item.reason).map(item => [item.id, item]));
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.state !== 'pending') continue;
      const destination = `trash/${journal.id}/files/${index}`;
      if (!managedStat(`trash/${journal.id}/files`)?.isDirectory()) return changed;
      const moved = fingerprintStorageFile(destination);
      const item = candidates.get(entry.resource);
      const source = item?.category === entry.category && item.files.find(file => file.path === entry.path);
      if (moved?.identity === entry.identity) entry.state = 'moved';
      else if (managedStat(destination) || !source || source.version !== entry.version
        || fingerprintStorageFile(entry.path)?.version !== entry.version) entry.state = 'skipped';
      else {
        (this.options.rename ?? renameSync)(homePath(entry.path), homePath(destination));
        fsyncDirectory(entry.path.slice(0, entry.path.lastIndexOf('/')));
        fsyncDirectory(`trash/${journal.id}/files`);
        entry.state = 'moved';
        changed = true;
      }
      save(journal);
    }
    return changed;
  }

  private purge(journal: Journal): void {
    const dir = `trash/${journal.id}`;
    if (!managedStat(`${dir}/files`)?.isDirectory() || !managedStat(`${dir}/purging`)?.isDirectory()) return;
    for (const [index, entry] of journal.entries.entries()) {
      if (entry.state !== 'moved' && entry.state !== 'purging') continue;
      const stored = `${dir}/files/${index}`;
      const purging = `${dir}/purging/${index}`;
      if (!managedStat(purging) && managedStat(stored)) {
        if (fingerprintStorageFile(stored)?.identity !== entry.identity) continue;
        entry.state = 'purging';
        save(journal);
        renameSync(homePath(stored), homePath(purging));
        fsyncDirectory(`${dir}/files`);
        fsyncDirectory(`${dir}/purging`);
      }
      const staged = managedStat(purging);
      if (staged) {
        if (entry.state !== 'purging' || storageAnchor(staged) !== entry.anchor || managedStat(stored)) continue;
        rmSync(homePath(purging), { recursive: true, force: true });
        fsyncDirectory(`${dir}/purging`);
      }
      entry.state = 'purged';
      save(journal);
    }
  }
}
