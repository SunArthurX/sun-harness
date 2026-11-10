import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import { hasDataActivity, holdDataActivity } from '../settings/storage-lock.js';
import { ensureDir, homePath } from '../paths.js';
import { CdpConnection, browserWsUrl } from './cdp.js';
import { BrowserPermissions, browserOrigin } from './permissions.js';
import { BrowserDownloads, type BrowserDownloadResult } from './downloads.js';
import { BROWSER_UPLOAD_MAX_BYTES, BrowserUploads, sameUploadTarget, type BrowserUploadApproval, type BrowserUploadRequest, type BrowserUploadTarget } from './uploads.js';

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
  /** Explicitly delegate the external browser context to the harness download policy. */
  cdpAllowDownloadPolicy?: boolean;
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
export function renderAxTree(nodes: AxNode[], maxChars = 14_000, prefix = 'e'): { text: string; refs: Map<string, number> } {
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
        const ref = `${prefix}${refs.size + 1}`;
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
  generation: string;
  frameId: number;
}

export type BrowserFrameRef = Pick<BrowserFrame, 'generation' | 'frameId'>;
export interface BrowserControl {
  generation: string;
  token: string;
}

/** Input forwarded from a human watching the live view (takeover). */
export type BrowserInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' }
  | { type: 'move'; x: number; y: number }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'key'; key: string }
  | { type: 'text'; text: string };

interface Tab {
  owner: string;
  targetId: string;
  cdpSession: string;
  generation: string;
  lease: number;
  document: number;
  snapshot: number;
  needsSnapshot: boolean;
  mainFrame?: string;
  blocked?: Error;
  frameId?: number;
  lastFrameAt: number;
  control?: BrowserControl & { expires: number };
  refs: Map<string, number>;
  inflight: number;
  lastNetwork: number;
  url: string;
  title: string;
  screencast: boolean;
  viewers: Set<string>;
  stream: Promise<void>;
}
type TabChannel = Pick<CdpConnection, 'send' | 'waitFor'> & { check(): void };
type AgentOperation = 'write' | 'observe' | 'navigate';

/** One browser per profile, one tab per harness session. */
export class BrowserManager {
  private conn?: CdpConnection;
  private connecting?: Promise<CdpConnection>;
  private disposing = false;
  private proc?: ChildProcess;
  private container?: string;
  private releaseProfile?: () => void;
  private tabs = new Map<string, Tab>();
  private opening = new Map<string, Promise<{ conn: CdpConnection; t: Tab }>>();
  private documents = new Map<string, Tab>();
  private nextFrame = 0;
  private readonly uploads = new BrowserUploads();
  private readonly downloads = new BrowserDownloads();
  /** noVNC URL when running in Docker. */
  vncUrl?: string;

  constructor(
    private readonly cfg: () => BrowserConfig,
    private readonly onFrame: (f: BrowserFrame) => void = () => undefined,
    readonly permissions = new BrowserPermissions(),
  ) {}

  /** Whether a browser backend exists for the current config (capability gating). */
  available(): boolean {
    const c = this.cfg();
    if (c.mode === 'cdp') return !!c.cdpUrl && c.cdpAllowDownloadPolicy === true;
    if (c.mode === 'docker') return dockerImageExists(c.docker.image);
    return !!findChrome(c.chromePath);
  }

  describe(): string {
    const c = this.cfg();
    return c.mode === 'cdp' ? 'External DevTools browser' : c.mode === 'docker' ? `docker ${c.docker.image}${this.vncUrl ? ` · live view ${this.vncUrl}` : ''}` : `${findChrome(c.chromePath) ?? 'no Chrome found'}${c.headless ? ' (headless)' : ''} · profile ${c.profile}`;
  }

  profile() {
    const config = this.cfg();
    const name = config.profile.replace(/[^\w.-]/g, '_');
    return {
      mode: config.mode, name,
      downloadPolicyDelegated: config.mode !== 'cdp' || config.cdpAllowDownloadPolicy === true,
      owner: config.mode === 'cdp' ? 'external' as const : 'managed' as const,
      location: config.mode === 'cdp' || !name || name === '.' || name === '..' ? undefined : homePath('browser', config.mode === 'docker' ? 'docker-profiles' : 'profiles', name),
      active: !!this.conn && !this.conn.isClosed,
    };
  }

