import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readFileSync, readlinkSync, realpathSync, type BigIntStats } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { SessionLog } from '../log.js';
import { homePath } from '../paths.js';
import { record } from './schema.js';
import { hasDataActivity } from './storage-lock.js';

export const STORAGE_CATEGORIES = ['sessions', 'attachments', 'caches', 'jobs', 'browserProfiles', 'worktrees'] as const;
export type StorageCategory = typeof STORAGE_CATEGORIES[number];
export type StorageProtection = 'ACTIVE' | 'REFERENCED' | 'UNARCHIVED' | 'WORKTREE' | 'PROTECTED' | 'PROFILE_SCOPE';

export interface StorageItem {
  id: string;
  category: StorageCategory;
  label: string;
  bytes: number;
  updatedAt: string;
  reason?: StorageProtection;
}

export interface StorageInventory {
  revision: string;
  complete: boolean;
  totals: Record<StorageCategory, { items: number; bytes: number }>;
  items: StorageItem[];
}

export interface StorageFile {
  path: string;
  identity: string;
  anchor: string;
  version: string;
  bytes: number;
  modified: number;
}
export interface InventoryItem extends StorageItem {
  files: StorageFile[];
}

const NODE_LIMIT = 30_000;
const LOG_BYTES_LIMIT = 256 * 1024 * 1024;
const safeId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const token = '[A-Za-z0-9][A-Za-z0-9_.-]{0,127}';
const sessionLogPath = new RegExp(`^sessions/(?:${token}\\.jsonl|${token}/session\\.jsonl)$`);
const checkpointPath = new RegExp(`^checkpoints/${token}$`);
const attachmentPath = new RegExp(`^(?:attachments/${token}|sessions/${token}/attachments)/[^/\\\\]+$`);
const jobPath = new RegExp(`^jobs/${token}\\.(?:json|log|exit)$`);
const profilePath = /^browser\/(?:profiles|docker-profiles)\/[A-Za-z0-9_.-]{1,128}$/;

export const storageHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function validStoragePath(category: StorageCategory, path: string): boolean {
  if (path.includes('\0') || path.split('/').some(part => part === '.' || part === '..')) return false;
  switch (category) {
    case 'sessions': return sessionLogPath.test(path) || checkpointPath.test(path);
    case 'attachments': return attachmentPath.test(path);
    case 'jobs': return jobPath.test(path);
    case 'caches': return path === 'kb-index/embeddings.json';
    case 'browserProfiles': return profilePath.test(path);
    case 'worktrees': return false;
  }
}

export function managedStat(path: string): BigIntStats | undefined {
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\\0]/.test(part))) return;
  let current = homePath();
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const info = lstatSync(current, { bigint: true, throwIfNoEntry: false });
    if (!info || (index < parts.length - 1 && !info.isDirectory())) return;
    if (index === parts.length - 1) return info;
  }
}

export function storageAnchor(info: BigIntStats): string {
  return storageHash([String(info.dev), String(info.ino), String(info.birthtimeNs), String(info.mode)]);
}

class Scanner {
  private visited = 0;
  complete = true;

  children(path: string): string[] {
    const info = managedStat(path);
    if (!info) return [];
    if (!info.isDirectory()) {
      this.complete = false;
      return [];
    }
    const dir = opendirSync(homePath(path));
    const names: string[] = [];
    try {
      while (this.visited < NODE_LIMIT) {
        const entry = dir.readSync();
        if (!entry) return names.sort();
        this.visited++;
        names.push(entry.name);
      }
      this.complete = false;
      return names.sort();
    } finally {
      dir.closeSync();
    }
  }

  file(path: string): StorageFile | undefined {
    const root = managedStat(path);
    if (!root || (!root.isFile() && !root.isDirectory())) return;
    let bytes = 0;
    let modified = 0;
    const identity = createHash('sha256');
    const version = createHash('sha256');
    const walk = (current: string, suffix: string, info: BigIntStats, depth: number) => {
      const fields = [suffix, info.dev, info.ino, info.mode, info.size, info.birthtimeNs, info.mtimeNs].map(String);
      identity.update(JSON.stringify(fields));
      version.update(JSON.stringify([...fields, String(info.ctimeNs)]));
      if (info.isFile()) bytes += Number(info.size);
      modified = Math.max(modified, Number(info.mtimeMs));
      if (!info.isDirectory()) return;
      if (depth >= 40) { this.complete = false; return; }
      for (const name of this.children(current)) {
        const child = `${current}/${name}`;
        const stat = managedStat(child);
        if (stat) walk(child, `${suffix}/${name}`, stat, depth + 1);
      }
    };
    walk(path, '', root, 0);
    return { path, anchor: storageAnchor(root), identity: identity.digest('hex'), version: version.digest('hex'), bytes, modified };
  }
}

