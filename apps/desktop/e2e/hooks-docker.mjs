// Offline Docker hook verification. Requires the built core and the existing default sandbox image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSandbox, DEFAULT_SANDBOX, runHook } from '@sun/core';

const cwd = mkdtempSync(join(tmpdir(), 'sun-hook-docker-'));
const settings = join(cwd, 'settings');
const list = () => new Set(execFileSync('docker', [
  'ps', '-a', '--filter', 'label=sun-harness=hook', '--format', '{{.Names}}',
], { encoding: 'utf8' }).trim().split('\n').filter(Boolean));

try {
  const before = list();
  mkdirSync(settings);
  writeFileSync(join(settings, 'fixture-private.txt'), 'synthetic data');
  const sandbox = createSandbox({
    mode: 'docker', cfg: { ...DEFAULT_SANDBOX, network: 'off' }, sessionId: 'docker-offline-fixture',
    cwd, secretEnv: [], protectedPaths: [settings], hook: true,
  });
  const completed = await runHook({
    command: 'test ! -e settings/fixture-private.txt && printf "verified"; exit 7',
  }, {}, cwd, { sandbox });
  assert.deepEqual([completed.state, completed.code, completed.stdout], ['completed', 7, 'verified'], JSON.stringify(completed));
  const timed = await runHook({
    command: '(sleep 3; touch late-timeout.txt) & touch timeout-ready.txt; wait', timeoutMs: 1600,
  }, {}, cwd, { sandbox });
  assert.equal(existsSync(join(cwd, 'timeout-ready.txt')), true, JSON.stringify(timed));
  assert.equal(timed.state, 'timed-out', JSON.stringify(timed));
  const controller = new AbortController();
  const pending = runHook({
    command: '(sleep 3; touch late-cancel.txt) & touch cancel-ready.txt; wait',
  }, {}, cwd, { sandbox, signal: controller.signal });
  for (let i = 0; i < 100 && !existsSync(join(cwd, 'cancel-ready.txt')); i++) await delay(30);
  assert.equal(existsSync(join(cwd, 'cancel-ready.txt')), true);
  controller.abort();
  assert.equal((await pending).state, 'cancelled');
  await delay(3100);
  assert.equal(existsSync(join(cwd, 'late-timeout.txt')), false);
  assert.equal(existsSync(join(cwd, 'late-cancel.txt')), false);
  assert.deepEqual([...list()].filter(name => !before.has(name)), []);
  console.log('Real Docker hooks preserved exit status, masked the protected settings directory, and removed both timed-out and cancelled invocation containers. No delayed descendants wrote files.');
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
