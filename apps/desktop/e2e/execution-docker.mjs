// Offline verification of isolated Docker execution jobs. Uses only the configured local image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { defaultConfig, HarnessHost, hostMethods, SETTINGS_PROTOCOL_VERSION as version } from '@sun/core';

const home = mkdtempSync(join(tmpdir(), 'sun-execution-docker-'));
const workspace = join(home, 'workspace');
mkdirSync(workspace);
const previous = process.env.SUN_HOME;
process.env.SUN_HOME = home;
const config = defaultConfig();
config.sandbox.network = 'off';
const host = new HarnessHost({ config, connectMcp: false, loadPlugins: false, shellHooks: false });
const api = hostMethods(host, { mode: 'local' });
const ids = new Set();

async function waitFor(check, ms = 10_000) {
  const expires = Date.now() + ms;
  do {
    const result = await check();
    if (result) return result;
    await delay(80);
  } while (Date.now() < expires);
  throw new Error('Execution Docker fixture timed out.');
}

try {
  await host.init();
  const target = (await api.executionTargets(version)).find(item => item.kind === 'container');
  assert.equal(target?.health, 'ready', 'This fixture needs the default image on a local Docker daemon.');
  const chat = host.createSession({ cwd: workspace, sandbox: 'docker', title: 'Docker execution fixture' });
  assert.ok((await api.executionTargetSessions(version, target.id)).some(item => item.id === chat.id));
  const start = async command => {
    const operationId = randomUUID();
    ids.add(operationId);
    return api.startExecutionJob(version, { targetId: target.id, sessionId: chat.id, command, operationId });
  };
  const complete = await start('test -f /.dockerenv && printf container-only > done.txt && printf job-output');
  const done = await waitFor(async () => {
    const job = await api.refreshExecutionJob(version, complete.operationId);
    return job.state === 'succeeded' ? job : undefined;
  });
  assert.equal(done.environment, 'container');
  assert.equal(readFileSync(join(workspace, 'done.txt'), 'utf8'), 'container-only');
  assert.equal(await api.executionJobOutput(version, complete.operationId), 'job-output');

  const stopped = await start('touch ready.txt; (sleep 3; touch late.txt) & wait');
  await waitFor(() => existsSync(join(workspace, 'ready.txt')));
  assert.equal((await api.cancelExecutionJob(version, stopped.operationId)).cancellation, 'acknowledged');
  await waitFor(async () => (await api.refreshExecutionJob(version, stopped.operationId)).state === 'cancelled');
  await delay(3100);
  assert.equal(existsSync(join(workspace, 'late.txt')), false);
  const containers = execFileSync('docker', ['ps', '-a', '--filter', 'label=sun-harness=execution', '--format', '{{.Names}}'], { encoding: 'utf8' });
  for (const id of ids) assert.equal(containers.includes(`sun-exec-${id}`), false);
  console.log('Local Docker ran a reviewed command in an isolated container and durably acknowledged cancellation of only that container. No delayed write survived.');
} finally {
  for (const id of ids) await Promise.resolve(api.cancelExecutionJob(version, id)).catch(() => undefined);
  await host.dispose();
  if (previous === undefined) delete process.env.SUN_HOME;
  else process.env.SUN_HOME = previous;
  rmSync(home, { recursive: true, force: true });
}
