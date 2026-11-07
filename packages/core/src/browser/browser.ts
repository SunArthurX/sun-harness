import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { ensureDir, homePath } from '../paths.js';
import { CdpConnection, browserWsUrl } from './cdp.js';

export interface BrowserConfig {
  /** local: a Chrome/Chromium on this machine · docker: sandboxed Chromium + Xvfb + noVNC · cdp: connect to cdpUrl. */
  mode: 'local' | 'docker' | 'cdp';
  /** Local mode: run without a window (the desktop live view still shows the page). */
  headless: boolean;
  /** Persistent profile (cookies, logins) under ~/.sun/browser/profiles/<name>. */
  profile: string;
  chromePath?: string;
  /** DevTools HTTP endpoint for mode "cdp", e.g. http://127.0.0.1:9222. */
  cdpUrl?: string;
  docker: { image: string };
  viewport: { width: number; height: number };
}

export const DEFAULT_BROWSER: BrowserConfig = {
  mode: 'local',
  headless: true,
  profile: 'default',
  docker: { image: 'sun-harness/browser:latest' },
  viewport: { width: 1280, height: 800 },
};

const CHROME_PATHS: Record<string, string[]> = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium', '/usr/bin/microsoft-edge'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
};

export function findChrome(explicit?: string): string | undefined {
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  return (CHROME_PATHS[platform()] ?? []).find((p) => existsSync(p));
}

export function dockerImageExists(image: string): boolean {
  return spawnSync('docker', ['image', 'inspect', image], { timeout: 10_000 }).status === 0;
}

const INTERACTIVE = new Set(['link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton', 'treeitem', 'textarea']);
const STRUCTURE = new Set(['heading', 'img', 'image', 'dialog', 'alert', 'navigation', 'main', 'form', 'table', 'row', 'cell', 'columnheader', 'list', 'listitem', 'article', 'region', 'banner', 'contentinfo', 'search']);

interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: { value: string };
  name?: { value: string };
  value?: { value: unknown };
  properties?: { name: string; value: { value: unknown } }[];
  childIds?: string[];
  backendDOMNodeId?: number;
  parentId?: string;
}

/** Render an accessibility tree as an indented outline; interactive elements get refs (e1, e2, …). */
export function renderAxTree(nodes: AxNode[], maxChars = 14_000): { text: string; refs: Map<string, number> } {
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const refs = new Map<string, number>();
  const lines: string[] = [];
  let size = 0;
  let truncated = false;
  const root = nodes.find((n) => !n.parentId) ?? nodes[0];
  const visit = (n: AxNode | undefined, depth: number) => {
    if (!n || truncated) return;
    const role = n.role?.value ?? '';
    const name = String(n.name?.value ?? '').replace(/\s+/g, ' ').trim();
    let printed = false;
    if (!n.ignored && role !== 'none' && role !== 'generic' && role !== 'InlineTextBox') {
      let line = '';
      if (role === 'StaticText') {
        if (name) line = name.slice(0, 300);
      } else if (INTERACTIVE.has(role) && n.backendDOMNodeId) {
        const ref = `e${refs.size + 1}`;
        refs.set(ref, n.backendDOMNodeId);
        const props = (n.properties ?? [])
          .filter((p) => ['checked', 'disabled', 'expanded', 'selected', 'required', 'focused'].includes(p.name) && p.value.value !== false)
          .map((p) => (p.value.value === true ? p.name : `${p.name}=${p.value.value}`));
        const value = n.value?.value !== undefined && String(n.value.value) ? ` value="${String(n.value.value).slice(0, 100)}"` : '';
        line = `${role}${name ? ` "${name.slice(0, 120)}"` : ''}${value}${props.length ? ` (${props.join(', ')})` : ''} [ref=${ref}]`;
      } else if (STRUCTURE.has(role) || role === 'RootWebArea' || role === 'WebArea') {
        const level = n.properties?.find((p) => p.name === 'level')?.value.value;
        line = role === 'RootWebArea' || role === 'WebArea' ? `page "${name}"` : `${role}${level ? ` ${level}` : ''}${name ? ` "${name.slice(0, 160)}"` : ''}`;
      }
      if (line) {
        const out = `${'  '.repeat(Math.min(depth, 12))}- ${line}`;
        if (size + out.length > maxChars) {
          truncated = true;
          return;
        }
        // Collapse text that only repeats the parent's accessible name.
        if (!(role === 'StaticText' && lines.length && lines[lines.length - 1].includes(`"${name}"`))) {
          lines.push(out);
          size += out.length + 1;
        }
        printed = true;
      }
    }
    for (const c of n.childIds ?? []) visit(byId.get(c), printed ? depth + 1 : depth);
  };
  visit(root, 0);
  if (truncated) lines.push('… (snapshot truncated; scroll or use a more specific page)');
  return { text: lines.join('\n'), refs };
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};

