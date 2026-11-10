import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GatewayClient,
  RemoteHost,
  SETTINGS_PROTOCOL_VERSION,
  addRemote,
  createDevice,
  ensureTls,
  getRemote,
  homePath,
  listDevices,
  loadRemotes,
  matchDevice,
  revokeDevice,
  startGateway,
  type RunningGateway,
  type LiveEvent,
} from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

describe('device tokens', () => {
  beforeEach(() => tempHome());

  it('stores only a hash, matches in constant time, and can be revoked', () => {
    const { device, token } = createDevice('phone');
    expect(token).toMatch(/^sund_/);
    expect(JSON.stringify(listDevices())).not.toContain(token);
    expect(statSync(homePath('gateway-devices.json')).mode & 0o777).toBe(0o600);
    expect(matchDevice(token)?.id).toBe(device.id);
    expect(matchDevice('sund_wrong')).toBeUndefined();
    expect(matchDevice(undefined)).toBeUndefined();
    expect(() => createDevice('phone')).toThrow(/exists/);
    expect(revokeDevice('phone')).toBe(true);
    expect(matchDevice(token)).toBeUndefined();
  });
});

describe('remote gateway over TLS', () => {
  let gw: RunningGateway | undefined;
  beforeEach(() => tempHome());
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it('refuses a non-loopback address without TLS', async () => {
    const { host } = await mockHost({});
    await expect(startGateway(host, { port: 0, hostname: '0.0.0.0', advertise: false })).rejects.toThrow(/without TLS/);
  });

  it.skipIf(!hasOpenssl)('serves HTTPS; pinned clients with a device token work, wrong pins and revoked tokens fail', async () => {
    const tls = ensureTls();
    expect(tls.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(ensureTls().fingerprint).toBe(tls.fingerprint); // reused, not regenerated
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('list_dir', {})] }, { text: 'over tls', toolCalls: [] }] });
    gw = await startGateway(host, { port: 0, hostname: '0.0.0.0', tls, advertise: false });
    expect(gw.url).toMatch(/^https:\/\//);
    const { token } = createDevice('laptop');

    // Trust on first use, checked against the fingerprint the owner read off the server.
    const entry = await addRemote({ name: 'home', url: gw.url, token, fingerprint: tls.fingerprint.toLowerCase() });
    expect(entry.fingerprint).toBe(tls.fingerprint);
    expect(getRemote()?.name).toBe('home');
    expect(loadRemotes().default).toBe('home');

    const remote = new RemoteHost(getRemote()!);
    remote.subscribe(() => undefined);
    await remote.ready();
    const s = await remote.createSession({ cwd: tempWorkspace() });
    await remote.send(s.id, 'hi over tls');
    expect((await remote.wait(s.id))?.status).toBe('idle');
    expect(((await remote.getEvents(s.id)).find((e) => e.type === 'assistant/message' && e.text) as any).text).toBe('over tls');
    const copy = await remote.client.importSessionBundle(await remote.client.exportSessionBundle(s.id));
    expect(copy.id).not.toBe(s.id);
    expect((await remote.getEvents(copy.id)).some(e => e.type === 'assistant/message' && e.text === 'over tls')).toBe(true);
    await remote.dispose();

    await expect(addRemote({ name: 'evil', url: gw.url, token, fingerprint: 'AA:'.repeat(31) + 'AA' })).rejects.toThrow(/fingerprint mismatch/);
    const wrongPin = new GatewayClient({ ...entry, fingerprint: 'AA:'.repeat(31) + 'AA' });
    await expect(wrongPin.call('listSessions')).rejects.toThrow(/fingerprint changed/);
    const unpinned = fetch(`${gw.url}/api/health`);
    await expect(unpinned).rejects.toThrow();

    revokeDevice('laptop');
    const revoked = new GatewayClient(entry);
    await expect(revoked.call('listSessions')).rejects.toThrow(/rejected the token/);
    await expect(revoked.exportSessionBundle(s.id)).rejects.toThrow(/unauthorized/i);
  });

  it.skipIf(!hasOpenssl)('closes an open stream and denies approvals when its last approver is revoked', async () => {
    const tls = ensureTls();
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo approval-fixture' }, 'fixture-call')] }],
    }, { approval: 'suggest' });
    gw = await startGateway(host, { port: 0, tls, advertise: false });
    const { device, token } = createDevice('viewer');
    const client = new GatewayClient({ url: gw.url, token, ...tls });
    const notices: LiveEvent[] = [];
    let unsubscribe: () => void = () => undefined;
    const ready = new Promise<void>(resolve => {
      unsubscribe = client.subscribe(event => notices.push(event), { approver: true, onReady: resolve });
    });
    try {
      await ready;
      const identity = await client.connection();
      expect(identity).toMatchObject({ protocolVersion: SETTINGS_PROTOCOL_VERSION, label: expect.any(String), capabilities: expect.any(Array) });
      expect(JSON.stringify(identity)).not.toContain(token);
      const session = await client.call('createSession', { cwd: tempWorkspace() });
      await client.call('send', session.id, 'Waiting for approval');
      await vi.waitFor(() => expect(host.pendingApprovals()).toHaveLength(1));
      const pending = host.pendingApprovals()[0];
      await expect(client.call('approve', pending.callId, 'allow', 'another-host-prompt')).rejects.toThrow(/No pending approval/);
      await expect(client.call('approve', pending.callId, 'allow')).rejects.toThrow(/No pending approval/);
      expect(revokeDevice(device.id)).toBe(true);
      await expect(client.call('approve', pending.callId, 'allow', pending.promptId)).rejects.toThrow(/rejected the token/);
      await vi.waitFor(() => expect(host.pendingApprovals()).toEqual([]));
      await host.wait(session.id);
      expect(host.getEvents(session.id)).toContainEqual(expect.objectContaining({ type: 'approval/decision', decision: 'deny', reason: expect.stringMatching(/no authorized approver/) }));
      const count = notices.length;
      host.createSession({ cwd: tempWorkspace(), title: 'Created after revocation' });
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(notices).toHaveLength(count);
    } finally {
      unsubscribe();
      await host.dispose();
    }
  });

  it.skipIf(!hasOpenssl)('refuses to replace a saved pin when the gateway serves a different certificate', async () => {
    const { host } = await mockHost({});
    const tls = ensureTls();
    gw = await startGateway(host, { port: 0, tls, advertise: false });
    const previous = await addRemote({ name: 'home', url: gw.url, token: gw.token });
    const url = new URL(gw.url);
    await gw.close();
    const replacement = ensureTls({ dir: homePath('tls-rotated') });
    gw = await startGateway(host, { port: Number(url.port), tls: replacement, advertise: false });
    await expect(addRemote({ name: 'home', url: gw.url, token: gw.token })).rejects.toThrow(/fingerprint changed/);
    expect(getRemote()).toEqual(previous);
    await expect(new GatewayClient(previous).connection()).rejects.toThrow();
  });
});

