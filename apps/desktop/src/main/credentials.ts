import { randomUUID } from 'node:crypto';
import { BrowserWindow, WebContentsView, safeStorage, session, type WebPreferences } from 'electron';
import { CredentialBroker, credentialOrigin, type CredentialReference } from '@sun/core';
import type { PrivateSignInStatus } from '../shared/credentials';

const controlsHeight = 148;
const privateWorld = 1001;

function matchesOrigin(url: string, origin: string): boolean {
  try { return credentialOrigin(url) === origin; }
  catch { return false; }
}

function placePassword(origin: string, url: string, marker: string, password: string, expires: number): boolean {
  const documentMarker = (globalThis as typeof globalThis & { sunCredentialDocument?: string }).sunCredentialDocument;
  if (Date.now() >= expires || window !== window.top || location.origin !== origin || location.href !== url || documentMarker !== marker) return false;
  const fields = [...document.querySelectorAll<HTMLInputElement>('input[type=password]')].filter(input => {
    const box = input.getBoundingClientRect();
    return !input.matches(':disabled') && !input.readOnly && input.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
      && box.width > 0 && box.height > 0 && box.bottom > 0 && box.right > 0 && box.top < innerHeight && box.left < innerWidth;
  });
  if (fields.length !== 1) return false;
  const input = fields[0];
  const form = input.form;
  if (form && (form.method !== 'post' || new URL(form.action).origin !== origin)) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) return false;
  setter.call(input, password);
  input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

interface PrivateWindow {
  window: BrowserWindow;
  site: WebContentsView;
  credential: CredentialReference;
  language: 'en' | 'zh-CN' | 'system';
  navigation: number;
  grant?: string;
  filling: boolean;
}

export class DesktopCredentials {
  constructor(private readonly onPrivateWindow: () => void = () => undefined) {}
  readonly supported = process.platform === 'darwin';
  readonly broker = new CredentialBroker({
    available: () => this.supported ? safeStorage.isAsyncEncryptionAvailable() : Promise.resolve(false),
    seal: value => safeStorage.encryptStringAsync(value),
    open: async bytes => (await safeStorage.decryptStringAsync(bytes)).result,
  });
  private privateWindow?: PrivateWindow;
  private captureRevision = 0;

  captureGuard = () => ({ active: !!this.privateWindow, revision: this.captureRevision });

  isControls(contents: Electron.WebContents): boolean {
    return contents === this.privateWindow?.window.webContents;
  }

  status(): PrivateSignInStatus {
    const current = this.privateWindow;
    if (!current) throw new Error('CREDENTIAL_WINDOW_UNAVAILABLE');
    const { credential: { origin, label }, language } = current;
    return { origin, label, language };
  }