export interface BrowserFrame {
  sessionId: string;
  data: string;
  width: number;
  height: number;
  url: string;
  title: string;
}

/** Input forwarded from a human watching the live view (takeover). */
export type BrowserInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

interface Tab {
  targetId: string;
  cdpSession: string;
  refs: Map<string, number>;
  inflight: number;
  lastNetwork: number;
  url: string;
  title: string;
  screencast: boolean;
}

/** One browser per profile, one tab per harness session. */
export class BrowserManager {
  private conn?: CdpConnection;
  private connecting?: Promise<CdpConnection>;
  private proc?: ChildProcess;
  private container?: string;
  private tabs = new Map<string, Tab>();
  private takeovers = new Map<string, { waiters: (() => void)[] }>();
  /** noVNC URL when running in Docker. */
  vncUrl?: string;

  constructor(
    private readonly cfg: () => BrowserConfig,
    private readonly onFrame: (f: BrowserFrame) => void = () => undefined,
  ) {}

  /** Whether a browser backend exists for the current config (capability gating). */
  available(): boolean {
    const c = this.cfg();
    if (c.mode === 'cdp') return !!c.cdpUrl;
    if (c.mode === 'docker') return dockerImageExists(c.docker.image);
    return !!findChrome(c.chromePath);
  }

  describe(): string {
    const c = this.cfg();
    return c.mode === 'cdp' ? `CDP ${c.cdpUrl}` : c.mode === 'docker' ? `docker ${c.docker.image}${this.vncUrl ? ` · live view ${this.vncUrl}` : ''}` : `${findChrome(c.chromePath) ?? 'no Chrome found'}${c.headless ? ' (headless)' : ''} · profile ${c.profile}`;
  }

  private async connection(): Promise<CdpConnection> {
    if (this.conn && !this.conn.isClosed) return this.conn;
    this.connecting ??= this.start().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async start(): Promise<CdpConnection> {
    const c = this.cfg();
    let httpBase: string;
    if (c.mode === 'cdp') {
      if (!c.cdpUrl) throw new Error('browser.cdpUrl is not set.');
      httpBase = c.cdpUrl;
    } else if (c.mode === 'docker') httpBase = await this.startDocker(c);
    else httpBase = await this.startLocal(c);
    const conn = await CdpConnection.connect(await browserWsUrl(httpBase));
    conn.on('__close', () => {
      this.tabs.clear();
      this.conn = undefined;
    });
    conn.on('Network.requestWillBeSent', (_p, sid) => this.tabBySession(sid, (t) => ((t.inflight += 1), (t.lastNetwork = Date.now()))));
    const done = (_p: unknown, sid?: string) => this.tabBySession(sid, (t) => ((t.inflight = Math.max(0, t.inflight - 1)), (t.lastNetwork = Date.now())));
    conn.on('Network.loadingFinished', done);
    conn.on('Network.loadingFailed', done);
    conn.on('Page.frameNavigated', (p, sid) => this.tabBySession(sid, (t) => !p.frame.parentId && ((t.url = p.frame.url), (t.inflight = 0))));
    conn.on('Page.screencastFrame', (p, sid) => {
      conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => undefined);
      for (const [hs, t] of this.tabs) {
        if (t.cdpSession === sid) this.onFrame({ sessionId: hs, data: p.data, width: p.metadata.deviceWidth, height: p.metadata.deviceHeight, url: t.url, title: t.title });
      }
    });
    this.conn = conn;
    return conn;
  }

  private tabBySession(sid: string | undefined, fn: (t: Tab) => void): void {
    for (const t of this.tabs.values()) if (t.cdpSession === sid) fn(t);
  }