/** Trash destinations use the same identity rules as source items. */
export function fingerprintStorageFile(path: string): StorageFile | undefined {
  const scan = new Scanner();
  const file = scan.file(path);
  return scan.complete ? file : undefined;
}

function stoppedProfile(path: string, allowProbe: boolean): boolean {
  if (hasDataActivity(path)) return false;
  if (path.startsWith('browser/docker-profiles/')) {
    if (!allowProbe) return true;
    const result = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', `sun-browser-${basename(path)}`],
      { encoding: 'utf8', timeout: 1500, maxBuffer: 16 * 1024 });
    return (result.status === 0 && result.stdout.trim() === 'false')
      || (result.status === 1 && /No such (?:object|container)/i.test(result.stderr));
  }
  const lockPath = `${path}/SingletonLock`;
  const lock = managedStat(lockPath);
  if (!lock) return !['SingletonSocket', 'DevToolsActivePort'].some(name => managedStat(`${path}/${name}`));
  if (!lock.isSymbolicLink()) return false;
  const owner = /^(.*)-(\d+)$/.exec(readlinkSync(homePath(lockPath)));
  const pid = Number(owner?.[2]);
  if (owner?.[1] !== hostname() || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

function liveProcess(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

export function scanStorage(options: { includeProfiles?: boolean; sessionActive?: (id: string) => boolean } = {}): {
  inventory: StorageInventory; records: InventoryItem[];
} {
  const scan = new Scanner();
  const records: InventoryItem[] = [];
  const referencePaths = new Set<string>();
  const activeSessions = new Set<string>();
  const activeJobs = new Set<string>();
  const jobMetadata = new Map<string, unknown>();
  const eventJobs = new Map<string, { sessionId: string; active: boolean }>();
  const jobNames = scan.children('jobs');
  const jobIds = new Set(jobNames.map(name => /^(.*)\.(?:json|log|exit)$/.exec(name)?.[1]).filter((id): id is string => !!id && safeId.test(id)));
  function item(id: string, category: StorageCategory, label: string, files: (StorageFile | undefined)[], reason?: StorageProtection) {
    const present = files.filter((file): file is StorageFile => file !== undefined);
    if (!present.length) return;
    records.push({
      id, category, label, files: present, bytes: present.reduce((sum, file) => sum + file.bytes, 0),
      updatedAt: new Date(Math.max(...present.map(file => file.modified))).toISOString(), ...(reason ? { reason } : {}),
    });
  }
  for (const id of jobIds) {
    let metadata: unknown;
    const path = `jobs/${id}.json`;
    const info = managedStat(path);
    if (info?.isFile() && info.size <= 1024n * 1024n) {
      try { metadata = JSON.parse(readFileSync(homePath(path), 'utf8')); } catch { /* Protected below. */ }
    }
    jobMetadata.set(id, metadata);
    if (record(metadata) && metadata.id === id && (metadata.state === 'running' || liveProcess(metadata.pid))) {
      activeJobs.add(id);
      if (typeof metadata.sessionId === 'string') activeSessions.add(metadata.sessionId);
    }

  }

  const sessions = new Map<string, { summary: NonNullable<ReturnType<SessionLog['summary']>>; file: StorageFile }>();
  const related = new Set<string>();
  const nested = new Set<string>();
  let logBytes = 0;
  for (const entry of scan.children('sessions')) {
    if (entry.startsWith('.import-')) continue;
    const stat = managedStat(`sessions/${entry}`);
    if (stat?.isSymbolicLink() && safeId.test(entry)) { scan.complete = false; continue; }
    if (stat?.isDirectory() && safeId.test(entry)) nested.add(entry);
    const id = stat?.isDirectory() ? entry : stat?.isFile() && entry.endsWith('.jsonl') ? entry.slice(0, -6) : '';
    if (!safeId.test(id)) continue;
    const path = stat?.isDirectory() ? `sessions/${id}/session.jsonl` : `sessions/${id}.jsonl`;
    const logStat = managedStat(path);
    if (!logStat) continue;
    logBytes += Number(logStat.size);
    if (!logStat.isFile() || logBytes > LOG_BYTES_LIMIT || sessions.has(id)) {
      scan.complete = false;
      continue;
    }
    try {
      const log = SessionLog.open(id);
      const summary = log.summary();
      const file = scan.file(path);
      if (!summary || summary.id !== id || !file || resolve(log.file) !== resolve(homePath(path))) { scan.complete = false; continue; }
      sessions.set(id, { summary, file });
      if (summary.parent) related.add(summary.parent);
      if (['running', 'awaiting_approval', 'paused'].includes(summary.status)) activeSessions.add(id);
      for (const event of log.all()) {
        if (event.type === 'job/started') eventJobs.set(event.jobId, { sessionId: id, active: true });
        if (event.type === 'job/finished') eventJobs.set(event.jobId, { sessionId: id, active: false });
        if (event.type === 'user/message') {
          for (const image of event.images ?? []) {
            if (typeof image.path === 'string') referencePaths.add(canonical(image.path));
          }
        }
      }
    } catch {
      scan.complete = false;
    }
  }

  for (const id of jobIds) {
    const metadata = jobMetadata.get(id);
    const history = eventJobs.get(id);
    if (history?.active) { activeJobs.add(id); activeSessions.add(history.sessionId); }
    const finished = (record(metadata) && metadata.id === id && ['done', 'failed', 'killed', 'lost'].some(state => state === metadata.state))
      || history?.active === false;
    item(`job:${id}`, 'jobs', id, ['log', 'exit', 'json'].map(ext => scan.file(`jobs/${id}.${ext}`)),
      activeJobs.has(id) ? 'ACTIVE' : finished ? undefined : 'PROTECTED');
  }

  const active = (id: string) => activeSessions.has(id) || !!options.sessionActive?.(id) || hasDataActivity(`session:${id}`);
  for (const [id, { summary, file }] of sessions) {
    const reason = active(id) || (summary.parent && active(summary.parent)) ? 'ACTIVE' : summary.worktree && !summary.worktree.closed ? 'WORKTREE'
      : related.has(id) ? 'REFERENCED' : summary.archived ? undefined : 'UNARCHIVED';
    item(`session:${id}`, 'sessions', summary.title, [scan.file(`checkpoints/${id}`), file], reason);
  }
  for (const id of scan.children('checkpoints')) {
    if (safeId.test(id) && !sessions.has(id)) item(`checkpoint:${id}`, 'sessions', id, [scan.file(`checkpoints/${id}`)], active(id) ? 'ACTIVE' : undefined);
  }

  function attachments(root: string, owner: string) {
    for (const name of scan.children(root)) {
      const path = `${root}/${name}`;
      if (!validStoragePath('attachments', path) || !managedStat(path)?.isFile()) continue;
      const reason = referencePaths.has(canonical(homePath(path))) ? 'REFERENCED' : active(owner) ? 'ACTIVE' : undefined;
      item(`attachment:${storageHash(path)}`, 'attachments', name, [scan.file(path)], reason);
    }
  }
  for (const id of scan.children('attachments')) {
    if (safeId.test(id) && managedStat(`attachments/${id}`)?.isDirectory()) attachments(`attachments/${id}`, id);
  }
  for (const id of nested) attachments(`sessions/${id}/attachments`, id);

  item('cache:embeddings', 'caches', 'embeddings.json', [scan.file('kb-index/embeddings.json')]);
  for (const root of ['browser/profiles', 'browser/docker-profiles']) {
    for (const name of scan.children(root)) {
      const path = `${root}/${name}`;
      if (!validStoragePath('browserProfiles', path) || !managedStat(path)?.isDirectory()) continue;
      const reason = !stoppedProfile(path, !!options.includeProfiles) ? 'ACTIVE' : options.includeProfiles ? undefined : 'PROFILE_SCOPE';
      item(`profile:${storageHash(path)}`, 'browserProfiles', name, [scan.file(path)], reason);
    }
  }
  for (const name of scan.children('worktrees')) {
    if (managedStat(`worktrees/${name}`)?.isDirectory()) item(`worktree:${storageHash(name)}`, 'worktrees', name, [scan.file(`worktrees/${name}`)], 'WORKTREE');
  }
  records.sort((a, b) => a.id.localeCompare(b.id));
  const totals = Object.fromEntries(STORAGE_CATEGORIES.map(category => [category, { items: 0, bytes: 0 }])) as StorageInventory['totals'];
  for (const entry of records) {
    totals[entry.category].items++;
    totals[entry.category].bytes += entry.bytes;
  }
  const inventory = {
    revision: storageHash([scan.complete, records]),
    complete: scan.complete,
    totals,
    items: records.map(({ files: _files, ...entry }) => entry),
  };
  return { inventory, records };
}
