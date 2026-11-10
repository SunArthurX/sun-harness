import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homePath } from '../paths.js';
import { withFileLock } from './store.js';

const held = new Set<string>();
function controlRoot(): string {
  const dir = homePath('data-control');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(dir).isDirectory()) throw new Error('Invalid managed data control directory.');
  return dir;
}

export function withStorageLock<T>(action: () => T): T {
  const lock = join(controlRoot(), 'storage');
  if (held.has(lock)) return action();
  return withFileLock(lock, () => {
    held.add(lock);
    try { return action(); } finally { held.delete(lock); }
  });
}

function activityDir(resource: string): string {
  const key = createHash('sha256').update(resource).digest('hex');
  return join(controlRoot(), `activity-${key}`);
}

export function hasDataActivity(resource: string): boolean {
  const dir = activityDir(resource);
  const info = lstatSync(dir, { throwIfNoEntry: false });
  if (!info) return false;
  if (!info.isDirectory()) return true;
  return readdirSync(dir).some(name => {
    const pid = Number(/^(\d+)-[a-f0-9-]{36}$/.exec(name)?.[1]);
    if (!Number.isSafeInteger(pid) || pid < 1) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
  });
}

/** Protect files while an operation awaits a hook, model, browser, or other external work. */
export function holdDataActivity(resource: string, check?: () => void): () => void {
  return withStorageLock(() => {
    check?.();
    const dir = activityDir(resource);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!lstatSync(dir).isDirectory()) throw new Error('Invalid managed data activity directory.');
    const file = join(dir, `${process.pid}-${randomUUID()}`);
    writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
    return () => {
      try { unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    };
  });
}