  async open(id: string, revision: string, url: string, language: PrivateWindow['language'],
    options: { preferences: WebPreferences; title: string; load(window: BrowserWindow): void }): Promise<void> {
    if (!this.supported || !await this.broker.available()) throw new Error('CREDENTIAL_VAULT_UNAVAILABLE');
    if (this.privateWindow) throw new Error('CREDENTIAL_WINDOW_ALREADY_OPEN');
    const credential = this.broker.list().find(item => item.id === id && item.revision === revision);
    if (!credential || !matchesOrigin(url, credential.origin)) throw new Error('CREDENTIAL_GRANT_INVALID');
    const { origin } = credential;
    const partition = session.fromPartition(`sun-credential-${randomUUID()}`, { cache: false });
    partition.setPermissionRequestHandler((_web, _permission, callback) => callback(false));
    partition.setPermissionCheckHandler(() => false);
    partition.setDisplayMediaRequestHandler((_request, callback) => callback(null));
    partition.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !matchesOrigin(request.url, origin) }));
    partition.on('will-download', event => event.preventDefault());

    const window = new BrowserWindow({
      title: options.title, width: 900, height: 720, minWidth: 600, minHeight: 460, show: false,
      webPreferences: { ...options.preferences, devTools: false },
    });
    const site = new WebContentsView({ webPreferences: {
      session: partition, contextIsolation: true, sandbox: true, nodeIntegration: false, devTools: false, spellcheck: false,
    } });
    const current: PrivateWindow = { window, site, credential, language, navigation: 0, filling: false };
    this.privateWindow = current;
    this.captureRevision++;
    this.onPrivateWindow();
    window.setContentProtection(true);
    window.contentView.addChildView(site);
    const layout = () => {
      const [width, height] = window.getContentSize();
      site.setBounds({ x: 0, y: controlsHeight, width, height: height - controlsHeight });
    };
    layout();
    window.on('resize', layout);
    window.on('page-title-updated', event => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', event => event.preventDefault());

    const contents = site.webContents;
    const checkNavigation = (event: Electron.Event & { url: string }) => {
      if (!matchesOrigin(event.url, origin)) event.preventDefault();
    };
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-frame-navigate', checkNavigation);
    contents.on('will-redirect', checkNavigation);
    contents.on('did-start-navigation', event => { if (event.isMainFrame) this.invalidate(current); });
    contents.on('render-process-gone', () => { if (this.privateWindow === current) this.close(); });
    window.once('closed', () => {
      this.invalidate(current);
      if (!contents.isDestroyed()) contents.close({ waitForBeforeUnload: false });
      if (this.privateWindow === current) this.privateWindow = undefined;
      this.captureRevision++;
      void partition.clearStorageData().catch(() => undefined);
    });
    window.once('ready-to-show', () => window.show());
    options.load(window);
    void contents.loadURL(url).catch(() => undefined);
  }

  private invalidate(current: PrivateWindow): void {
    current.navigation++;
    if (current.grant) this.broker.revoke(current.grant);
    current.grant = undefined;
  }

  close(): void {
    const current = this.privateWindow;
    if (!current) return;
    this.invalidate(current);
    current.window.destroy();
  }

  closeAfterReply(): void {
    const current = this.privateWindow;
    setImmediate(() => { if (this.privateWindow === current) this.close(); });
  }

  async fill(): Promise<'filled' | 'field-unavailable'> {
    const current = this.privateWindow;
    if (!current || current.filling) return 'field-unavailable';
    const { site: { webContents }, navigation, credential: { id, revision, origin } } = current;
    const url = webContents.getURL();
    const matchesDocument = () => this.privateWindow === current && current.navigation === navigation
      && !webContents.isDestroyed() && !webContents.isLoadingMainFrame() && webContents.getURL() === url && matchesOrigin(url, origin);
    if (!matchesDocument()) return 'field-unavailable';
    const marker = randomUUID();
    current.filling = true;
    try {
      const marked = await webContents.executeJavaScriptInIsolatedWorld(privateWorld, [{
        code: `location.href === ${JSON.stringify(url)} && !!(globalThis.sunCredentialDocument = ${JSON.stringify(marker)})`,
      }]);
      if (!marked || !matchesDocument()) return 'field-unavailable';
      const grant = this.broker.grant(id, revision, origin, marker);
      current.grant = grant;
      return await this.broker.fill(grant, { origin, document: marker }, async (password, expires) => {
        if (!matchesDocument()) return 'field-unavailable';
        const args = [origin, url, marker, password, expires].map(value => JSON.stringify(value));
        const filled = await webContents.executeJavaScriptInIsolatedWorld(privateWorld, [{ code: `(${placePassword})(${args.join(',')})` }]);
        return filled === true ? 'filled' : 'field-unavailable';
      });
    } catch (error) {
      if (error instanceof Error && /^CREDENTIAL_(GRANT_INVALID|VAULT_UNAVAILABLE)$/.test(error.message)) throw error;
      return 'field-unavailable';
    } finally {
      current.grant = undefined;
      current.filling = false;
    }
  }
}
