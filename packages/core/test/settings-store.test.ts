import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readSettingsFile, transactSettingsFile } from '../src/settings/store.js';

const runNode = promisify(execFile);
let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sun-settings-store-'));
  file = join(root, 'config.json');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function worker() {
  const path = join(root, 'store.mjs');
  buildSync({
    entryPoints: [fileURLToPath(new URL('../src/settings/store.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'esm', outfile: path,
  });
  return path;
}

describe('configuration file transactions', () => {
  it('bases revisions on the exact bytes and detects a stale edit', () => {
    const missing = readSettingsFile(file);
    expect(missing.document).toEqual({});
    writeFileSync(file, '{}\n');
    const old = readSettingsFile(file);
    expect(old.revision).not.toBe(missing.revision);
    writeFileSync(file, '{ }\n');
    expect(transactSettingsFile(file, old.revision, () => ({ document: { maxSteps: 3 } }))).toEqual({
      ok: false, code: 'CONFLICT',
    });
    expect(readFileSync(file, 'utf8')).toBe('{ }\n');
  });

  it('rejects invalid JSON without calling the edit or touching the original', () => {
    writeFileSync(file, '{"broken":');
    const result = transactSettingsFile(file, undefined, () => {
      throw new Error('The edit must not run');
    });
    expect(result).toEqual({ ok: false, code: 'INVALID' });
    expect(readFileSync(file, 'utf8')).toBe('{"broken":');
  });

  it('preserves existing unknown keys and uses private file permissions', () => {
    writeFileSync(file, '{"unknown":{"keep":true}}', { mode: 0o644 });
    const old = readSettingsFile(file);
    const result = transactSettingsFile(file, old.revision, ({ document }) => ({
      document: { ...document, ui: { language: 'zh-CN' } },
    }));
    expect(result.ok).toBe(true);
    expect(readSettingsFile(file).document).toEqual({ unknown: { keep: true }, ui: { language: 'zh-CN' } });
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it.each(['write', 'replace'] as const)('leaves the original and releases the lock if %s fails', (operation) => {
    writeFileSync(file, '{}\n');
    const old = readSettingsFile(file);
    const edit = () => ({ document: { maxSteps: 3 } });
    const failure = transactSettingsFile(file, old.revision, edit, {
      [operation]() { throw new Error('injected filesystem failure'); },
    });
    expect(failure).toEqual({ ok: false, code: 'IO_ERROR' });
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
    expect(transactSettingsFile(file, old.revision, edit).ok).toBe(true);
  });

  it('leaves the original valid and recovers a lock after a process dies before rename', async () => {
    writeFileSync(file, '{}\n');
    const { revision } = readSettingsFile(file);
    const path = worker();
    const child = runNode(process.execPath, ['--input-type=module', '-e', `
      const { transactSettingsFile } = await import(process.argv[1]);
      transactSettingsFile(process.argv[2], process.argv[3], () => ({ document: { maxSteps: 12 } }), {
        replace() { process.exit(93); }
      });
    `, path, file, revision]);
    await expect(child).rejects.toMatchObject({ code: 93 });
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
    expect(transactSettingsFile(file, revision, () => ({ document: { maxSteps: 3 } })).ok).toBe(true);
    expect(readdirSync(root).sort()).toEqual(['config.json', 'store.mjs']);
  });

  it('leaves the replacement valid and recovers a lock after a process dies after rename', async () => {
    writeFileSync(file, '{}\n');
    const { revision } = readSettingsFile(file);
    const path = worker();
    const child = runNode(process.execPath, ['--input-type=module', '-e', `
      import { renameSync } from 'node:fs';
      const { transactSettingsFile } = await import(process.argv[1]);
      transactSettingsFile(process.argv[2], process.argv[3], () => ({ document: { maxSteps: 12 } }), {
        replace(from, to) { renameSync(from, to); process.exit(94); }
      });
    `, path, file, revision]);
    await expect(child).rejects.toMatchObject({ code: 94 });
    expect(readSettingsFile(file).document).toEqual({ maxSteps: 12 });
    expect(transactSettingsFile(file, revision, () => ({ document: {} }))).toEqual({ ok: false, code: 'CONFLICT' });
    expect(readdirSync(root).sort()).toEqual(['config.json', 'store.mjs']);
  });

  it('never takes a lock away from a live process even with an old marker', () => {
    const lock = `${file}.lock`;
    mkdirSync(lock);
    const owner = `${process.pid}-1-00000000-0000-0000-0000-000000000000`;
    writeFileSync(join(lock, owner), '');
    expect(transactSettingsFile(file, 'missing', () => ({ document: { maxSteps: 3 } }))).toEqual({
      ok: false, code: 'BUSY',
    });
    expect(readdirSync(lock)).toEqual([owner]);
  });

  it('detects a manual edit made while a replacement is being prepared', () => {
    writeFileSync(file, '{}\n');
    const { revision } = readSettingsFile(file);
    const result = transactSettingsFile(file, revision, () => ({ document: { maxSteps: 3 } }), {
      write(fd, data) {
        writeFileSync(file, '{"manual":true}\n');
        writeFileSync(fd, data);
      },
    });
    expect(result).toEqual({ ok: false, code: 'CONFLICT' });
    expect(readSettingsFile(file).document).toEqual({ manual: true });
  });

  it('allows only one of two subprocesses to save the same revision', async () => {
    writeFileSync(file, '{}\n');
    const { revision } = readSettingsFile(file);
    const path = worker();
    const run = (steps: number) => runNode(process.execPath, ['--input-type=module', '-e', `
      const { transactSettingsFile } = await import(process.argv[1]);
      const result = transactSettingsFile(process.argv[2], process.argv[3], () => ({
        document: { maxSteps: Number(process.argv[4]) }
      }));
      console.log(result.ok ? 'OK' : result.code);
    `, path, file, revision, String(steps)]);
    const results = await Promise.all([run(12), run(24)]);
    expect(results.map(r => r.stdout.trim()).sort()).toEqual(['CONFLICT', 'OK']);
    expect([12, 24]).toContain(readSettingsFile(file).document.maxSteps);
    chmodSync(file, 0o400);
    expect(transactSettingsFile(file, readSettingsFile(file).revision, () => ({ document: {} })).ok).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o400);
  });
});
