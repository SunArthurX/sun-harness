import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RemoteHost, findGateway, readGatewayInfo, startGateway, type LiveEvent, type RunningGateway } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

describe('gateway', () => {
  let gw: RunningGateway | undefined;
  beforeEach(() => tempHome());
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it('requires the token, advertises itself, and is discoverable', async () => {
    const { host } = await mockHost({});
    gw = await startGateway(host, { port: 0 });
    expect((await fetch(`${gw.url}/api/health`)).status).toBe(401);
    expect((await fetch(`${gw.url}/api/health?token=${gw.token}`)).status).toBe(200);
    expect(readGatewayInfo()).toMatchObject({ url: gw.url, token: gw.token, pid: process.pid });
    expect((await findGateway())?.url).toBe(gw.url);
    await gw.close();
    gw = undefined;
    expect(readGatewayInfo()).toBeUndefined();
    expect(await findGateway()).toBeUndefined();
  });

  it('runs a session for a remote client and streams its events', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('list_dir', {})] }, { text: 'remote done', toolCalls: [] }] });
    gw = await startGateway(host, { port: 0 });
    const remote = new RemoteHost(gw);
    const seen: LiveEvent[] = [];
    remote.subscribe((e) => seen.push(e));
    await remote.ready();
    const s = await remote.createSession({ cwd: tempWorkspace() });
    await remote.send(s.id, 'hello over http');
    const r = await remote.wait(s.id);
    expect(r?.status).toBe('idle');
    const events = await remote.getEvents(s.id);
    expect(events.filter((e) => e.type === 'tool/result')).toHaveLength(1);
    expect(seen.some((e) => e.kind === 'event' && e.event.type === 'user/message')).toBe(true);
    expect(seen.some((e) => e.kind === 'delta' && e.text === 'remote done')).toBe(true);
    expect(seen.some((e) => e.kind === 'notice')).toBe(false);
    await expect(remote.client.call('nope')).rejects.toThrow(/Unknown method/);
    await remote.dispose();
  });

  it('a remote approver answers approvals; with none attached the gateway denies instead of hanging', async () => {
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: '', toolCalls: [call('bash', { command: 'echo approved-remotely' })] },
          { text: 'ok', toolCalls: [] },
          { text: '', toolCalls: [call('bash', { command: 'echo nobody' })] },
          { text: 'ok', toolCalls: [] },
        ],
      },
      { approval: 'suggest' },
    );
    gw = await startGateway(host, { port: 0 });
    const remote = new RemoteHost(gw);
    remote.registerApprover();
    remote.subscribe((e) => {
      if (e.kind === 'approvals') for (const a of e.approvals) void remote.approve(a.callId, 'allow');
    });
    await new Promise((r) => setTimeout(r, 150));
    const s = await remote.createSession({ cwd: tempWorkspace() });
    await remote.send(s.id, 'run');
    await remote.wait(s.id);
    expect(((await remote.getEvents(s.id)).find((e) => e.type === 'tool/result') as any).output).toContain('approved-remotely');
    await remote.dispose();
    await new Promise((r) => setTimeout(r, 150));

    // Per-session approval mode travels with createSession; no approver is connected any more.
    const headless = new RemoteHost(gw);
    const s2 = await headless.createSession({ cwd: tempWorkspace(), approval: 'suggest' });
    await headless.send(s2.id, 'run again');
    await headless.wait(s2.id);
    expect(((await headless.getEvents(s2.id)).find((e) => e.type === 'tool/result') as any).output).toContain('headless run');
  });

  it('serves the web UI and blocks path traversal', async () => {
    const web = mkdtempSync(join(tmpdir(), 'sun-web-'));
    writeFileSync(join(web, 'index.html'), '<title>sun web</title>');
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'assets', 'app.js'), 'console.log(1)');
    const { host } = await mockHost({});
    gw = await startGateway(host, { port: 0, webRoot: web, advertise: false });
    expect(await (await fetch(`${gw.url}/`)).text()).toContain('sun web');
    const js = await fetch(`${gw.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await (await fetch(`${gw.url}/../../../../etc/passwd`)).text()).toContain('sun web');
    expect(await (await fetch(`${gw.url}/%2e%2e/%2e%2e/etc/passwd`)).text()).toContain('sun web');
  });
});
