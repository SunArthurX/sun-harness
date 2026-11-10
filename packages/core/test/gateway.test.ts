import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GatewayClient, RemoteHost, findGateway, homePath, readGatewayInfo, startGateway, type LiveEvent, type RunningGateway } from '../src/index.js';
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

  it('restricts dated Intel and briefing RPCs to their own report directories', async () => {
    const { host } = await mockHost({});
    gw = await startGateway(host, { port: 0 });
    const client = new GatewayClient(gw);
    const outside = homePath('audit-private.md');
    writeFileSync(outside, 'Private fixture outside both report folders.');
    writeFileSync(homePath('audit-private.json'), JSON.stringify({ items: [], errors: [] }));
    mkdirSync(homePath('briefings'), { recursive: true });
    writeFileSync(homePath('briefings', '2026-11-07.md'), 'Expected briefing.');
    writeFileSync(homePath('intel', 'reports', '2026-11-07.md'), 'Expected intel report.');
    expect(await client.call('readBriefing', '2026-11-07')).toBe('Expected briefing.');
    expect(await client.call('readIntelReport', '2026-11-07')).toBe('Expected intel report.');
    const attempts = await Promise.allSettled([
      client.call('readBriefing', '../audit-private'),
      client.call('readIntelReport', '../../audit-private'),
      client.call('analyzeIntel', '../../audit-private'),
    ]);
    expect(attempts.map(attempt => attempt.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(readFileSync(outside, 'utf8')).toBe('Private fixture outside both report folders.');
    await expect(client.call('readIntelReport', '2026-02-30')).rejects.toThrow(/calendar date/i);
    await host.dispose();
  });

  it('reads ordinary images when JSON encodes an absent metadata argument as null', async () => {
    const { host } = await mockHost({});
    try {
      gw = await startGateway(host, { port: 0 });
      const session = host.createSession({ cwd: tempWorkspace() });
      const data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlE0i8AAAAASUVORK5CYII=';
      await host.send(session.id, 'inspect the fixture attachment', 'user', { images: [{ mime: 'image/png', data }] });
      await host.wait(session.id);
      const message = host.getEvents(session.id).find(event => event.type === 'user/message');
      const image = message?.images?.[0];
      expect(image).toBeDefined();
      const client = new GatewayClient(gw);
      expect(await client.call('readAttachment', image!.path, undefined)).toEqual({ mime: 'image/png', data });
      await expect(client.call('readAttachment', image!.path, { sha256: 'wrong' })).rejects.toThrow(/APPSHOT_ATTACHMENT_UNAVAILABLE/);
    } finally {
      await host.dispose();
    }
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
    await expect(remote.approve('no-such-call', 'allow', 'p')).rejects.toThrow(/No pending approval/);
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
      if (e.kind === 'approvals') for (const a of e.approvals) void remote.approve(a.callId, 'allow', a.promptId);
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

  it('authenticates portable bundles and validates invalid streams before publishing', async () => {
    const { host } = await mockHost({});
    gw = await startGateway(host, { port: 0, advertise: false });
    const client = new GatewayClient(gw);
    const s = host.createSession({ cwd: tempWorkspace(), title: 'Portable over HTTP' });
    expect((await fetch(`${gw.url}/api/session-bundles/${s.id}`)).status).toBe(401);
    expect((await fetch(`${gw.url}/api/session-bundles`, { method: 'POST', body: 'not a bundle' })).status).toBe(401);
    await expect(client.importSessionBundle(Readable.from([Buffer.from('not a bundle')]))).rejects.toThrow(/header|truncated/i);
    expect(host.listSessions().map(item => item.id)).toEqual([s.id]);
    const copy = await client.importSessionBundle(await client.exportSessionBundle(s.id));
    expect(copy).toMatchObject({ title: s.title, status: 'idle' });
    expect(copy.id).not.toBe(s.id);
    await host.dispose();
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
