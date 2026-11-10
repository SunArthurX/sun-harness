import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BrowserManager, BrowserPermissions, browserOrigin, DEFAULT_BROWSER, findChrome, homePath, renderAxTree, type BrowserFrame } from '../src/index.js';
import { BrowserUploads, BROWSER_UPLOAD_MAX_BYTES } from '../src/browser/uploads.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const UPLOAD_PAGE = `<!doctype html><title>Upload fixture</title>
<label>Upload sample <input type="file"></label>
<output></output>
<script>
  document.querySelector('input').addEventListener('change', async event => {
    const file = event.target.files[0];
    document.querySelector('output').textContent = file.name + ': ' + await file.text();
  });
</script>`;

const PAGE = `<!doctype html><html><head><title>Greeter</title></head><body>
<h1>Greeter</h1>
<label for="n">Your name</label><input id="n" type="text">
<button id="go" onclick="document.getElementById('out').textContent = 'Hello, ' + document.getElementById('n').value + '!'">Greet</button>
<p id="out"></p>
<a href="/second">Second page</a>
</body></html>`;

describe('accessibility snapshot rendering', () => {
  it('assigns refs to interactive nodes and keeps text', () => {
    const nodes = [
      { nodeId: '1', role: { value: 'RootWebArea' }, name: { value: 'Shop' }, childIds: ['2', '3', '4'] },
      { nodeId: '2', parentId: '1', role: { value: 'heading' }, name: { value: 'Cart' }, properties: [{ name: 'level', value: { value: 2 } }], childIds: ['5'] },
      { nodeId: '5', parentId: '2', role: { value: 'StaticText' }, name: { value: 'Cart' } },
      { nodeId: '3', parentId: '1', role: { value: 'button' }, name: { value: 'Pay' }, backendDOMNodeId: 42 },
      { nodeId: '4', parentId: '1', role: { value: 'generic' }, childIds: ['6'] },
      { nodeId: '6', parentId: '4', role: { value: 'StaticText' }, name: { value: 'Total 10 EUR' } },
    ];
    const { text, refs } = renderAxTree(nodes as any);
    expect(text).toBe(['- page "Shop"', '  - heading 2 "Cart"', '  - button "Pay" [ref=e1]', '  - Total 10 EUR'].join('\n'));
    expect(refs.get('e1')).toBe(42);
  });
});

function grant(permissions: BrowserPermissions, origin: string, action: 'browse' | 'upload' | 'download' = 'browse', decision: 'allow' | 'deny' | 'ask' = 'allow') {
  expect(permissions.update({ expectedRevision: permissions.snapshot().revision, origin, action, decision }).ok).toBe(true);
}

describe('browser origin permissions', () => {
  it('normalizes origins, isolates actions, handles stale revisions, and audits without URL details', () => {
    tempHome();
    const permissions = new BrowserPermissions();
    const origin = 'https://example.com';
    const url = 'https://EXAMPLE.COM:443/private?secret=private-value#private';
    const initial = permissions.snapshot();
    expect(browserOrigin(url)).toBe(origin);
    expect(() => browserOrigin('https://user:pass@example.com')).toThrow(/BROWSER_INVALID_ORIGIN/);
    expect(() => browserOrigin('file:///tmp/example')).toThrow(/BROWSER_INVALID_ORIGIN/);
    expect(() => permissions.require('test', url, 'browse')).toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(permissions.snapshot().requests).toEqual([{ sessionId: 'test', origin, action: 'browse' }]);
    grant(permissions, url, 'upload');
    expect(permissions.update({ expectedRevision: initial.revision, origin, action: 'browse', decision: 'allow' }))
      .toEqual({ ok: false, code: 'CONFLICT' });
    expect(() => permissions.require('test', url, 'browse')).toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(() => permissions.require('test', url, 'download')).toThrow(/BROWSER_PERMISSION_REQUIRED/);
    grant(permissions, url);
    expect(permissions.decision('https://example.com:8443', 'browse')).toBe('ask');
    expect(permissions.decision('http://example.com', 'browse')).toBe('ask');
    expect(new BrowserPermissions().decision(url, 'browse')).toBe('allow');
    grant(permissions, url, 'browse', 'deny');
    expect(() => permissions.require('test', url, 'browse')).toThrow(/BROWSER_PERMISSION_DENIED/);
    grant(permissions, url, 'browse', 'ask');
    expect(permissions.snapshot().rules).toEqual([{ origin, action: 'upload', decision: 'allow' }]);
    const audit = readFileSync(homePath('settings', 'audit.jsonl'), 'utf8');
    expect(audit).toContain(origin);
    expect(audit).not.toContain('private');
  });
});

describe('browser transfer limits', () => {
  it('expires the approved bytes and rejects files beyond the upload limit', () => {
    vi.useFakeTimers();
    try {
      const uploads = new BrowserUploads();
      const target = {
        origin: 'https://example.com', generation: 'tab', document: 1, lease: 0,
        permissionRevision: 'fixture', maxBytes: BROWSER_UPLOAD_MAX_BYTES,
      };
      const name = 'fixture.txt';
      const data = Buffer.from('fixture').toString('base64');
      const approval = uploads.approve('session', target, { target, name, data });
      expect(uploads.list('session', target)).toEqual([approval]);
      expect(() => uploads.approve('session', target, {
        target, name, data: Buffer.alloc(BROWSER_UPLOAD_MAX_BYTES + 1).toString('base64'),
      })).toThrow(/BROWSER_UPLOAD_INVALID/);
      vi.advanceTimersByTime(5 * 60_000);
      expect(uploads.list('session', target)).toEqual([]);
      expect(() => uploads.consume('session', target, approval.handle)).toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);
    } finally { vi.useRealTimers(); }
  });

  it('stops a managed browser that never opens its DevTools port', async () => {
    tempHome();
    const dir = tempWorkspace();
    const pidFile = join(dir, 'fake-chrome.pid');
    const chromePath = join(dir, 'fake-chrome');
    writeFileSync(chromePath, `#!/bin/sh\necho $$ > ${JSON.stringify(pidFile)}\nexec sleep 300\n`, { mode: 0o755 });
    const b = new BrowserManager(() => ({ ...DEFAULT_BROWSER, chromePath, profile: `stall-${process.pid}` }));
    grant(b.permissions, 'https://example.com');
    try {
      await expect(b.navigate('s', 'https://example.com')).rejects.toThrow(/did not open a DevTools port/);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    } finally {
      await b.dispose();
    }
  }, 30_000);

  it('requires explicit delegation before using an external browser profile', async () => {
    const b = new BrowserManager(() => ({ ...DEFAULT_BROWSER, mode: 'cdp', cdpUrl: 'http://127.0.0.1:1' }));
    expect(b.available()).toBe(false);
    await expect(b.snapshot('external')).rejects.toThrow(/BROWSER_CONTEXT_NOT_DELEGATED/);
    expect(b.profile()).toMatchObject({ owner: 'external', active: false, location: undefined });
  });
});

