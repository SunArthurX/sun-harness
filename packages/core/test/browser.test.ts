import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserManager, DEFAULT_BROWSER, findChrome, renderAxTree } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

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

describe.runIf(!!findChrome())('browser over CDP (local Chrome, headless)', () => {
  let server: Server;
  let base: string;
  let b: BrowserManager;
  const frames: string[] = [];

  beforeAll(async () => {
    tempHome();
    server = createServer((req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(req.url === '/second' ? '<title>Second</title><h1>Second page</h1>' : PAGE);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    b = new BrowserManager(() => ({ ...DEFAULT_BROWSER, profile: `test-${process.pid}` }), (f) => frames.push(f.sessionId));
  });
  afterAll(async () => {
    await b?.dispose();
    server?.close();
  });

  it('navigates, types, clicks by ref, follows links, goes back, and screenshots', async () => {
    const snap = await b.navigate('s1', base);
    expect(snap).toContain('Title: Greeter');
    const input = /textbox "Your name"[^\n]*\[ref=(e\d+)\]/.exec(snap)?.[1];
    const button = /button "Greet" \[ref=(e\d+)\]/.exec(snap)?.[1];
    expect(input && button).toBeTruthy();
    await b.type('s1', input!, 'Ada');
    const after = await b.click('s1', button!);
    expect(after).toContain('Hello, Ada!');
    const link = /link "Second page" \[ref=(e\d+)\]/.exec(after)?.[1];
    expect(await b.click('s1', link!)).toContain('Title: Second');
    expect(await b.back('s1')).toContain('Title: Greeter');
    const ws = tempWorkspace();
    const file = await b.screenshot('s1', join(ws, 'shot.png'));
    expect(existsSync(file)).toBe(true);
    await expect(b.click('s1', 'e999')).rejects.toThrow(/Unknown ref/);
  }, 60_000);

  it('streams frames and makes agent actions wait during a takeover', async () => {
    await b.navigate('s2', base);
    await b.setScreencast('s2', true);
    for (let i = 0; i < 40 && !frames.includes('s2'); i++) await new Promise((r) => setTimeout(r, 100));
    expect(frames).toContain('s2');
    b.setTakeover('s2', true);
    let done = false;
    const pending = b.snapshot('s2').then((s) => ((done = true), s));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    await b.input('s2', { type: 'text', text: 'x' });
    b.setTakeover('s2', false);
    expect(await pending).toMatch(/handed it back/);
    await b.setScreencast('s2', false);
  }, 60_000);

  it('exposes browser tools to a session through the host', async () => {
    const ws = tempWorkspace();
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('browser_navigate', { url: base })] }, { text: 'done', toolCalls: [] }],
    }, { browser: { ...DEFAULT_BROWSER, profile: `host-${process.pid}` } });
    const s = host.createSession({ cwd: ws, mode: 'agent' });
    await host.send(s.id, 'open it');
    await host.wait(s.id);
    const r = host.getEvents(s.id).find((e) => e.type === 'tool/result') as any;
    expect(r.output).toContain('heading 1 "Greeter"');
    expect(host.browserInfo(s.id).active).toBe(true);
    await host.dispose();
  }, 60_000);
});
