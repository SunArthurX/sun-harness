import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SettingsConfigError } from './schema.js';

type Document = Record<string, unknown>;

export interface SettingsFile {
  document: Document;
  revision: string;
}

type Edit = { document: Document } | { fields: Record<string, string> };
type FileFailure = 'BUSY' | 'CONFLICT' | 'INVALID' | 'IO_ERROR';

export type SettingsFileResult =
  | { ok: true; file: SettingsFile; durability: 'confirmed' | 'uncertain' }
  | { ok: false; code: FileFailure; fields?: Record<string, string> };

interface FileOperations {
  write?: typeof writeFileSync;
  replace?: typeof renameSync;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

function revision(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function readSettingsFile(file: string): SettingsFile {
  let bytes: Buffer;
  try {
    bytes = readFileSync(file);
  } catch (error) {
    if (code(error) === 'ENOENT') return { document: {}, revision: 'missing' };
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new SettingsConfigError('INVALID_CONFIG', `Invalid JSON in ${file}`);
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new SettingsConfigError('INVALID_CONFIG', `Expected a JSON object in ${file}`);
  }
  return { document: document as Document, revision: revision(bytes) };
}

const sleepCell = new Int32Array(new SharedArrayBuffer(4));
const ownerPattern = /^(\d+)-(\d+)-[a-f0-9-]{36}$/;

function ownerIsDead(owner: string): boolean {
  const pid = Number(ownerPattern.exec(owner)?.[1]);
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // An inaccessible or reused PID is treated as live. Age alone cannot authorize recovery.
    return code(error) === 'ESRCH';
  }
}

function removeEmptyLock(path: string): void {
  try { rmdirSync(path); } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error;
  }
}

function recoverLock(file: string, lock: string): void {
  let owners: string[];
  try {
    if (!lstatSync(lock).isDirectory()) throw new Error('Configuration lock must be a directory');
    owners = readdirSync(lock);
  } catch (error) {
    if (code(error) === 'ENOENT') return;
    throw error;
  }
  if (owners.length === 0) {
    removeEmptyLock(lock);
    return;
  }
  if (owners.length !== 1 || !ownerIsDead(owners[0])) return;
  const owner = owners[0];
  // Each owner has a unique marker. A competing recovery can never unlink a new owner's marker.
  rmSync(`${file}.${owner}.tmp`, { force: true });
  try { unlinkSync(join(lock, owner)); } catch (error) {
    if (code(error) !== 'ENOENT') throw error;
  }
  removeEmptyLock(lock);
}

function acquireLock(file: string, owner: string): (() => void) | undefined {
  const lock = `${file}.lock`;
  const staging = mkdtempSync(`${lock}-staging-`);
  try {
    writeFileSync(join(staging, owner), '', { mode: 0o600, flag: 'wx' });
    const deadline = performance.now() + 500;
    do {
      try {
        // Publish a populated directory atomically. Rename cannot replace another populated lock.
        renameSync(staging, lock);
        return () => {
          unlinkSync(join(lock, owner));
          removeEmptyLock(lock);
        };
      } catch (error) {
        if (!['ENOTEMPTY', 'EEXIST', 'EPERM'].includes(code(error) ?? '')) throw error;
        recoverLock(file, lock);
        Atomics.wait(sleepCell, 0, 0, 10);
      }
    } while (performance.now() < deadline);
    return undefined;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** Serialize a synchronous transaction using the same crash-recoverable owner lock as settings writes. */
export function withFileLock<T>(file: string, action: () => T): T {
  const owner = `${process.pid}-${Math.trunc(performance.timeOrigin)}-${randomUUID()}`;
  const release = acquireLock(file, owner);
  if (!release) throw new Error('STORAGE_BUSY: Another process is changing managed data.');
  try { return action(); } finally { release(); }
}

function privateMode(file: string): number {
  try {
    const info = lstatSync(file);
    if (!info.isFile()) throw new Error('Configuration must be a regular file');
    return info.mode & 0o600;
  } catch (error) {
    if (code(error) === 'ENOENT') return 0o600;
    throw error;
  }
}

function flushDirectory(path: string): 'confirmed' | 'uncertain' {
  if (process.platform === 'win32') return 'uncertain';
  try {
    const fd = openSync(path, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return 'confirmed';
  } catch {
    return 'uncertain';
  }
}

/** Serialize cooperating writers, then atomically replace the file at the checked revision. */
export function transactSettingsFile(
  file: string,
  expectedRevision: string | undefined,
  edit: (current: SettingsFile) => Edit,
  operations: FileOperations = {},
): SettingsFileResult {
  const parent = dirname(file);
  const owner = `${process.pid}-${Math.trunc(performance.timeOrigin)}-${randomUUID()}`;
  const temp = `${file}.${owner}.tmp`;
  let release: (() => void) | undefined;
  let committed: SettingsFile | undefined;
  let durability: 'confirmed' | 'uncertain' = 'uncertain';
  let ownsTemp = false;
  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    release = acquireLock(file, owner);
    if (!release) return { ok: false, code: 'BUSY' };
    const current = readSettingsFile(file);
    if (expectedRevision !== undefined && current.revision !== expectedRevision) return { ok: false, code: 'CONFLICT' };
    const next = edit(current);
    if ('fields' in next) return { ok: false, code: 'INVALID', fields: next.fields };
    const bytes = Buffer.from(JSON.stringify(next.document, null, 2) + '\n');
    const fd = openSync(temp, 'wx', privateMode(file));
    ownsTemp = true;
    try {
      (operations.write ?? writeFileSync)(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (readSettingsFile(file).revision !== current.revision) return { ok: false, code: 'CONFLICT' };
    (operations.replace ?? renameSync)(temp, file);
    committed = { document: next.document, revision: revision(bytes) };
    durability = flushDirectory(parent);
    return { ok: true, file: committed, durability };
  } catch (error) {
    if (committed) return { ok: true, file: committed, durability };
    if (error instanceof SettingsConfigError) {
      return { ok: false, code: 'INVALID', ...(error.fields ? { fields: error.fields } : {}) };
    }
    return { ok: false, code: 'IO_ERROR' };
  } finally {
    try {
      if (ownsTemp) rmSync(temp, { force: true });
    } finally {
      release?.();
    }
  }
}