describe.runIf(!!findChrome())('browser over CDP (local Chrome, headless)', () => {
  let server: Server;
  let destination: Server;
  let otherOrigin: string;
  let destinationHits = 0;
  let frameHits = 0;
  let popupHits = 0;
  let downloadHits = 0;
  let signalSlowDownload: (() => void) | undefined;
  let browserDownloadDir: string;
  let base: string;
  let b: BrowserManager;
  const frames: BrowserFrame[] = [];

  beforeAll(async () => {
    tempHome();
    destination = createServer((req, res) => {
      if (req.url === '/download-target') {
        downloadHits++;
        res.setHeader('content-disposition', 'attachment; filename="../../reviewed.bin"');
        res.end(Buffer.from([0x00, 0xff, 0x01, 0x80]));
        return;
      }
      if (req.url === '/target') destinationHits++;
      if (req.url === '/iframe-target') frameHits++;
      if (req.url === '/popup-target') popupHits++;
      res.end('<title>Redirect target</title>');
    });
    await new Promise<void>(r => destination.listen(0, '127.0.0.1', r));
    otherOrigin = `http://127.0.0.1:${(destination.address() as AddressInfo).port}`;
    server = createServer((req, res) => {
      if (req.url === '/download-redirect') {
        res.writeHead(302, { location: `${otherOrigin}/download-target` }).end();
        return;
      }
      if (req.url === '/download-loop') {
        res.writeHead(302, { location: '/download-loop' }).end();
        return;
      }
      if (req.url === '/download-cookie') {
        if (req.headers.cookie !== 'fixture=authorized') { res.writeHead(401).end(); return; }
        res.end('authenticated bytes');
        return;
      }
      if (req.url === '/download-large') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        let remaining = 21;
        const pump = () => {
          while (remaining-- > 0) {
            if (!res.write(Buffer.alloc(1024 * 1024, 0x58))) { res.once('drain', pump); return; }
          }
          res.end();
        };
        pump();
        return;
      }
      if (req.url === '/download-slow') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.write('partial bytes');
        signalSlowDownload?.();
        return;
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `${otherOrigin}/target` }).end();
        return;
      }
      res.setHeader('content-type', 'text/html');
      if (req.url === '/upload') { res.end(UPLOAD_PAGE); return; }
      if (req.url === '/iframes') {
        res.end(`<title>Frame fixture</title><iframe src="${otherOrigin}/iframe-target"></iframe>`);
        return;
      }
      if (req.url === '/popups') {
        res.end(`<title>Popup fixture</title><a target="_blank" href="${otherOrigin}/popup-target">Open popup</a>`);
        return;
      }
      res.end(req.url === '/second' ? '<title>Second</title><h1>Second page</h1>' : PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const profile = `test-${process.pid}`;
    const config = homePath('browser', 'profiles', profile, 'Default', 'Preferences');
    browserDownloadDir = tempWorkspace();
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, JSON.stringify({ download: { default_directory: browserDownloadDir, prompt_for_download: false } }));
    b = new BrowserManager(() => ({ ...DEFAULT_BROWSER, profile }), (f) => frames.push(f));
    grant(b.permissions, base);
  });
  afterAll(async () => {
    await b?.dispose();
    server?.close();
    destination?.close();
  });

  it('navigates, types, clicks by ref, follows links, goes back, and screenshots', async () => {
    const snap = await b.navigate('s1', base);
    expect(snap).toContain('Title: Greeter');
    const input = /textbox "Your name"[^\n]*\[ref=(e\w+)\]/.exec(snap)?.[1];
    const button = /button "Greet" \[ref=(e\w+)\]/.exec(snap)?.[1];
    expect(input && button).toBeTruthy();
    const typed = await b.type('s1', input!, 'Ada');
    await expect(b.click('s1', button!)).rejects.toThrow(/BROWSER_STALE_REF/);
    const currentButton = /button "Greet" \[ref=(e\w+)\]/.exec(typed)?.[1];
    const after = await b.click('s1', currentButton!);
    expect(after).toContain('Hello, Ada!');
    const link = /link "Second page" \[ref=(e\w+)\]/.exec(after)?.[1];
    expect(await b.click('s1', link!)).toContain('Title: Second');
    expect(await b.back('s1')).toContain('Title: Greeter');
    const ws = tempWorkspace();
    const file = await b.screenshot('s1', join(ws, 'shot.png'));
    expect(existsSync(file)).toBe(true);
    await expect(b.click('s1', 'e999')).rejects.toThrow(/BROWSER_STALE_REF/);
  }, 60_000);

  it('blocks an unapproved redirect before the target origin receives a request', async () => {
    await expect(b.navigate('redirect', `${base}/redirect`)).rejects.toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(destinationHits).toBe(0);
    grant(b.permissions, otherOrigin, 'upload');
    await expect(b.navigate('redirect', `${base}/redirect`)).rejects.toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(destinationHits).toBe(0);
    grant(b.permissions, otherOrigin);
    expect(await b.navigate('redirect', `${base}/redirect`)).toContain('Title: Redirect target');
    expect(destinationHits).toBe(1);
    grant(b.permissions, otherOrigin, 'browse', 'deny');
    await expect(b.snapshot('redirect')).rejects.toThrow(/BROWSER_PERMISSION_DENIED/);
  }, 60_000);

  it('blocks unreviewed subframe navigations and suppresses a tab opened by a managed page', async () => {
    grant(b.permissions, otherOrigin, 'browse', 'ask');
    expect(await b.navigate('iframe', `${base}/iframes`)).toContain('Title: Frame fixture');
    expect(b.permissions.snapshot().requests).toContainEqual({ sessionId: 'iframe', action: 'browse', origin: otherOrigin });
    expect(frameHits).toBe(0);
    const snap = await b.navigate('popup', `${base}/popups`);
    const ref = /link "Open popup" \[ref=(e\w+)\]/.exec(snap)![1];
    await b.click('popup', ref);
    expect(popupHits).toBe(0);
  }, 60_000);

  it('isolates live frames and revokes stale control and agent actions after takeover', async () => {
    const snap = await b.navigate('s2', base);
    const ref = /button "Greet" \[ref=(e\w+)\]/.exec(snap)![1];
    await b.setScreencast('s2', true);
    await b.setScreencast('other', true);
    const frame = frames.findLast(f => f.sessionId === 's2')!;
    expect(frame).toBeDefined();
    expect(() => b.setTakeover('other', true, frame)).toThrow(/BROWSER_FRAME_STALE/);
    const pending = b.click('s2', ref);
    const control = b.setTakeover('s2', true, frame)!;
    await expect(pending).rejects.toThrow(/BROWSER_TAKEOVER/);
    await expect(b.snapshot('s2')).rejects.toThrow(/BROWSER_TAKEOVER/);
    expect(() => b.setTakeover('s2', true, frame)).toThrow(/BROWSER_TAKEOVER_OWNED/);
    expect(() => b.setTakeover('s2', false)).toThrow(/BROWSER_CONTROL_STALE/);
    await expect(b.input('s2', { type: 'text', text: 'x' }, { ...frame, frameId: -1 }, control)).rejects.toThrow(/BROWSER_FRAME_STALE/);
    await b.input('s2', { type: 'text', text: 'x' }, frames.findLast(f => f.sessionId === 's2')!, control);
    b.setTakeover('s2', false, undefined, control);
    await expect(b.input('s2', { type: 'text', text: 'x' }, frame, control)).rejects.toThrow(/BROWSER_CONTROL_STALE/);
    await expect(b.press('s2', 'Enter')).rejects.toThrow(/BROWSER_SNAPSHOT_REQUIRED/);
    expect(await b.snapshot('s2')).toContain('Title: Greeter');
    await expect(b.click('s2', ref)).rejects.toThrow(/BROWSER_STALE_REF/);
    await b.closeTab('s2');
    await b.navigate('s2', base);
    await b.setScreencast('s2', true);
    expect(() => b.setTakeover('s2', true, frame)).toThrow(/BROWSER_FRAME_STALE/);
    await expect(b.click('s2', ref)).rejects.toThrow(/BROWSER_STALE_REF/);
  }, 60_000);

  it('uses only a confirmed in-memory file for the owning document and revokes prior handles', async () => {
    const session = 'upload';
    const findInput = (snap: string) => {
      const ref = snap.split('\n').find(line => /Upload sample|Choose File/i.test(line) && line.includes('[ref='));
      expect(ref, snap).toBeDefined();
      return /\[ref=(e\w+)\]/.exec(ref!)![1];
    };
    const open = () => b.navigate(session, `${base}/upload`);
    const name = 'reviewed.txt';
    const data = Buffer.from('reviewed bytes').toString('base64');
    const approve = () => b.approveUpload(session, { target: b.previewUpload(session), name, data });
    const ref = findInput(await open());
    expect(() => approve()).toThrow(/BROWSER_PERMISSION_REQUIRED/);
    grant(b.permissions, base, 'upload');
    await expect(b.upload(session, ref, '/tmp/raw-file')).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);
    expect(() => b.approveUpload(session, { target: b.previewUpload(session), name: '../file', data })).toThrow(/BROWSER_UPLOAD_INVALID/);
    expect(() => b.approveUpload(session, { target: b.previewUpload(session), name, data: '%bad%' })).toThrow(/BROWSER_UPLOAD_INVALID/);

    const approval = approve();
    expect(b.listUploads(session)).toEqual([approval]);
    const otherRef = findInput(await b.navigate('upload-other', `${base}/upload`));
    await expect(b.upload('upload-other', otherRef, approval.handle)).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);
    expect(await b.upload(session, ref, approval.handle)).toContain('reviewed.txt');
    expect(await b.evaluate(session, 'document.querySelector("output").textContent')).toBe('reviewed.txt: reviewed bytes');
    await expect(b.upload(session, ref, approval.handle)).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);

    const prior = approve();
    grant(b.permissions, base, 'upload', 'deny');
    grant(b.permissions, base, 'upload');
    await expect(b.upload(session, ref, prior.handle)).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);
    const staleTarget = b.previewUpload(session);
    const beforeNavigation = approve();
    const currentRef = findInput(await open());
    expect(() => b.approveUpload(session, { target: staleTarget, name, data })).toThrow(/BROWSER_UPLOAD_TARGET_STALE/);
    await expect(b.upload(session, currentRef, beforeNavigation.handle)).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);

    const beforeTakeover = approve();
    await b.setScreencast(session, true);
    const control = b.setTakeover(session, true, frames.findLast(frame => frame.sessionId === session)!)!;
    expect(b.listUploads(session)).toEqual([]);
    b.setTakeover(session, false, undefined, control);
    const afterHandback = findInput(await b.snapshot(session));
    await expect(b.upload(session, afterHandback, beforeTakeover.handle)).rejects.toThrow(/BROWSER_UPLOAD_HANDLE_INVALID/);
  }, 60_000);

  it('stages authenticated binary downloads, checks every origin, and blocks native blob downloads', async () => {
    const session = 'download';
    await b.navigate(session, base);
    await expect(b.download(session, `${base}/download-redirect`)).rejects.toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(downloadHits).toBe(0);
    grant(b.permissions, base, 'download');
    await expect(b.download(session, `${base}/download-redirect`)).rejects.toThrow(/BROWSER_PERMISSION_REQUIRED/);
    expect(downloadHits).toBe(0);
    grant(b.permissions, otherOrigin, 'download');
    const artifact = await b.download(session, `${base}/download-redirect`);
    expect(downloadHits).toBe(1);
    expect(artifact.name).toBe('reviewed.bin');
    expect(dirname(artifact.path)).toBe(realpathSync(homePath('browser', 'downloads', session)));
    expect(readFileSync(artifact.path)).toEqual(Buffer.from([0x00, 0xff, 0x01, 0x80]));
    expect(artifact.bytes).toBe(4);
    await b.evaluate(session, 'document.cookie = "fixture=authorized; path=/"');
    const authenticated = await b.download(session, `${base}/download-cookie`);
    expect(readFileSync(authenticated.path, 'utf8')).toBe('authenticated bytes');
    await expect(b.download(session, `${base}/download-loop`)).rejects.toThrow(/BROWSER_DOWNLOAD_REDIRECT_LIMIT/);
    await b.evaluate(session, `(() => {
      const link = document.createElement('a');
      link.download = 'blocked-native.txt';
      link.href = URL.createObjectURL(new Blob(['must not be saved']));
      document.body.append(link);
      link.click();
    })()`);
    await new Promise(resolve => setTimeout(resolve, 350));
    expect(existsSync(join(browserDownloadDir, 'blocked-native.txt'))).toBe(false);
    expect(readdirSync(dirname(artifact.path))).toHaveLength(2);
    expect(await b.snapshot(session)).toContain('Title: Greeter');
  }, 60_000);

  it('rejects unsafe staging and cleans partial downloads after size limits, cancellation, or takeover', async () => {
    const session = 'download-limits';
    await b.navigate(session, base);
    const destination = homePath('browser', 'downloads', session);
    const outside = join(tempWorkspace(), 'outside');
    mkdirSync(outside);
    mkdirSync(dirname(destination), { recursive: true });
    symlinkSync(outside, destination, 'dir');
    await expect(b.download(session, `${base}/download-cookie`)).rejects.toThrow(/BROWSER_DOWNLOAD_DIRECTORY_INVALID/);
    expect(readdirSync(outside)).toEqual([]);

    const transfer = 'download-transfer';
    await b.navigate(transfer, base);
    const stage = homePath('browser', 'downloads', transfer);
    await expect(b.download(transfer, `${base}/download-large`)).rejects.toThrow(/BROWSER_DOWNLOAD_TOO_LARGE/);
    expect(readdirSync(stage)).toEqual([]);
    const started = () => new Promise<void>(resolve => { signalSlowDownload = resolve; });
    const abort = new AbortController();
    const requested = started();
    const cancelled = b.download(transfer, `${base}/download-slow`, abort.signal);
    await requested;
    await expect(b.download(transfer, `${base}/download-cookie`)).rejects.toThrow(/BROWSER_DOWNLOAD_BUSY/);
    abort.abort();
    await expect(cancelled).rejects.toThrow(/BROWSER_ABORTED/);
    expect(readdirSync(stage)).toEqual([]);

    await b.setScreencast(transfer, true);
    const next = started();
    const intercepted = b.download(transfer, `${base}/download-slow`);
    await next;
    const lease = b.setTakeover(transfer, true, frames.findLast(frame => frame.sessionId === transfer)!)!;
    await expect(intercepted).rejects.toThrow(/BROWSER_TAKEOVER/);
    b.setTakeover(transfer, false, undefined, lease);
    expect(readdirSync(stage)).toEqual([]);
    await b.snapshot(transfer);

    const renewed = started();
    const revoked = b.download(transfer, `${base}/download-slow`);
    await renewed;
    grant(b.permissions, base, 'download', 'deny');
    await expect(revoked).rejects.toThrow(/BROWSER_PERMISSION_DENIED/);
    expect(readdirSync(stage)).toEqual([]);
  }, 60_000);

  it('exposes browser tools to a session through the host', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('browser_navigate', { url: base })] }, { text: 'done', toolCalls: [] }],
    }, { browser: { ...DEFAULT_BROWSER, profile: `host-${process.pid}` } });
    grant(host.browser.permissions, base);
    const s = host.createSession({ cwd: ws, mode: 'agent' });
    await host.send(s.id, 'open it');
    await host.wait(s.id);
    const r = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(r.output).toContain('heading 1 "Greeter"');
    expect(host.browserInfo(s.id).active).toBe(true);
    const profile = homePath('browser', 'profiles', `host-${process.pid}`);
    const users = () => execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' }).split('\n').filter((line) => line.includes(`--user-data-dir=${profile}`));
    expect(users().length).toBeGreaterThan(0);
    await host.dispose();
    expect(users()).toEqual([]);
  }, 60_000);
});
