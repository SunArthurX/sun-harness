import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GatewayClient,
  RemoteHost,
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
    await remote.dispose();

    await expect(addRemote({ name: 'evil', url: gw.url, token, fingerprint: 'AA:'.repeat(31) + 'AA' })).rejects.toThrow(/fingerprint mismatch/);
    const wrongPin = new GatewayClient({ ...entry, fingerprint: 'AA:'.repeat(31) + 'AA' });
    await expect(wrongPin.call('listSessions')).rejects.toThrow(/fingerprint changed/);
    const unpinned = fetch(`${gw.url}/api/health`);
    await expect(unpinned).rejects.toThrow();

    revokeDevice('laptop');
    await expect(new GatewayClient(entry).call('listSessions')).rejects.toThrow(/rejected the token/);
  });
});