  private async connection(): Promise<CdpConnection> {
    if (this.disposing) throw new Error('BROWSER_CLOSED');
    if (this.conn && !this.conn.isClosed) return this.conn;
    this.connecting ??= this.start().catch(error => {
      this.releaseProfile?.();
      this.releaseProfile = undefined;
      throw error;
    }).finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private holdBrowserOwner(resource: string): void {
    const release = holdDataActivity(resource, () => {
      if (hasDataActivity(resource)) throw new Error('BROWSER_PROFILE_IN_USE: This browser profile already has a harness controller.');
    });
    const previous = this.releaseProfile;
    this.releaseProfile = () => {
      try { release(); }
      finally { previous?.(); }
    };
  }

  private async start(): Promise<CdpConnection> {
    const c = this.cfg();
    const profile = c.profile.replace(/[^\w.-]/g, '_');
    if (c.mode !== 'cdp') {
      if (!profile || profile === '.' || profile === '..') throw new Error('Invalid browser profile name.');
      const root = c.mode === 'docker' ? 'browser/docker-profiles' : 'browser/profiles';
      this.holdBrowserOwner(`${root}/${profile}`);
    }
    let httpBase: string;
    if (c.mode === 'cdp') {
      if (!c.cdpUrl) throw new Error('browser.cdpUrl is not set.');
      if (c.cdpAllowDownloadPolicy !== true) throw new Error('BROWSER_CONTEXT_NOT_DELEGATED');
      httpBase = c.cdpUrl;
    } else if (c.mode === 'docker') httpBase = await this.startDocker(c);
    else httpBase = await this.startLocal(c);
    const endpoint = await browserWsUrl(httpBase);
    this.holdBrowserOwner(`browser/download-policy/${new URL(endpoint).pathname}`);
    const conn = await CdpConnection.connect(endpoint);
    const release = this.releaseProfile;
    conn.on('__close', () => {
      if (this.conn === conn) {
        for (const tab of this.tabs.values()) this.uploads.clear(tab.owner);
        this.tabs.clear();
        this.documents.clear();
        this.conn = undefined;
      }
      release?.();
      if (this.releaseProfile === release) this.releaseProfile = undefined;
    });
    try {
      await conn.send('Browser.setDownloadBehavior', { behavior: 'deny' }, undefined, 5000);
    } catch {
      await conn.closeAndWait();
      throw new Error('BROWSER_DOWNLOAD_POLICY_UNAVAILABLE');
    }
    conn.on('Network.requestWillBeSent', (_p, sid) => this.tabBySession(sid, (t) => ((t.inflight += 1), (t.lastNetwork = Date.now()))));
    const done = (_p: unknown, sid?: string) => this.tabBySession(sid, (t) => ((t.inflight = Math.max(0, t.inflight - 1)), (t.lastNetwork = Date.now())));
    conn.on('Network.loadingFinished', done);
    conn.on('Network.loadingFailed', done);
    conn.on('Page.frameNavigated', (p, sid) => this.tabBySession(sid, t => {
      this.invalidateDocument(t);
      if (!p.frame.parentId) {
        t.mainFrame = p.frame.id;
        t.url = p.frame.url;
        t.inflight = 0;
      }
    }));
    conn.on('Page.navigatedWithinDocument', (p, sid) => this.tabBySession(sid, t => {
      this.invalidateDocument(t);
      if (p.frameId === t.mainFrame) t.url = p.url;
    }));
    conn.on('Fetch.requestPaused', (p, sid) => {
      if (sid) void this.checkDocumentRequest(conn, sid, p);
    });
    conn.on('Target.attachedToTarget', (p, sid) => {
      const parent = sid ? this.documents.get(sid) : undefined;
      if (parent) void this.attachChildDocument(conn, parent, p);
      else if (!sid) void this.handleTopLevelTarget(conn, p);
    });
    conn.on('Target.detachedFromTarget', p => {
      const tab = this.documents.get(p.sessionId);
      this.documents.delete(p.sessionId);
      if (tab && tab.cdpSession === p.sessionId) this.forgetTab(tab);
    });
    conn.on('Target.targetDestroyed', p => {
      for (const t of this.tabs.values()) if (t.targetId === p.targetId) this.forgetTab(t);
    });
    try {
      await conn.send('Target.setDiscoverTargets', { discover: true });
      await conn.send('Target.setAutoAttach', {
        autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'page' }, { exclude: true }],
      });
    } catch (error) {
      await conn.closeAndWait();
      throw error;
    }
    conn.on('Page.screencastFrame', (p, sid) => {
      conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }, sid).catch(() => undefined);
      for (const [hs, t] of this.tabs) {
        if (t.cdpSession === sid && t.screencast) this.publishFrame(hs, t, p.data, p.metadata.deviceWidth, p.metadata.deviceHeight);
      }
    });
    this.conn = conn;
    return conn;
  }

  private tabBySession(sid: string | undefined, fn: (t: Tab) => void): void {
    for (const t of this.tabs.values()) if (t.cdpSession === sid) fn(t);
  }

  private invalidateDocument(t: Tab): void {
    this.uploads.clear(t.owner);
    t.document++;
    t.refs.clear();
    t.frameId = undefined;
  }

  private forgetTab(t: Tab): void {
    if (this.tabs.get(t.owner) === t) {
      this.uploads.clear(t.owner);
      this.tabs.delete(t.owner);
    }
    for (const [sid, owner] of this.documents) if (owner === t) this.documents.delete(sid);
  }

  private async handleTopLevelTarget(conn: CdpConnection, event: {
    sessionId: string;
    targetInfo: { targetId: string; openerId?: string; openerFrameId?: string };
    waitingForDebugger: boolean;
  }): Promise<void> {
    const { sessionId, targetInfo, waitingForDebugger } = event;
    if (!waitingForDebugger) return;
    const opener = [...this.tabs.values()].find(tab =>
      targetInfo.openerId === tab.targetId || (targetInfo.openerFrameId && targetInfo.openerFrameId === tab.mainFrame));
    if (opener) {
      await conn.send('Target.closeTarget', { targetId: targetInfo.targetId }).catch(() => undefined);
      return;
    }
    // Leave browser windows outside the session registry under their existing owner.
    await conn.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => undefined);
    await conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
  }

  private async enableDocumentChecks(conn: CdpConnection, sid: string): Promise<void> {
    await conn.send('Page.setInterceptFileChooserDialog', { enabled: true }, sid);
    await conn.send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }, sid);
    await conn.send('Target.setAutoAttach', {
      autoAttach: true, waitForDebuggerOnStart: true, flatten: true, filter: [{ type: 'iframe' }, { type: 'page' }, { exclude: true }],
    }, sid);
  }

  private async attachChildDocument(conn: CdpConnection, tab: Tab, event: { sessionId: string; targetInfo: { targetId: string; type: string }; waitingForDebugger: boolean }) {
    if (event.targetInfo.type !== 'iframe') {
      await conn.send('Target.closeTarget', { targetId: event.targetInfo.targetId }).catch(() => undefined);
      return;
    }
    this.documents.set(event.sessionId, tab);
    try {
      await this.enableDocumentChecks(conn, event.sessionId);
      if (event.waitingForDebugger) await conn.send('Runtime.runIfWaitingForDebugger', {}, event.sessionId);
    } catch {
      this.forgetTab(tab);
      await conn.send('Target.closeTarget', { targetId: tab.targetId }).catch(() => undefined);
    }
  }

  private async checkDocumentRequest(conn: CdpConnection, sid: string, request: { requestId: string; request: { url: string }; frameId: string }) {
    const tab = this.documents.get(sid);
    if (!tab) return;
    try {
      this.permissions.require(tab.owner, request.request.url, 'browse');
    } catch (error) {
      if (sid === tab.cdpSession && (!tab.mainFrame || request.frameId === tab.mainFrame)) {
        tab.blocked = error as Error;
        this.invalidateDocument(tab);
      }
      await conn.send('Fetch.failRequest', { requestId: request.requestId, errorReason: 'BlockedByClient' }, sid).catch(() => undefined);
      return;
    }
    await conn.send('Fetch.continueRequest', { requestId: request.requestId }, sid).catch(() => undefined);
  }

  private async profileEndpoint(portFile: string): Promise<string> {
    const info = lstatSync(portFile);
    if (!info.isFile() || info.size > 1024) throw new Error('Invalid managed browser endpoint file.');
    const [port, path] = readFileSync(portFile, 'utf8').trimEnd().split('\n');
    if (!/^\d{1,5}$/.test(port) || !/^\/devtools\/browser\/[\w-]+$/.test(path)) {
      throw new Error('Invalid managed browser endpoint.');
    }
    const httpBase = `http://127.0.0.1:${port}`;
    const endpoint = new URL(await browserWsUrl(httpBase));
    if (endpoint.hostname !== '127.0.0.1' || endpoint.port !== port || endpoint.pathname !== path) {
      throw new Error('Managed browser endpoint does not match its profile.');
    }
    return httpBase;
  }

  private async startLocal(c: BrowserConfig): Promise<string> {
    const chrome = findChrome(c.chromePath);
    if (!chrome) throw new Error('No Chrome, Chromium, Edge or Brave found. Install one, set browser.chromePath, or use browser.mode "docker".');
    const profile = ensureDir(homePath('browser', 'profiles', c.profile.replace(/[^\w.-]/g, '_')));
    const portFile = join(profile, 'DevToolsActivePort');
    // Reuse only the DevTools browser identity recorded by Chromium in this profile.
    if (existsSync(portFile)) {
      try { return await this.profileEndpoint(portFile); }
      catch { rmSync(portFile, { force: true }); }
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
        try { return await this.profileEndpoint(portFile); }
        catch {
          // Startup is still in progress.
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    await this.stopLaunched();
    throw new Error(`Chrome did not open a DevTools port (${chrome}).`);
  }

  /** Stops the Chromium this manager spawned: SIGTERM, up to 5 s to exit, then SIGKILL. */
  private async stopLaunched(): Promise<void> {
    const proc = this.proc;
    this.proc = undefined;
    if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
    const exited = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    proc.kill();
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 5000); })]);
    clearTimeout(timer);
    if (proc.exitCode === null && proc.signalCode === null) {
      proc.kill('SIGKILL');
      await exited;
    }
  }

  private ownedDockerContainer(name: string, profile: string) {
    const inspection = spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8', timeout: 10_000 });
    if (inspection.error) throw inspection.error;
    if (inspection.status !== 0 && !inspection.stderr.includes('No such container')) {
      throw new Error('Could not inspect the managed browser container.');
    }
    const existing = inspection.status === 0 ? JSON.parse(inspection.stdout)[0] as {
      State: { Running: boolean };
      Config: { Labels?: Record<string, string> };
      Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
    } : undefined;
    if (existing && (existing.Config.Labels?.['sun-harness'] !== 'browser' ||
      !existing.Mounts.some(mount => mount.Type === 'bind' && mount.Source === profile && mount.Destination === '/profile' && mount.RW))) {
      throw new Error('Browser container name is already in use by a different profile owner.');
    }
    return existing;
  }

  stopDockerProfile(): boolean {
    const name = this.cfg().profile.replace(/[^\w.-]/g, '_');
    if (!name || name === '.' || name === '..') throw new Error('Invalid browser profile name.');
    const path = homePath('browser', 'docker-profiles', name);
    if (!existsSync(path)) return false;
    const container = `sun-browser-${name}`;
    if (!this.ownedDockerContainer(container, realpathSync(path))) return false;
    if (spawnSync('docker', ['rm', '-f', container], { timeout: 10_000 }).status !== 0) {
      throw new Error('Could not stop the managed browser container.');
    }
    return true;
  }

  private async startDocker(c: BrowserConfig): Promise<string> {
    const name = `sun-browser-${c.profile.replace(/[^\w.-]/g, '_')}`;
    const profile = realpathSync(ensureDir(homePath('browser', 'docker-profiles', c.profile.replace(/[^\w.-]/g, '_'))));
    const existing = this.ownedDockerContainer(name, profile);
    if (!existing?.State.Running) {
      if (existing && spawnSync('docker', ['rm', name], { timeout: 10_000 }).status !== 0) {
        throw new Error('Could not replace the stopped managed browser container.');
      }
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
  /** Open a separate, user-operated sign-in window in the local Docker browser. */
  async openManualLogin(url: string): Promise<void> {
    if (this.cfg().mode !== 'docker') throw new Error('Manual login requires a locally managed Docker browser.');
    const conn = await this.connection();
    await conn.send('Target.createTarget', { url, newWindow: true });
  }

  private async tab(sessionId: string): Promise<{ conn: CdpConnection; t: Tab }> {
    const conn = await this.connection();
    const tab = this.tabs.get(sessionId);
    const pending = this.opening.get(sessionId);
    if (pending) return pending;
    if (tab) return { conn, t: tab };
    const opening = this.openTab(conn, sessionId).finally(() => {
      if (this.opening.get(sessionId) === opening) this.opening.delete(sessionId);
    });
    this.opening.set(sessionId, opening);
    return opening;
  }

  private async openTab(conn: CdpConnection, sessionId: string): Promise<{ conn: CdpConnection; t: Tab }> {
      // A window per session: background tabs of a shared window do not paint, so they could not be streamed.
      const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank', newWindow: true });
      if ([...this.tabs.values()].some(tab => tab.targetId === targetId)) throw new Error('BROWSER_TAB_OWNED');
      try {
        const { sessionId: cdpSession } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
        const t: Tab = { owner: sessionId, targetId, cdpSession, generation: randomUUID(), lease: 0, document: 0, snapshot: 0,
          needsSnapshot: false, lastFrameAt: 0, refs: new Map(), inflight: 0, lastNetwork: 0, url: 'about:blank', title: '', screencast: false, viewers: new Set(), stream: Promise.resolve() };
        this.tabs.set(sessionId, t);
        this.documents.set(cdpSession, t);
        const vp = this.cfg().viewport;
        await Promise.all([
          this.enableDocumentChecks(conn, cdpSession),
          conn.send('Page.enable', {}, cdpSession),
          conn.send('Network.enable', {}, cdpSession),
          conn.send('DOM.enable', {}, cdpSession),
          conn.send('Accessibility.enable', {}, cdpSession),
          conn.send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: false }, cdpSession),
        ]);
        const { frameTree } = await conn.send('Page.getFrameTree', {}, cdpSession);
        t.mainFrame = frameTree.frame.id;
        if (this.tabs.get(sessionId) !== t) throw new Error('BROWSER_TAB_STALE');
        return { conn, t };
    } catch (error) {
      const tab = this.tabs.get(sessionId);
      if (tab && tab.targetId === targetId) this.forgetTab(tab);
      await conn.send('Target.closeTarget', { targetId }).catch(() => undefined);
      throw error;
    }
  }

  hasTab(sessionId: string): boolean {
    return this.tabs.has(sessionId);
  }

  /** Wait until the page has loaded and the network has been quiet for a moment (bounded). */
  private async settle(conn: TabChannel, t: Tab, maxMs = 8000): Promise<void> {
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

  private currentControl(t: Tab): BrowserControl | undefined {
    if (t.control && t.control.expires <= Date.now()) this.releaseControl(t);
    return t.control;
  }

  private requireCurrent(t: Tab): void {
    if (t.blocked) throw t.blocked;
    if (t.url !== 'about:blank') this.permissions.require(t.owner, t.url, 'browse');
  }

  private channel(conn: CdpConnection, check: (method: string) => void): TabChannel {
    return {
      send<T>(method: string, params?: Record<string, unknown>, sid?: string, timeoutMs?: number) {
        check(method);
        return conn.send<T>(method, params, sid, timeoutMs);
      },
      waitFor: conn.waitFor.bind(conn),
      check: () => check(''),
    };
  }

  private async act<T>(sessionId: string, signal: AbortSignal | undefined, fn: (conn: TabChannel, t: Tab) => Promise<T>,
    operation: AgentOperation = 'write', ref?: string): Promise<T> {
    if (signal?.aborted) throw new Error('BROWSER_ABORTED');
    const existing = this.tabs.get(sessionId);
    if (existing && this.currentControl(existing)) throw new Error('BROWSER_TAKEOVER: The user is controlling this tab.');
    if (ref !== undefined && !existing?.refs.has(ref)) throw new Error('BROWSER_STALE_REF: Take a new browser snapshot.');
    const priorLease = existing?.lease;
    const { conn, t } = await this.tab(sessionId);
    const lease = priorLease ?? t.lease;
    const checkLease = () => {
      if (signal?.aborted) throw new Error('BROWSER_ABORTED');
      if (this.tabs.get(sessionId) !== t || (existing && existing !== t)) throw new Error('BROWSER_TAB_STALE');
      if (this.currentControl(t) || lease !== t.lease) throw new Error('BROWSER_TAKEOVER: The browser control lease changed.');
    };
    checkLease();
    if (operation !== 'observe' && t.needsSnapshot) throw new Error('BROWSER_SNAPSHOT_REQUIRED: Take a fresh snapshot after handback.');
    const document = t.document;
    const channel = this.channel(conn, method => {
      checkLease();
      if (method !== 'Page.navigate' && !(operation === 'observe' && t.blocked && method === '')) this.requireCurrent(t);
      const usesObservedDocument = method.startsWith('DOM.') || method.startsWith('Input.')
        || method === 'Runtime.callFunctionOn' || method === 'Page.navigateToHistoryEntry';
      if (usesObservedDocument && (t.document !== document || (ref !== undefined && !t.refs.has(ref)))) {
        throw new Error('BROWSER_STALE_REF: Take a new browser snapshot.');
      }
    });
    const value = await fn(channel, t);
    checkLease();
    if (operation !== 'observe' || !t.blocked) this.requireCurrent(t);
    return value;
  }

  private uploadTarget(t: Tab): BrowserUploadTarget {
    if (!t.mainFrame || t.url === 'about:blank') throw new Error('BROWSER_UPLOAD_TARGET_UNAVAILABLE');
    if (this.currentControl(t)) throw new Error('BROWSER_TAKEOVER');
    this.requireCurrent(t);
    return {
      origin: browserOrigin(t.url), generation: t.generation, document: t.document, lease: t.lease,
      permissionRevision: this.permissions.snapshot().revision, maxBytes: BROWSER_UPLOAD_MAX_BYTES,
    };
  }

  previewUpload(sessionId: string): BrowserUploadTarget {
    const t = this.tabs.get(sessionId);
    if (!t || this.opening.has(sessionId)) throw new Error('BROWSER_UPLOAD_TARGET_UNAVAILABLE');
    return this.uploadTarget(t);
  }

  approveUpload(sessionId: string, request: BrowserUploadRequest): BrowserUploadApproval {
    const target = this.previewUpload(sessionId);
    if (!sameUploadTarget(target, request?.target)) throw new Error('BROWSER_UPLOAD_TARGET_STALE');
    this.permissions.require(sessionId, target.origin, 'upload');
    return this.uploads.approve(sessionId, target, request);
  }

  listUploads(sessionId: string): BrowserUploadApproval[] {
    const t = this.tabs.get(sessionId);
    if (!t || t.url === 'about:blank' || this.currentControl(t)) return [];
    const target = this.uploadTarget(t);
    if (this.permissions.decision(target.origin, 'upload') !== 'allow') {
      this.uploads.clear(sessionId);
      return [];
    }
    return this.uploads.list(sessionId, target);
  }

  async upload(sessionId: string, ref: string, handle: string, signal?: AbortSignal): Promise<string> {
    return this.act(sessionId, signal, async (conn, t) => {
      const target = this.uploadTarget(t);
      this.permissions.require(sessionId, target.origin, 'upload');
      if (!this.uploads.list(sessionId, target).some(approval => approval.handle === handle)) {
        throw new Error('BROWSER_UPLOAD_HANDLE_INVALID');
      }
      const backendNodeId = this.node(t, ref);
      const { executionContextId } = await conn.send('Page.createIsolatedWorld', {
        frameId: t.mainFrame, worldName: 'sun-browser-upload',
      }, t.cdpSession);
      const objectGroup = `sun-upload-${randomUUID()}`;
      const { object } = await conn.send('DOM.resolveNode', {
        backendNodeId, executionContextId, objectGroup,
      }, t.cdpSession);
      try {
        if (!sameUploadTarget(target, this.uploadTarget(t))) throw new Error('BROWSER_UPLOAD_TARGET_STALE');
        this.permissions.require(sessionId, target.origin, 'upload');
        const { name, data } = this.uploads.consume(sessionId, target, handle);
        const result = await conn.send('Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: `function(origin, name, data) {
            const input = this instanceof HTMLInputElement ? this : this.getRootNode().host;
            if (!(input instanceof HTMLInputElement) || input.ownerDocument !== document || !input.isConnected
              || input.matches(':disabled') || input.type !== 'file' || location.origin !== origin) return false;
            const file = new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], name);
            const transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }`,
          arguments: [{ value: target.origin }, { value: name }, { value: data }],
          returnByValue: true,
        }, t.cdpSession, 5000);
        if (result.exceptionDetails || result.result?.value !== true) throw new Error('BROWSER_UPLOAD_INPUT_INVALID');
        return `Selected the approved file ${JSON.stringify(name)} in ${ref}.`;
      } finally {
        await conn.send('Runtime.releaseObjectGroup', { objectGroup }, t.cdpSession, 2000).catch(() => undefined);
      }
    }, 'write', ref);
  }

  async download(sessionId: string, url: string, signal?: AbortSignal): Promise<BrowserDownloadResult> {
    browserOrigin(url);
    if (!this.hasTab(sessionId)) throw new Error('BROWSER_DOWNLOAD_TARGET_UNAVAILABLE');
    return this.act(sessionId, signal, async (conn, t) => {
      if (t.url === 'about:blank') throw new Error('BROWSER_DOWNLOAD_TARGET_UNAVAILABLE');
      const document = t.document;
      const origin = browserOrigin(t.url);
      const revision = this.permissions.snapshot().revision;
      const origins = new Set<string>([origin]);
      const guard = (requestUrl?: string) => {
        conn.check();
        if (t.document !== document || browserOrigin(t.url) !== origin) throw new Error('BROWSER_DOWNLOAD_DOCUMENT_CHANGED');
        if (requestUrl !== undefined) origins.add(browserOrigin(requestUrl));
        for (const site of origins) this.permissions.require(sessionId, site, 'download');
        if (this.permissions.snapshot().revision !== revision) throw new Error('BROWSER_DOWNLOAD_PERMISSION_CHANGED');
      };
      return this.downloads.run(this.conn!, sessionId, url, guard);
    });
  }

  async navigate(sessionId: string, url: string, signal?: AbortSignal): Promise<string> {
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url)) url = `https://${url}`;
    if (url !== 'about:blank') this.permissions.require(sessionId, url, 'browse');
    return this.act(sessionId, signal, async (conn, t) => {
      t.blocked = undefined;
      this.invalidateDocument(t);
      const loaded = conn.waitFor('Page.loadEventFired', t.cdpSession, 8000);
      // Preflight and request interception are separate checks, including each redirect.
      if (url !== 'about:blank') this.permissions.require(sessionId, url, 'browse');
      const r = await conn.send('Page.navigate', { url }, t.cdpSession);
      if (t.blocked) throw t.blocked;
      if (r.errorText) throw new Error(`Navigation failed: ${r.errorText}`);
      await loaded;
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    }, 'navigate');
  }

  async snapshot(sessionId: string, signal?: AbortSignal): Promise<string> {
    return this.act(sessionId, signal, (conn, t) => this.snapshotOf(conn, t), 'observe');
  }

  private async snapshotOf(conn: TabChannel, t: Tab): Promise<string> {
    conn.check();
    if (t.blocked) {
      t.refs.clear();
      t.needsSnapshot = false;
      return `Browser document blocked. ${t.blocked.message}`;
    }
    const document = t.document;
    const { result } = await conn.send('Runtime.evaluate', { expression: 'location.href + "\\n" + document.title', returnByValue: true }, t.cdpSession);
    const [href, title] = String(result?.value ?? '\n').split('\n');
    if (href !== 'about:blank') this.permissions.require(t.owner, href, 'browse');
    const { nodes } = await conn.send('Accessibility.getFullAXTree', {}, t.cdpSession);
    conn.check();
    if (t.document !== document) throw new Error('BROWSER_STALE_REF: The page changed while taking a snapshot.');
    const { text, refs } = renderAxTree(nodes, 14_000, `e${t.generation.replaceAll('-', '')}_${++t.snapshot}_`);
    t.refs = refs;
    t.needsSnapshot = false;
    t.url = href;
    t.title = title;
    return `URL: ${href}\nTitle: ${title}\n\n${text || '(empty page)'}`;
  }

  private node(t: Tab, ref: string): number {
    const id = t.refs.get(ref);
    if (!id) throw new Error(`Unknown ref ${ref}. Take a new browser_snapshot; refs change when the page changes.`);
    return id;
  }

  private async center(conn: TabChannel, t: Tab, backendNodeId: number): Promise<{ x: number; y: number }> {
    await conn.send('DOM.scrollIntoViewIfNeeded', { backendNodeId }, t.cdpSession).catch(() => undefined);
    const { model } = await conn.send('DOM.getBoxModel', { backendNodeId }, t.cdpSession);
    const q: number[] = model.content;
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }

  private async mouseClick(conn: TabChannel, t: Tab, x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, t.cdpSession);
    await conn.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: 1 }, t.cdpSession);
    await conn.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: 1 }, t.cdpSession);
  }

  private async key(conn: TabChannel, t: Tab, key: string): Promise<void> {
    const parts = key.split('+');
    const main = parts.pop()!;
    const mods = parts.reduce((m, p) => m | ({ Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 }[p] ?? 0), 0);
    const k = KEYS[main] ?? { code: main.length === 1 ? `Key${main.toUpperCase()}` : main, keyCode: main.length === 1 ? main.toUpperCase().charCodeAt(0) : 0, text: main.length === 1 ? main : undefined };
    const base = { key: main === 'Space' ? ' ' : main, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: mods };
    await conn.send('Input.dispatchKeyEvent', { type: k.text && !mods ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text && !mods ? { text: k.text } : {}) }, t.cdpSession);
    await conn.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, t.cdpSession);
  }

  async click(sessionId: string, ref: string, signal?: AbortSignal): Promise<string> {
    const value = await this.act(sessionId, signal, async (conn, t) => {
      const { x, y } = await this.center(conn, t, this.node(t, ref));
      await this.mouseClick(conn, t, x, y);
      await new Promise((r) => setTimeout(r, 300));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    }, 'write', ref);
    return `Clicked ${ref}.\n${value}`;
  }

  async type(sessionId: string, ref: string, text: string, opts: { submit?: boolean; clear?: boolean } = {}, signal?: AbortSignal): Promise<string> {
    const value = await this.act(sessionId, signal, async (conn, t) => {
      const backendNodeId = this.node(t, ref);
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
    }, 'write', ref);
    return `Typed into ${ref}${opts.submit ? ' and pressed Enter' : ''}.\n${value}`;
  }

  async press(sessionId: string, key: string, signal?: AbortSignal): Promise<string> {
    const value = await this.act(sessionId, signal, async (conn, t) => {
      await this.key(conn, t, key);
      await new Promise((r) => setTimeout(r, 200));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
    return `Pressed ${key}.\n${value}`;
  }

  async scroll(sessionId: string, direction: 'up' | 'down', amount = 600, signal?: AbortSignal): Promise<string> {
    return this.act(sessionId, signal, async (conn, t) => {
      const vp = this.cfg().viewport;
      await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: vp.width / 2, y: vp.height / 2, deltaX: 0, deltaY: direction === 'up' ? -amount : amount }, t.cdpSession);
      await new Promise((r) => setTimeout(r, 400));
      return this.snapshotOf(conn, t);
    });
  }

  async back(sessionId: string, signal?: AbortSignal): Promise<string> {
    return this.act(sessionId, signal, async (conn, t) => {
      const { currentIndex, entries } = await conn.send('Page.getNavigationHistory', {}, t.cdpSession);
      const target = entries[currentIndex - 1];
      if (!target) return this.snapshotOf(conn, t);
      if (target.url !== 'about:blank') this.permissions.require(sessionId, target.url, 'browse');
      await conn.send('Page.navigateToHistoryEntry', { entryId: target.id }, t.cdpSession);
      await new Promise((r) => setTimeout(r, 500));
      await this.settle(conn, t);
      return this.snapshotOf(conn, t);
    });
  }

  async screenshot(sessionId: string, file: string, fullPage = false, signal?: AbortSignal): Promise<string> {
    const data = await this.act(sessionId, signal, async (conn, t) => {
      const result = await conn.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage }, t.cdpSession);
      return result.data as string;
    });
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
    return file;
  }

  async evaluate(sessionId: string, expression: string, signal?: AbortSignal): Promise<string> {
    const value = await this.act(sessionId, signal, async (conn, t) => {
      const r = await conn.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, t.cdpSession);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2) ?? String(r.result.description ?? r.result.type);
    });
    return value.length > 20_000 ? value.slice(0, 20_000) + '\n… (truncated)' : value;
  }

  // ---------- live view and takeover ----------

  private publishFrame(sessionId: string, t: Tab, data: string, width: number, height: number, force = false): void {
    if (this.tabs.get(sessionId) !== t || !t.screencast) return;
    try { this.requireCurrent(t); }
    catch { t.frameId = undefined; return; }
    const now = Date.now();
    if (!force && now - t.lastFrameAt < 250) return;
    t.lastFrameAt = now;
    t.frameId = ++this.nextFrame;
    this.onFrame({ sessionId, data, width, height, url: t.url, title: t.title, generation: t.generation, frameId: t.frameId });
  }

  async setScreencast(sessionId: string, on: boolean, viewer = 'default'): Promise<void> {
    if (!on && !this.tabs.has(sessionId)) return;
    const { conn, t } = await this.tab(sessionId);
    if (on) t.viewers.add(viewer);
    else t.viewers.delete(viewer);
    const stream = t.stream.then(() => this.updateScreencast(conn, t, on && t.viewers.has(viewer)));
    t.stream = stream.catch(() => undefined);
    await stream;
  }

  private async updateScreencast(conn: CdpConnection, t: Tab, refresh: boolean): Promise<void> {
    if (this.tabs.get(t.owner) !== t) return;
    if (!t.viewers.size) {
      if (!t.screencast) return;
      t.screencast = false;
      t.frameId = undefined;
      await conn.send('Page.stopScreencast', {}, t.cdpSession).catch(() => undefined);
      return;
    }
    if (t.screencast && !refresh) return;
    this.requireCurrent(t);
    const vp = this.cfg().viewport;
    if (!t.screencast) {
      t.screencast = true;
      try {
        await conn.send('Page.bringToFront', {}, t.cdpSession);
        await conn.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: vp.width, maxHeight: vp.height, everyNthFrame: 2 }, t.cdpSession);
      } catch (error) {
        t.screencast = false;
        throw error;
      }
    }
    // Chrome only sends frames on repaint. Capture the current static page for new viewers.
    const document = t.document;
    const { data } = await conn.send('Page.captureScreenshot', { format: 'jpeg', quality: 60 }, t.cdpSession);
    if (t.document === document) this.publishFrame(t.owner, t, data, vp.width, vp.height, true);
  }

  isTakenOver(sessionId: string): boolean {
    const t = this.tabs.get(sessionId);
    return !!t && !!this.currentControl(t);
  }

  private releaseControl(t: Tab): void {
    this.uploads.clear(t.owner);
    t.control = undefined;
    t.lease++;
    t.refs.clear();
    t.needsSnapshot = true;
  }

  private requireFrame(t: Tab, frame?: BrowserFrameRef): void {
    if (!frame || t.frameId === undefined || frame.generation !== t.generation || frame.frameId !== t.frameId) {
      throw new Error('BROWSER_FRAME_STALE: Wait for the current browser frame.');
    }
  }

  private requireControl(t: Tab, control?: BrowserControl): void {
    const current = this.currentControl(t);
    if (!current || !control || current.generation !== control.generation || current.token !== control.token) {
      throw new Error('BROWSER_CONTROL_STALE: Take over the current browser frame.');
    }
  }

  setTakeover(sessionId: string, on: boolean, frame?: BrowserFrameRef, control?: BrowserControl): BrowserControl | undefined {
    const t = this.tabs.get(sessionId);
    if (!t) throw new Error('BROWSER_TAB_STALE');
    if (!on) {
      this.requireControl(t, control);
      this.releaseControl(t);
      return;
    }
    if (this.currentControl(t)) throw new Error('BROWSER_TAKEOVER_OWNED: The tab already has a controller.');
    this.requireFrame(t, frame);
    this.requireCurrent(t);
    const lease = { generation: t.generation, token: randomUUID() };
    this.releaseControl(t);
    t.control = { ...lease, expires: Date.now() + 5 * 60_000 };
    return lease;
  }

  async input(sessionId: string, ev: BrowserInput, frame: BrowserFrameRef, control: BrowserControl): Promise<void> {
    const t = this.tabs.get(sessionId);
    if (!t || !this.conn || this.conn.isClosed) throw new Error('BROWSER_TAB_STALE');
    this.requireControl(t, control);
    this.requireFrame(t, frame);
    const document = t.document;
    const conn = this.channel(this.conn, () => {
      if (this.tabs.get(sessionId) !== t || t.document !== document) throw new Error('BROWSER_FRAME_STALE');
      this.requireControl(t, control);
      this.requireCurrent(t);
    });
    if (ev.type === 'click') await this.mouseClick(conn, t, ev.x, ev.y, ev.button);
    else if (ev.type === 'move') await conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: ev.x, y: ev.y }, t.cdpSession);
    else if (ev.type === 'wheel') await conn.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.deltaX, deltaY: ev.deltaY }, t.cdpSession);
    else if (ev.type === 'key') await this.key(conn, t, ev.key);
    else if (ev.type === 'text') await conn.send('Input.insertText', { text: ev.text }, t.cdpSession);
    if (t.control?.token === control.token) t.control.expires = Date.now() + 5 * 60_000;
  }

  async closeTab(sessionId: string): Promise<void> {
    await this.opening.get(sessionId)?.catch(() => undefined);
    const t = this.tabs.get(sessionId);
    if (!t) return;
    this.forgetTab(t);
    if (this.conn && !this.conn.isClosed) await this.conn.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined);
  }

  async dispose(): Promise<void> {
    this.disposing = true;
    await this.connecting?.catch(() => undefined);
    for (const id of new Set([...this.tabs.keys(), ...this.opening.keys()])) await this.closeTab(id);
    const connection = this.conn;
    // Chromium keeps writing to the profile until it exits; release the profile only afterwards.
    await this.stopLaunched();
    if (this.container) {
      spawnSync('docker', ['stop', '-t', '2', this.container]);
      this.container = undefined;
    }
    await connection?.closeAndWait();
    if (!connection || connection.isClosed) {
      this.releaseProfile?.();
      this.releaseProfile = undefined;
    }
  }
}