  private async startLocal(c: BrowserConfig): Promise<string> {
    const chrome = findChrome(c.chromePath);
    if (!chrome) throw new Error('No Chrome, Chromium, Edge or Brave found. Install one, set browser.chromePath, or use browser.mode "docker".');
    const profile = ensureDir(homePath('browser', 'profiles', c.profile.replace(/[^\w.-]/g, '_')));
    const portFile = join(profile, 'DevToolsActivePort');
    // Re-use a browser already running on this profile (e.g. started by an earlier sun process).
    if (existsSync(portFile)) {
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      try {
        await browserWsUrl(`http://127.0.0.1:${port}`);
        return `http://127.0.0.1:${port}`;
      } catch {
        rmSync(portFile, { force: true });
      }
    }
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-port=0',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      `--window-size=${c.viewport.width},${c.viewport.height}`,
      ...(c.headless ? ['--headless=new'] : []),
      'about:blank',
    ];
    this.proc = spawn(chrome, args, { stdio: 'ignore', detached: false });
    this.proc.unref();
    for (let i = 0; i < 100; i++) {
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, 'utf8').split('\n')[0];
        if (port) return `http://127.0.0.1:${port}`;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`Chrome did not open a DevTools port (${chrome}).`);
  }

  private async startDocker(c: BrowserConfig): Promise<string> {
    const name = `sun-browser-${c.profile.replace(/[^\w.-]/g, '_')}`;
    const running = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' }).stdout.trim() === 'true';
    if (!running) {
      spawnSync('docker', ['rm', '-f', name]);
      const profile = ensureDir(homePath('browser', 'docker-profiles', c.profile.replace(/[^\w.-]/g, '_')));
      const r = spawnSync(
        'docker',
        ['run', '-d', '--name', name, '--label', 'sun-harness=browser', '--shm-size=1g', '-e', `SCREEN=${c.viewport.width}x${c.viewport.height}x24`, '-v', `${profile}:/profile`, '-p', '127.0.0.1::9223', '-p', '127.0.0.1::6080', c.docker.image],
        { encoding: 'utf8', timeout: 120_000 },
      );
      if (r.status !== 0) throw new Error(`Could not start the browser container: ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
      this.container = name;
    }
    const port = (p: number) => spawnSync('docker', ['port', name, String(p)], { encoding: 'utf8' }).stdout.split('\n')[0].trim().split(':').pop();
    const cdp = port(9223);
    const vnc = port(6080);
    this.vncUrl = vnc ? `http://127.0.0.1:${vnc}/vnc.html?autoconnect=1&resize=scale` : undefined;
    for (let i = 0; i < 100; i++) {
      try {
        await browserWsUrl(`http://127.0.0.1:${cdp}`);
        return `http://127.0.0.1:${cdp}`;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error('The browser container did not expose DevTools in time.');
  }

  /** The session's tab (created on first use). */
  private async tab(sessionId: string): Promise<{ conn: CdpConnection; t: Tab }> {
    const conn = await this.connection();
    let t = this.tabs.get(sessionId);
    if (!t) {
      // A window per session: background tabs of a shared window do not paint, so they could not be streamed.
      const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', newWindow: true });
      const { sessionId: cdpSession } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
      t = { targetId, cdpSession, refs: new Map(), inflight: 0, lastNetwork: 0, url: 'about:blank', title: '', screencast: false };
      this.tabs.set(sessionId, t);
      const vp = this.cfg().viewport;
      await Promise.all([
        conn.send('Page.enable', {}, cdpSession),
        conn.send('Network.enable', {}, cdpSession),
        conn.send('DOM.enable', {}, cdpSession),
        conn.send('Accessibility.enable', {}, cdpSession),
        conn.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false }, cdpSession),
      ]);
    }
    return { conn, t };
  }

  hasTab(sessionId: string): boolean {
    return this.tabs.has(sessionId);
  }

  /** Wait until the page has loaded and the network has been quiet for a moment (bounded). */
  private async settle(conn: CdpConnection, t: Tab, maxMs = 8000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      if (t.inflight === 0 && Date.now() - t.lastNetwork > 400) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    try {
      const r = await conn.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, t.cdpSession, 5000);
      t.title = String(r.result?.value ?? '');
    } catch {
      // page is navigating
    }
  }

  /** Block while a human has taken over this session's browser. */
  private async untilReleased(sessionId: string, signal?: AbortSignal): Promise<boolean> {
    const to = this.takeovers.get(sessionId);
    if (!to) return false;
    await new Promise<void>((resolve) => {
      to.waiters.push(resolve);
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return true;
  }

  private async act<T>(sessionId: string, signal: AbortSignal | undefined, fn: (conn: CdpConnection, t: Tab) => Promise<T>): Promise<{ value: T; note: string }> {
    const waited = await this.untilReleased(sessionId, signal);
    const { conn, t } = await this.tab(sessionId);
    const value = await fn(conn, t);
    return { value, note: waited ? 'The user had taken over the browser and has handed it back; the page may have changed (take a snapshot).\n' : '' };
  }

  async navigate(sessionId: string, url: string, signal?: AbortSignal): Promise<string> {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      const loaded = conn.waitFor('Page.loadEventFired', t.cdpSession, 30_000);
      const r = await conn.send('Page.navigate', { url }, t.cdpSession);
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
      await loaded;
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return note + value;
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, (conn, t) => this.snapshotOf(conn, t));
    return note + value;
  }

  private async snapshotOf(conn: CdpConnection, t: Tab): Promise<string> {
    const { nodes } = await conn.send('Accessibility.getFullAXTree', {}, t.cdpSession);
    const { text, refs } = renderAxTree(nodes);
    t.refs = refs;
    const { result } = await conn.send('Runtime.evaluate', { expression: 'location.href + "\\n" + document.title', returnByValue: true }, t.cdpSession);
    const [href, title] = String(result?.value ?? '\n').split('\n');
    t.url = href;
    t.title = title;
    return `URL: ${href}\nTitle: ${title}\n\n${text || '(empty page)'}`;
  }

  private async node(conn: CdpConnection, t: Tab, ref: string): Promise<number> {
    const id = t.refs.get(ref);
    if (!id) throw new Error(`Unknown ref ${ref}. Take a new browser_snapshot; refs change when the page changes.`);
    return id;
  }

  private async center(conn: CdpConnection, t: Tab, backendNodeId: number): Promise<{ x: number; y: number }> {
    await conn.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, t.cdpSession).catch(() => undefined);
    const { model } = await conn.send('DOM.getBoxModel', { backendNodeId }, t.cdpSession);
    const q: number[] = model.content;
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  private async mouseClick(conn: CdpConnection, t: Tab, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, t.cdpSession);
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, t.cdpSession);
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, t.cdpSession);
  }

  private async key(conn: CdpConnection, t: Tab, key: string): Promise<void> {
    const parts = key.split('+');
    const main = parts.pop()!;
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }[p] ?? 0), 0);
    const k = KEYS[main] ?? { code: main.length === 1 ? `Key${main.toUpperCase()}` : main, keyCode: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0, text: main.length === 1 ? main : undefined };
    const base = { key: main === 'Space' ? ' ' : main, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: mods };
    await conn.send('Input.dispatchKeyEvent', { type: k.text && !mods ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !mods ? { text: k.text } : {}) }, t.cdpSession);
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, t.cdpSession);
  }

  async click(sessionId: string, ref: string, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      const { x, y } = await this.center(conn, t, await this.node(conn, t, ref));
      await this.mouseClick(conn, t, x, y);
      await new Promise((r) => setTimeout(r, 300));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return `${note}Clicked ${ref}.\n${value}`;
  }

  async type(sessionId: string, ref: string, text: string, opts: { submit?: boolean; clear?: boolean } = {}, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      const backendNodeId = await this.node(conn, t, ref);
      await conn.send('DOM.focus', { backendNodeId }, t.cdpSession);
      if (opts.clear !== false) {
        const { object } = await conn.send('DOM.resolveNode', { backendNodeId }, t.cdpSession);
        await conn.send(
          'Runtime.callFunctionOn',
          { objectId: object.objectId, functionDeclaration: 'function(){ if ("value" in this) { this.value = ""; this.dispatchEvent(new Event("input", {bubbles: true})); } else if (this.isContentEditable) this.textContent = ""; }' },
          t.cdpSession,
        );
      }
      await conn.send('Input.insertText', { text }, t.cdpSession);
      if (opts.submit) {
        await this.key(conn, t, 'Enter');
        await new Promise((r) => setTimeout(r, 300));
      }
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return `${note}Typed into ${ref}${opts.submit ? ' and pressed Enter' : ''}.\n${value}`;
  }

  async press(sessionId: string, key: string, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      await this.key(conn, t, key);
      await new Promise((r) => setTimeout(r, 200));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return `${note}Pressed ${key}.\n${value}`;
  }

  async scroll(sessionId: string, direction: 'up' | 'down', amount = 600, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      const vp = this.cfg().viewport;
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.width / 2, y: vp.height / 2, deltaX: 0, deltaY: direction === 'up' ? -amount : amount }, t.cdpSession);
      await new Promise((r) => setTimeout(r, 400));
      return this.snapshotOf(conn, t);
    });
    return note + value;
  }

  async back(sessionId: string, signal?: AbortSignal): Promise<string> {
    const { value, note } = await this.act(sessionId, signal, async (conn, t) => {
      await conn.send('Runtime.evaluate', { expression: 'history.back()' }, t.cdpSession);
      await new Promise((r) => setTimeout(r, 500));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return note + value;
  }

  async screenshot(sessionId: string, file: string, fullPage = false, signal?: AbortSignal): Promise<string> {
    const { value } = await this.act(sessionId, signal, async (conn, t) => {
      const { data } = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, t.cdpSession);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, Buffer.from(data, 'base64'));
      return file;
    });
    return value;
  }

  async evaluate(sessionId: string, expression: string, signal?: AbortSignal): Promise<string> {
    const { value } = await this.act(sessionId, signal, async (conn, t) => {
      const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.cdpSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2) ?? String(r.result.description ?? r.result.type);
    });
    return value.length > 20_000 ? value.slice(0, 20_000) + '\n… (truncated)' : value;
  }

  // ---------- live view and takeover ----------

  async setScreencast(sessionId: string, on: boolean): Promise<void> {
    const t0 = this.tabs.get(sessionId);
    if (!on && !t0) return;
    const { conn, t } = await this.tab(sessionId);
    if (on === t.screencast) return;
    t.screencast = on;
    const vp = this.cfg().viewport;
    if (on) await conn.send('Page.bringToFront', {}, t.cdpSession).catch(() => undefined);
    if (on) {
      await conn.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 2 }, t.cdpSession);
      // Chrome only sends frames on repaint; a static page needs one frame now.
      const { data } = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, t.cdpSession);
      this.onFrame({ sessionId, data, width: vp.width, height: vp.height, url: t.url, title: t.title });
    } else await conn.send('Page.stopScreencast', {}, t.cdpSession).catch(() => undefined);
  }

  isTakenOver(sessionId: string): boolean {
    return this.takeovers.has(sessionId);
  }

  setTakeover(sessionId: string, on: boolean): void {
    if (on) {
      if (!this.takeovers.has(sessionId)) this.takeovers.set(sessionId, { waiters: [] });
    } else {
      const to = this.takeovers.get(sessionId);
      this.takeovers.delete(sessionId);
      for (const w of to?.waiters ?? []) w();
    }
  }

  async input(sessionId: string, ev: BrowserInput): Promise<void> {
    if (!this.takeovers.has(sessionId)) throw new Error('Take over the browser before sending input.');
    const { conn, t } = await this.tab(sessionId);
    if (ev.type === 'click') await this.mouseClick(conn, t, ev.x, ev.y, ev.button);
    else if (ev.type === 'move') await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y }, t.cdpSession);
    else if (ev.type === 'wheel') await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY }, t.cdpSession);
    else if (ev.type === 'key') await this.key(conn, t, ev.key);
    else if (ev.type === 'text') await conn.send('Input.insertText', { text: ev.text }, t.cdpSession);
  }

  async closeTab(sessionId: string): Promise<void> {
    const t = this.tabs.get(sessionId);
    this.tabs.delete(sessionId);
    this.setTakeover(sessionId, false);
    if (t && this.conn && !this.conn.isClosed) await this.conn.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    for (const id of [...this.tabs.keys()]) await this.closeTab(id);
    this.conn?.close();
    this.conn = undefined;
    if (this.proc && this.proc.exitCode === null) this.proc.kill();
    if (this.container) spawnSync('docker', ['stop', '-t', '2', this.container]);
  }
}
