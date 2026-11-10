import { describe, expect, it, vi } from 'vitest';
import { GatewayClient, HarnessHost, MockProvider, SETTINGS_PROTOCOL_VERSION as version, hostMethods, startGateway } from '../src/index.js';
import { ComputerControl, type ComputerAdapter, type ComputerReceipt, type ComputerTarget } from '../src/settings/computer.js';
import { call, tempHome, testConfig } from './helpers.js';

const appId = 'dev.sun-harness.test';
const first = 'session-first';
const second = 'session-second';
const signal = new AbortController().signal;
const press = { kind: 'press' } as const;

function fixture() {
  let authorized = true;
  let granted = true;
  let now = 0;
  let target: ComputerTarget = { appId, instance: 'fixture-instance', windowId: 'first-window' };
  const probe = vi.fn<ComputerAdapter['probe']>(async () => ({ authorized, target }));
  const snapshot = vi.fn<ComputerAdapter['snapshot']>(async target => ({
    target, text: 'Synthetic window', controls: [{ key: 'native-element', role: 'button', label: 'Press', actions: ['press'] }],
  }));
  const act = vi.fn<ComputerAdapter['act']>(async () => 'applied');
  const record = vi.fn<(receipt: ComputerReceipt) => true>(() => true);
  const makeController = () => new ComputerControl({ probe, snapshot, act }, () => granted, record, () => now);
  return {
    probe, snapshot, act, record, makeController,
    setAuthorized: (value: boolean) => { authorized = value; },
    setGranted: (value: boolean) => { granted = value; },
    setTarget: (value: Partial<ComputerTarget>) => { target = { ...target, ...value }; },
    advance: (ms: number) => { now += ms; },
  };
}

describe('native computer control boundary', () => {
  it('limits observation to one owner and one action to the current snapshot', async () => {
    const f = fixture();
    const control = f.makeController();
    control.begin(first, appId);
    expect(() => control.begin(second, appId)).toThrow('COMPUTER_CONTROL_BUSY');
    await expect(control.snapshot(second, signal)).rejects.toThrow('COMPUTER_CONTROL_REQUIRED');
    const stale = await control.snapshot(first, signal);
    const fresh = await control.snapshot(first, signal);
    expect(JSON.stringify(fresh)).not.toContain('native-element');
    await expect(control.act(first, stale.controls[0].ref, press, signal)).rejects.toThrow('COMPUTER_SNAPSHOT_STALE');
    f.act.mockImplementationOnce(async () => {
      expect(f.record).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: fresh.generation, outcome: 'dispatched' }));
      return 'applied';
    });
    const ref = fresh.controls[0].ref;
    await expect(control.act(first, ref, press, signal)).resolves.toBe('applied');
    await expect(control.act(first, ref, press, signal)).rejects.toThrow('COMPUTER_SNAPSHOT_STALE');
    expect(f.act).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenLastCalledWith(expect.objectContaining({ operationId: fresh.generation, outcome: 'applied' }));
    control.stop();
  });

  it('refuses missing permission, revoked grants, window switches, and an undurable dispatch', async () => {
    const f = fixture();
    const control = f.makeController();
    control.begin(first, appId);
    const ref = () => control.snapshot(first, signal).then(result => result.controls[0].ref);
    const withoutPermission = await ref();
    f.setAuthorized(false);
    await expect(control.act(first, withoutPermission, press, signal)).rejects.toThrow('COMPUTER_OS_PERMISSION_REQUIRED');
    f.setAuthorized(true);
    control.begin(first, appId);
    const revoked = await ref();
    f.setGranted(false);
    await expect(control.act(first, revoked, press, signal)).rejects.toThrow('COMPUTER_GRANT_REQUIRED');
    f.setGranted(true);
    control.begin(first, appId);
    const switched = await ref();
    f.setTarget({ windowId: 'another-window' });
    await expect(control.act(first, switched, press, signal)).rejects.toThrow('COMPUTER_TARGET_CHANGED');
    control.begin(first, appId);
    const undurable = await ref();
    f.record.mockImplementationOnce(() => { throw new Error('Fixture storage failure'); });
    await expect(control.act(first, undurable, press, signal)).rejects.toThrow('COMPUTER_RECEIPT_UNAVAILABLE');
    expect(f.act).not.toHaveBeenCalled();
    control.stop();
  });

  it('stops a blocked action, drains the adapter, and refuses to replay after restart', async () => {
    const f = fixture();
    const control = f.makeController();
    const entered = Promise.withResolvers<AbortSignal>();
    const blocked = Promise.withResolvers<'applied'>();
    f.act.mockImplementationOnce((_target, _control, _action, nativeSignal) => {
      entered.resolve(nativeSignal);
      return blocked.promise;
    });
    control.begin(first, appId);
    const observation = await control.snapshot(first, signal);
    const ref = observation.controls[0].ref;
    const running = control.act(first, ref, press, signal);
    const nativeSignal = await entered.promise;
    control.takeover(first);
    expect(control.owner()).toBeUndefined();
    expect(nativeSignal.aborted).toBe(true);
    await expect(running).rejects.toThrow('COMPUTER_OUTCOME_UNCERTAIN');
    expect(() => control.begin(second, appId)).toThrow('COMPUTER_CONTROL_BUSY');
    blocked.resolve('applied');
    await vi.waitFor(() => { control.begin(second, appId); });
    expect(f.record.mock.calls.map(([event]) => event.outcome)).toEqual(['dispatched']);
    control.stop();
    const restored = f.makeController();
    await expect(restored.act(first, ref, press, signal)).rejects.toThrow('COMPUTER_CONTROL_REQUIRED');
    restored.begin(first, appId);
    await restored.snapshot(first, signal);
    await expect(restored.act(first, ref, press, signal)).rejects.toThrow('COMPUTER_SNAPSHOT_STALE');
    expect(f.act).toHaveBeenCalledTimes(1);
    restored.stop();
  });

  it('drops a snapshot that arrives after emergency stop and expires an idle lease', async () => {
    const f = fixture();
    const control = f.makeController();
    const entered = Promise.withResolvers<void>();
    const late = Promise.withResolvers<Awaited<ReturnType<ComputerAdapter['snapshot']>>>();
    f.snapshot.mockImplementationOnce(() => { entered.resolve(); return late.promise; });
    control.begin(first, appId);
    const pending = control.snapshot(first, signal);
    await entered.promise;
    control.stop();
    await expect(pending).rejects.toThrow('COMPUTER_STOPPED');
    late.resolve({ target: { appId, instance: 'fixture-instance', windowId: 'first-window' }, text: 'Late response', controls: [] });
    await vi.waitFor(() => { control.begin(second, appId); });
    f.advance(60_000);
    expect(control.owner()).toBeUndefined();
    expect(f.act).not.toHaveBeenCalled();
  });
});

