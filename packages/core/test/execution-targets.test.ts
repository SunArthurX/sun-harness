import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayClient, homePath, startGateway, type HarnessHost, type RunningGateway } from '../src/index.js';
import { ExecutionJobs, type ExecutionJobAdapter, type ExecutionJobReceipt, type ExecutionJobRequest, type ExecutionTarget } from '../src/settings/targets.js';
import { SETTINGS_PROTOCOL_VERSION as version } from '../src/settings/protocol.js';
import { mockHost, tempHome, tempWorkspace } from './helpers.js';

let host: HarnessHost | undefined;
let gateway: RunningGateway | undefined;
let workspace: string;
let client: GatewayClient;
let target: ExecutionTarget;

async function launch() {
  ({ host } = await mockHost({}));
  gateway = await startGateway(host, { port: 0 });
  client = new GatewayClient(gateway);
  const { hostId, capabilities } = await client.connection();
  expect(capabilities).toContainEqual(expect.objectContaining({ id: 'core.execution-jobs', state: 'available' }));
  target = { id: `remote-gateway:${hostId}`, hostId, label: 'Fixture target', kind: 'remote-gateway', health: 'ready', capabilities: ['shell-jobs'] };
}

function provider(overrides: Partial<ExecutionJobAdapter> = {}): ExecutionJobAdapter {
  const request = <T>(method: string, ...args: unknown[]) => client.callBounded<T>(method, 5000, version, ...args);
  return {
    target,
    sessions: () => request('executionProviderSessions', target.hostId),
    start: input => request('startExecutionProviderJob', input),
    inspect: id => request('inspectExecutionProviderJob', id, target.hostId),
    cancel: id => request('cancelExecutionProviderJob', id, target.hostId),
    output: id => request('executionProviderOutput', id, target.hostId),
    ...overrides,
  };
}

beforeEach(async () => {
  tempHome();
  workspace = tempWorkspace();
  await launch();
});

afterEach(async () => {
  await gateway?.close();
  await host?.dispose();
  gateway = undefined;
  host = undefined;
});

describe('execution target job reconciliation', () => {
  it('recovers an accepted launch after a lost acknowledgement and gateway restart', async () => {
    const session = host!.createSession({ cwd: workspace, sandbox: 'off' });
    const operationId = randomUUID();
    const command = 'printf one-run >> launch-count; sleep 1; printf remote-output';
    const request = { targetId: target.id, sessionId: session.id, operationId, command };
    const firstHostId = target.hostId;
    const original = provider();
    let launches = 0;
    let receipt: ExecutionJobReceipt | undefined;
    const lost = new ExecutionJobs(async () => ({
      ...original,
      async start(input) {
        launches++;
        receipt = await original.start(input);
        throw new Error('Fixture drops the start acknowledgement.');
      },
    }));
    expect(await lost.start(request)).toMatchObject({ state: 'reconciling', targetHealth: 'offline', operationId });
    expect(receipt?.providerJobId).toBe(`job-exec-${operationId}`);
    expect(readFileSync(homePath('execution-jobs', `${operationId}.json`), 'utf8')).not.toContain(command);

    await gateway!.close();
    await host!.dispose();
    await launch();
    expect(target.hostId).toBe(firstHostId);
    const online = provider();
    const restored = new ExecutionJobs(async () => ({
      ...online,
      async start() { launches++; throw new Error('A restored client must not start another command.'); },
    }));
    expect(restored.list()[0]).toMatchObject({ operationId, targetId: target.id });
    await expect(restored.start({ ...request, command: 'another command' })).rejects.toThrow(/EXECUTION_OPERATION_CONFLICT/);
    expect(await restored.start(request)).toMatchObject({ providerJobId: receipt?.providerJobId, targetHealth: 'ready' });
    await expect.poll(async () => (await restored.refresh(operationId)).state, { timeout: 6000 }).toBe('succeeded');
    expect(launches).toBe(1);
    expect(readFileSync(join(workspace, 'launch-count'), 'utf8')).toBe('one-run');
    expect(await restored.output(operationId)).toContain('remote-output');
    const replay: ExecutionJobRequest = { operationId, hostId: target.hostId, sessionId: session.id, command };
    expect(await online.start(replay)).toMatchObject({ providerJobId: receipt?.providerJobId, state: 'succeeded' });
    await expect(online.start({ ...replay, command: 'printf another-run >> launch-count' })).rejects.toThrow(/EXECUTION_OPERATION_CONFLICT/);
    expect(readFileSync(join(workspace, 'launch-count'), 'utf8')).toBe('one-run');
  }, 20_000);

  it('retains a cancellation request before dispatch and reconciles a lost acknowledgement', async () => {
    const session = host!.createSession({ cwd: workspace, sandbox: 'off' });
    const operationId = randomUUID();
    const adapter = provider();
    const controller = new ExecutionJobs(async () => ({
      ...adapter,
      async cancel(id) {
        const disk = JSON.parse(readFileSync(homePath('execution-jobs', `${id}.json`), 'utf8'));
        expect(disk.cancellation).toBe('requested');
        expect(await adapter.cancel(id)).toMatchObject({ cancellation: 'acknowledged' });
        throw new Error('Fixture drops the cancellation acknowledgement.');
      },
    }));
    await controller.start({ targetId: target.id, sessionId: session.id, operationId,
      command: 'trap "" TERM; printf ready; while true; do sleep 0.1; done' });
    await expect.poll(() => controller.output(operationId)).toContain('ready');
    expect(await controller.cancel(operationId)).toMatchObject({ state: 'reconciling', cancellation: 'requested', targetHealth: 'offline' });
    const recovered = new ExecutionJobs(async () => adapter);
    await expect.poll(async () => (await recovered.refresh(operationId)).state, { timeout: 7000 }).toBe('cancelled');
    expect(recovered.list()[0]).toMatchObject({ operationId, state: 'cancelled', cancellation: 'acknowledged', targetHealth: 'ready' });
  }, 15_000);

  it('preserves a launch reservation when no provider acknowledgement exists', async () => {
    const operationId = randomUUID();
    const session = host!.createSession({ cwd: workspace, sandbox: 'off' });
    const id = `job-exec-${operationId}`;
    const record = homePath('jobs', `${id}.json`);
    const adapter = provider();
    await host!.jobs.startExecution(session.id, 'true', workspace, {
      operationId, hostId: target.hostId, requestDigest: 'fixture', environment: 'host',
    }, () => ({ shell: 'true', env: {} }));
    await expect.poll(async () => (await adapter.inspect(operationId))?.state).toBe('succeeded');
    host!.jobs.detach();
    const prior = JSON.parse(readFileSync(record, 'utf8'));
    writeFileSync(record, JSON.stringify({ ...prior, state: 'running', pid: undefined, exitCode: undefined, endedAt: undefined }));
    await host!.dispose();
    await launch();
    expect(await provider().inspect(operationId)).toMatchObject({ state: 'reconciling', providerJobId: id });
    await expect(client.callBounded('inspectExecutionProviderJob', 1000, version, operationId, randomUUID())).rejects
      .toThrow(/EXECUTION_TARGET_IDENTITY_CHANGED/);
  });
});
