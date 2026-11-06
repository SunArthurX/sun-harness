import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

export function sunHome(): string {
  return process.env.SUN_HOME || join(homedir(), '.sun');
}

export function homePath(...parts: string[]): string {
  return join(sunHome(), ...parts);
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureHome(): void {
  for (const d of ['sessions', 'skills', 'plugins', 'kb', 'memory', 'evolution/proposals', 'intel/reports', 'intel/raw']) {
    ensureDir(homePath(d));
  }
}