it('routes native input through runtime approval and persists its receipt before dispatch', async () => {
  const home = tempHome();
  const f = fixture();
  const provider = new MockProvider([
    { text: '', toolCalls: [call('computer_snapshot', {}, 'fixture-snapshot')] },
    request => {
      const result = request.messages.find(message => message.role === 'tool' && message.toolCallId === 'fixture-snapshot');
      const ref = /"ref":"([^"]+)"/.exec(String(result?.content))?.[1];
      expect(ref).toBeTruthy();
      return { text: '', toolCalls: [call('computer_act', { ref, kind: 'press' }, 'fixture-act')] };
    },
    { text: 'Finished', toolCalls: [] },
  ]);
  const host = new HarnessHost({ config: testConfig({ approval: 'suggest' }), providerFactory: () => ({ provider, model: 'fixture' }),
    loadPlugins: false, connectMcp: false, shellHooks: false,
    nativeCapabilities: { computerUse: { status: () => 'available', inspect: async () => ({ authorized: true, apps: [{ id: appId, label: 'Fixture' }] }),
      probe: f.probe, snapshot: f.snapshot, act: f.act } } });
  const competingHost = new HarnessHost({ config: testConfig(), loadPlugins: false, connectMcp: false, shellHooks: false,
    nativeCapabilities: { computerUse: { status: () => 'available', inspect: async () => ({ authorized: true, apps: [] }),
      probe: f.probe, snapshot: f.snapshot, act: f.act } } });
  await host.init();
  const desktop = hostMethods(host, { mode: 'local', surface: 'desktop' });
  const gateway = await startGateway(host, { port: 0 });
  const release = host.registerApprover();
  try {
    const client = new GatewayClient(gateway);
    for (const method of ['inspectComputerUse', 'grantComputerUse', 'beginComputerUse', 'stopComputerUse', 'computerOwner']) {
      await expect(client.call(method, version)).rejects.toThrow('Unknown method');
    }
    const session = host.createSession({ cwd: home });
    await expect(desktop.beginComputerUse(version, session.id, appId)).rejects.toThrow('COMPUTER_GRANT_REQUIRED');
    const view = await desktop.inspectComputerUse(version);
    await desktop.grantComputerUse(version, view.revision, appId, true);
    await expect(desktop.grantComputerUse(version, view.revision, appId, false)).rejects.toThrow('COMPUTER_GRANTS_CHANGED');
    await desktop.beginComputerUse(version, session.id, appId);
    await expect(competingHost.beginComputerUse(session.id, appId)).rejects.toThrow('COMPUTER_CONTROL_BUSY');
    f.act.mockImplementationOnce(async () => {
      expect(host.getEvents(session.id)).toContainEqual(expect.objectContaining({ type: 'computer/action', outcome: 'dispatched' }));
      return 'applied';
    });
    await host.send(session.id, 'Press the fixture control');
    const approval = await vi.waitFor(() => {
      const approval = host.pendingApprovals().find(item => item.callId === 'fixture-act');
      expect(approval).toBeDefined();
      return approval!;
    });
    expect(f.act).not.toHaveBeenCalled();
    expect(host.approve(approval.callId, 'allow', approval.promptId)).toBe(true);
    await host.wait(session.id);
    expect(f.act).toHaveBeenCalledTimes(1);
    const receipts = host.getEvents(session.id).filter(event => event.type === 'computer/action');
    expect(receipts.map(event => event.outcome)).toEqual(['dispatched', 'applied']);
    expect(receipts[0].operationId).toBe(receipts[1].operationId);
    desktop.stopComputerUse(version);
    expect(desktop.computerOwner(version)).toBeUndefined();
    await expect(competingHost.beginComputerUse(session.id, appId)).resolves.toBeUndefined();
    competingHost.setSessionFlags(session.id, { archived: true });
    expect(competingHost.computerOwner()).toBeUndefined();
  } finally {
    release();
    await gateway.close();
    await competingHost.dispose();
    await host.dispose();
  }
});