describe('reconnect receipts', () => {
  let gateway: RunningGateway | undefined;
  beforeEach(() => tempHome());
  afterEach(async () => {
    await gateway?.close();
    gateway = undefined;
  });

  function rpc(method: string, args: unknown[], requestId: string, token = gateway!.token) {
    return fetch(`${gateway!.url}/api/call`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ method, args, requestId }),
    }).then(response => response.json());
  }

  it('refuses a request bound to another installation and a prompt issued by another host', async () => {
    const scripted = () => ({ 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo scoped' }, 'shared-call')] }] });
    const { host: firstHost } = await mockHost(scripted(), { approval: 'suggest' });
    const { host: secondHost } = await mockHost(scripted(), { approval: 'suggest' });
    const releaseFirst = firstHost.registerApprover();
    const releaseSecond = secondHost.registerApprover();
    gateway = await startGateway(firstHost, { port: 0, advertise: false });
    const secondGateway = await startGateway(secondHost, { port: 0, advertise: false });
    try {
      const first = new GatewayClient(gateway);
      const second = new GatewayClient(secondGateway);
      const foreign = new GatewayClient({ ...secondGateway, hostId: randomUUID() });
      await expect(foreign.call('createSession', { title: 'Wrong installation' })).rejects.toThrow(/GATEWAY_HOST_CHANGED/);
      expect(firstHost.listSessions()).toHaveLength(0);
      const a = await first.call('createSession', { cwd: tempWorkspace() });
      const b = await second.call('createSession', { cwd: tempWorkspace() });
      await Promise.all([first.call('send', a.id, 'First host'), second.call('send', b.id, 'Second host')]);
      await vi.waitFor(() => {
        expect(firstHost.pendingApprovals()).toHaveLength(1);
        expect(secondHost.pendingApprovals()).toHaveLength(1);
      });
      const [p] = firstHost.pendingApprovals();
      const [q] = secondHost.pendingApprovals();
      expect(p.callId).toBe(q.callId);
      await expect(second.call('approve', q.callId, 'allow', p.promptId)).rejects.toThrow(/No pending approval/);
      expect(secondHost.pendingApprovals()).toEqual([q]);
      await first.call('approve', p.callId, 'deny', p.promptId);
      await second.call('approve', q.callId, 'deny', q.promptId);
      await Promise.all([firstHost.wait(a.id), secondHost.wait(b.id)]);
    } finally {
      releaseFirst();
      releaseSecond();
      await secondGateway.close();
      await Promise.all([firstHost.dispose(), secondHost.dispose()]);
    }
  });

  it('reuses a receipt after the server commits a send but its response is lost', async () => {
    const { host } = await mockHost({});
    gateway = await startGateway(host, { port: 0, advertise: false });
    const client = new GatewayClient(gateway);
    const session = await client.call('createSession', { cwd: tempWorkspace() });
    const send = vi.spyOn(host, 'send');
    gateway.server.prependOnceListener('request', (_req, response) => {
      vi.spyOn(response, 'end').mockImplementation(() => { response.destroy(); return response; });
    });
    await client.call('send', session.id, 'Send once despite the lost response.');
    await host.wait(session.id);
    expect(send).toHaveBeenCalledTimes(1);
    expect(host.getEvents(session.id).filter(e => e.type === 'user/message' && e.source === 'user')).toHaveLength(1);
    await host.dispose();
  });

  it('exchanges a device token for an opaque browser session and enforces origin and revocation', async () => {
    const { host } = await mockHost({});
    gateway = await startGateway(host, { port: 0, advertise: false });
    const { device, token } = createDevice('browser');
    const login = await fetch(`${gateway.url}/api/web-session`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, origin: gateway.url },
    });
    expect(login.status).toBe(200);
    const header = login.headers.get('set-cookie')!;
    expect(header).toMatch(/HttpOnly; SameSite=Strict/);
    expect(header).not.toContain(token);
    expect(JSON.stringify(await login.json())).not.toContain(token);
    const cookie = header.split(';')[0];
    const connection = () => `${gateway!.url}/api/connection?version=${SETTINGS_PROTOCOL_VERSION}`;
    expect((await fetch(connection(), { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).status).toBe(200);
    expect((await fetch(connection(), { headers: { cookie, origin: 'http://other.test', 'sec-fetch-site': 'cross-site' } })).status).toBe(401);
    expect(revokeDevice(device.id)).toBe(true);
    expect((await fetch(connection(), { headers: { cookie } })).status).toBe(401);
    await host.dispose();
  });

  it('deduplicates concurrent work, rejects changed or expired IDs, and invalidates IDs on restart', async () => {
    const { host } = await mockHost({});
    gateway = await startGateway(host, { port: 0, advertise: false });
    const client = new GatewayClient(gateway);
    const identity = await client.connection();
    const id = () => `${identity.gatewayId}:${identity.serverTime}:${randomUUID()}`;
    const createId = id();
    const args = [{ cwd: tempWorkspace(), title: 'Receipt' }];
    const result = await rpc('createSession', args, createId);
    expect(result).toMatchObject({ ok: true, result: { title: 'Receipt' } });
    expect(await rpc('createSession', args, createId)).toEqual(result);
    expect(await rpc('createSession', [{ ...args[0], title: 'Changed' }], createId)).toEqual({ ok: false, error: 'GATEWAY_REQUEST_CONFLICT' });
    expect(await rpc('createSession', args, `${identity.gatewayId}:${identity.serverTime - 601_000}:${randomUUID()}`)).toEqual({
      ok: false, error: 'GATEWAY_REQUEST_EXPIRED',
    });
    expect(host.listSessions()).toHaveLength(1);
    const automation = host.createAutomation({ title: 'Retry', prompt: 'Run once', schedule: 'every day at 9:00', cwd: args[0].cwd });
    const run = vi.spyOn(host, 'runAutomation');
    const jobId = id();
    const [first, second] = await Promise.all([
      rpc('runAutomation', [automation.id], jobId),
      rpc('runAutomation', [automation.id], jobId),
    ]);
    expect(first).toMatchObject({ ok: true, result: expect.any(String) });
    expect(second).toEqual(first);
    expect(run).toHaveBeenCalledTimes(1);
    await host.wait(first.result);
    const { token: otherToken } = createDevice('other');
    expect(await rpc('createSession', args, createId, otherToken)).not.toEqual(result);
    expect(host.listSessions()).toHaveLength(3);
    const unauthorized = await fetch(`${gateway.url}/api/connection?version=${SETTINGS_PROTOCOL_VERSION}`);
    expect(unauthorized.status).toBe(401);
    const unsupported = await fetch(`${gateway.url}/api/connection?version=-1`, { headers: { authorization: `Bearer ${gateway.token}` } });
    expect(unsupported.status).toBe(409);
    await gateway.close();
    gateway = await startGateway(host, { port: 0, advertise: false });
    expect(await new GatewayClient(gateway).connection()).toMatchObject({ hostId: identity.hostId, gatewayId: expect.not.stringMatching(identity.gatewayId) });
    expect(await rpc('createSession', args, createId)).toEqual({ ok: false, error: 'GATEWAY_INSTANCE_CHANGED' });
    expect(host.listSessions()).toHaveLength(3);
    await host.dispose();
  });
});
