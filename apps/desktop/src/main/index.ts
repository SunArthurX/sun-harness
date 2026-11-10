import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, session, shell, systemPreferences } from 'electron';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import {
  BUNDLE_MAX_COMPRESSED_BYTES, DEFAULT_SHORTCUTS, GatewayClient, HarnessHost, SettingsConfigError, SETTINGS_PROTOCOL_VERSION, augmentPath, findGateway, hostMethods,
  clearDesktopRemote, getRemote, importCredentialEnv, isGatewayRead, isShortcut, loadRemotes, nativeCapability, readSettings, remoteEndpoint, removeRemote,
  requireSettingsProtocol, shortcutIssues, shortcutSignature, storeRemote, sunHome, writeSettings,
  type CapabilityStatus, type CredentialInput, type CredentialReference, type GatewayConnection, type GatewayStatus, type LiveEvent, type PendingApproval, type RemoteEntry,
  type SessionImportOptions, type SessionSummary, type SettingsPatch, type SettingsSnapshot, type SettingsWriteResult, type UiPreferences,
} from '@sun/core';
import { activeMiniSession, type MiniSnapshot } from '../shared/mini';
import { API_METHODS } from '../shared/api';
import { GlobalShortcutBinding } from './shortcuts';
import { macAppshots } from './capture';
import { macComputer } from './computer';
import { ConnectionReview } from './connections';
import { DesktopCredentials } from './credentials';
import type { ConfirmConnection, DesktopConnections } from '../shared/connections';
import { zhCN } from '../renderer/src/locale-zh-CN';

// GUI apps on macOS do not inherit the login shell env; pick up API keys from ~/.sun/.env and shell rc files.
if (!process.env.SUN_SKIP_SHELL_ENV) importCredentialEnv();
augmentPath();

const here = dirname(fileURLToPath(import.meta.url));

type Handler = (...args: any[]) => unknown;

let win: BrowserWindow | null = null;
let miniWindow: BrowserWindow | null = null;
let pendingMiniSession: string | undefined;
let miniEnabled = false;

const miniMethods = new Set(['getMiniSnapshot', 'stopMiniRun', 'openMiniSession']);
const credentialMethods = new Set(['listDesktopCredentials', 'saveDesktopCredential', 'deleteDesktopCredential', 'openDesktopCredentialSignIn']);
const privateSignInMethods = new Set(['privateSignInStatus', 'fillPrivateSignIn', 'closePrivateSignIn']);
const computerMethods = new Set(['inspectComputerUse', 'grantComputerUse', 'beginComputerUse', 'stopComputerUse', 'computerOwner', 'openComputerPermission']);
const desktopMethods = new Set(['showMini', 'takeMiniSession', 'trackAppshotSession', ...miniMethods, 'listDesktopConnections',
  'previewDesktopConnection', 'confirmDesktopConnection', 'selectDesktopConnection', 'removeDesktopConnection', ...credentialMethods, ...privateSignInMethods]);
const credentials = new DesktopCredentials(() => host?.stopComputerUse());
let handlers: Record<string, Handler> = {};
/** Keep a local host alive if it already owns runs when the UI switches away. */
let host: HarnessHost | undefined;
let releaseLive: (() => void) | undefined;
let releaseApprover: (() => void) | undefined;
let rendererEpoch = 0;
let connectionGeneration = 0;
let connectionStatus: GatewayStatus | undefined;
let remoteName: string | undefined;
let switching = false;
const review = new ConnectionReview();

let requestedShortcut = '';
let activeAppshotSession: string | undefined;
let voiceEnabled = true;
let shortcutSync = 0;

const miniShortcut = new GlobalShortcutBinding(globalShortcut, showMini);
const appshotShortcut = new GlobalShortcutBinding(globalShortcut, () => { void captureWithShortcut(); });

async function captureWithShortcut() {
  const owner = host;
  const window = win;
  const sessionId = activeAppshotSession;
  const generation = connectionGeneration;
  if (!owner || connectionStatus || !window || window.isDestroyed() || !sessionId) return;
  try {
    // Select and capture the external foreground window before bringing Sun Harness forward.
    const preview = await owner.captureAppshot(sessionId);
    if (generation !== connectionGeneration || window.isDestroyed() || window !== win) {
      owner.cancelAppshot(sessionId, preview.id);
      return;
    }
    window.show();
    window.focus();
    window.webContents.send('sun:appshot', { sessionId, preview });
  } catch (error) {
    if (generation === connectionGeneration && window === win && !window.isDestroyed()) {
      window.show();
      window.focus();
      window.webContents.send('sun:appshot', { sessionId, error: String(error) });
    }
  }
}

function desktopAccelerator(value: string): string {
  return shortcutSignature(value, process.platform === 'darwin' ? 'mac' : 'other')
    .split('+').map(part => part === 'Meta' ? 'Command' : part === 'Ctrl' ? 'Control' : part).join('+');
}

function miniAccelerator(ui: UiPreferences): string {
  return ui.mini && ui.shortcuts?.mini ? desktopAccelerator(ui.shortcuts.mini) : '';
}

function appshotAccelerator(ui: UiPreferences, capabilities: CapabilityStatus[]): string {
  const available = capabilities.find(item => item.id === 'native.appshots');
  const supported = available?.state === 'available' || available?.reasonCode === 'APPSHOT_DISABLED';
  return !connectionStatus && supported && ui.appshots && ui.shortcuts?.appshot ? desktopAccelerator(ui.shortcuts.appshot) : '';
}

async function syncDesktopPreferences(): Promise<void> {
  const ticket = ++shortcutSync;
  const snapshot = await handlers.getSettings?.(SETTINGS_PROTOCOL_VERSION) as SettingsSnapshot | undefined;
  if (!snapshot || ticket !== shortcutSync) return;
  voiceEnabled = snapshot.values.voice?.enabled !== false;
  applyMiniPreference(snapshot.values.ui.mini);
  requestedShortcut = miniAccelerator(snapshot.values.ui);
  miniShortcut.prepare(requestedShortcut)?.commit();
  appshotShortcut.prepare(appshotAccelerator(snapshot.values.ui, snapshot.capabilities))?.commit();
}

function applyMiniPreference(enabled: boolean) {
  miniEnabled = enabled === true;
  if (!miniEnabled) miniWindow?.close();
}

function desktopCapabilities(capabilities: CapabilityStatus[]): CapabilityStatus[] {
  const mini = nativeCapability('native.mini', 'desktop', { status: () => 'available' });
  const connections = nativeCapability('native.connections', 'desktop', { status: () => 'available' });
  const vault = nativeCapability('native.credentials', 'desktop', { status: () => credentials.supported ? 'available' : 'unavailable' });
  const local = [mini, connections, vault];
  return [...capabilities.filter(capability => !local.some(item => item.id === capability.id)), ...local];
}

function withDesktopCapabilities(snapshot: SettingsSnapshot): SettingsSnapshot {
  return { ...snapshot, capabilities: desktopCapabilities(snapshot.capabilities) };
}

function wrapSettings() {
  const get = handlers.getSettings;
  handlers.getSettings = async (version: unknown) => withDesktopCapabilities(await get(version) as SettingsSnapshot);
  const capabilities = handlers.listCapabilities;
  handlers.listCapabilities = async (version: unknown) => desktopCapabilities(await capabilities(version) as CapabilityStatus[]);

  const update = handlers.updateSettings;
  const persist = async (input: SettingsPatch, version: unknown): Promise<SettingsWriteResult> => {
    const result = await update(input, version) as SettingsWriteResult;
    return result.ok ? { ...result, snapshot: withDesktopCapabilities(result.snapshot) } : result;
  };
  handlers.updateSettings = async (input: SettingsPatch, version: unknown): Promise<SettingsWriteResult> => {
    requireSettingsProtocol(version);
    if (input?.scope !== 'user' || !input.changes) return persist(input, version);
    const changes = input.changes;
    const affectsMini = Object.hasOwn(changes, 'ui.mini') || Object.hasOwn(changes, 'ui.shortcuts.mini');
    const affectsAppshot = Object.hasOwn(changes, 'ui.appshots') || Object.hasOwn(changes, 'ui.shortcuts.appshot');
    if (!affectsMini && !affectsAppshot) return persist(input, version);
    const snapshot = await handlers.getSettings(SETTINGS_PROTOCOL_VERSION) as SettingsSnapshot;
    const mini = Object.hasOwn(changes, 'ui.mini') ? changes['ui.mini'] : snapshot.values.ui.mini;
    const appshots = Object.hasOwn(changes, 'ui.appshots') ? changes['ui.appshots'] : snapshot.values.ui.appshots;
    const shortcuts = { ...DEFAULT_SHORTCUTS, ...snapshot.values.ui.shortcuts };
    for (const key of ['palette', 'newChat', 'mini', 'appshot'] as const) {
      const path = `ui.shortcuts.${key}`;
      if (!Object.hasOwn(changes, path)) continue;
      const proposed = changes[path];
      if (!isShortcut(proposed)) return persist(input, version);
      shortcuts[key] = proposed;
    }
    if ((snapshot.userRevision ?? snapshot.revision) !== input.expectedRevision || typeof mini !== 'boolean'
      || typeof appshots !== 'boolean' || Object.keys(shortcutIssues(shortcuts)).length) return persist(input, version);
    const ui = { ...snapshot.values.ui, mini, appshots, shortcuts };
    const requested = miniAccelerator(ui);
    const stagedMini = affectsMini ? miniShortcut.prepare(requested) : undefined;
    if (affectsMini && !stagedMini) return { ok: false, code: 'INVALID', fields: { 'ui.shortcuts.mini': 'SHORTCUT_UNAVAILABLE' } };
    const stagedAppshot = affectsAppshot ? appshotShortcut.prepare(appshotAccelerator(ui, snapshot.capabilities)) : undefined;
    if (affectsAppshot && !stagedAppshot) {
      stagedMini?.rollback();
      return { ok: false, code: 'INVALID', fields: { 'ui.shortcuts.appshot': 'SHORTCUT_UNAVAILABLE' } };
    }
    try {
      const result = await persist(input, version);
      if (result.ok) {
        stagedMini?.commit();
        stagedAppshot?.commit();
        requestedShortcut = requested;
        applyMiniPreference(result.snapshot.values.ui.mini);
        if (affectsAppshot && !result.snapshot.values.ui.appshots) host?.resetAppshotDraft();
      }
      return result;
    } finally {
      stagedMini?.rollback();
      stagedAppshot?.rollback();
    }
  };
}

const surface: Record<string, Handler> = {
  openComputerPermission: () => {
    if (process.platform !== 'darwin' || connectionStatus) throw new Error('COMPUTER_UNAVAILABLE');
    return shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  },
  pickFolder: async () => {
    if (remoteName) return undefined;
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  },
  openPath: (p: string) => {
    if (!remoteName) return shell.openPath(p);
    clipboard.writeText(p);
    return '';
  },
  openExternal: (url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined),
  /** macOS asks the user once; elsewhere microphone access is decided by the OS. */
  askMicrophone: async () => voiceEnabled && (process.platform !== 'darwin' || await systemPreferences.askForMediaAccess('microphone')),
  microphonePermission: () => {
    if (process.platform !== 'darwin') return undefined;
    const state = systemPreferences.getMediaAccessStatus('microphone');
    return state === 'not-determined' ? 'prompt' : state === 'restricted' ? 'denied' : state;
  },
  showMini: () => {
    if (!miniEnabled) throw new Error('MINI_DISABLED');
    showMini();
  },
  getMiniSnapshot: async (): Promise<MiniSnapshot> => {
    const [settings, sessions] = await Promise.all([
      handlers.getSettings(SETTINGS_PROTOCOL_VERSION) as Promise<SettingsSnapshot>,
      handlers.listSessions() as Promise<SessionSummary[]> | SessionSummary[],
    ]);
    const { language, theme, textScale, reducedMotion } = settings.values.ui;
    return { appearance: { language, theme, textScale, reducedMotion }, session: activeMiniSession(sessions) };
  },
  stopMiniRun: async (id: string) => {
    const target = handlers;
    const sessions = await target.listSessions() as SessionSummary[];
    if (target !== handlers || !miniEnabled || activeMiniSession(sessions)?.id !== id) return false;
    await target.abort(id);
    return true;
  },
  openMiniSession: async (id: string) => {
    const target = handlers;
    const sessions = await target.listSessions() as SessionSummary[];
    if (target !== handlers || !miniEnabled || !sessions.some(item => item.id === id && !item.parent && !item.archived)) return false;
    pendingMiniSession = id;
    if (!win) createWindow();
    win?.show();
    win?.focus();
    win?.webContents.send('sun:mini-open');
    miniWindow?.hide();
    return true;
  },
  takeMiniSession: () => {
    const selected = pendingMiniSession;
    pendingMiniSession = undefined;
    return selected;
  },
  trackAppshotSession: (id: unknown) => {
    if (typeof id === 'string' && !connectionStatus && host?.listSessions().some(session => session.id === id)) activeAppshotSession = id;
  },
  desktopShortcutStatus: () => ({
    active: miniShortcut.active,
    state: requestedShortcut ? requestedShortcut === miniShortcut.active ? 'active' : 'unavailable' : 'unbound',
  }),
  connectionStatus: () => connectionStatus,
  listDesktopConnections: (): DesktopConnections => ({
    selected: remoteName,
    profiles: loadRemotes().remotes.map(({ name, url, fingerprint, hostId, label }) => {
      let endpoint = '';
      try { endpoint = remoteEndpoint(url); } catch { /* Hide invalid legacy endpoints. */ }
      return { name, url: endpoint, fingerprint, hostId, label };
    }),
    status: connectionStatus,
  }),
  previewDesktopConnection: (url: unknown) => review.preview(url),
  confirmDesktopConnection: (input: ConfirmConnection) => changeConnection(() => attachRemote(review.confirm(input))),
  selectDesktopConnection: (name: string | null) => changeConnection(async () => {
    if (name === null) {
      await connectLocal(true);
    } else {
      const entry = typeof name === 'string' && getRemote(name);
      if (!entry) throw new Error('UNKNOWN_GATEWAY_PROFILE');
      await attachRemote(entry);
    }
  }),
  removeDesktopConnection: (name: unknown) => {
    if (switching || typeof name !== 'string' || name === remoteName) return false;
    return removeRemote(name);
  },
  listDesktopCredentials: async () => ({ available: await credentials.broker.available(), entries: credentials.broker.list() }),
  saveDesktopCredential: (input: CredentialInput, prior?: Pick<CredentialReference, 'id' | 'revision'>) => credentials.broker.save(input, prior),
  deleteDesktopCredential: (id: string, revision: string) => credentials.broker.remove(id, revision),
  openDesktopCredentialSignIn: async (id: string, revision: string, url: string) => {
    const { values: { ui: { language } } } = readSettings();
    const chinese = language === 'zh-CN' || (language === 'system' && /^zh/i.test(app.getLocale()));
    const title = 'Private sign-in';
    return credentials.open(id, revision, url, language, {
      title: chinese ? zhCN[title] ?? title : title, preferences: webPreferences,
      load: window => loadRenderer(window, 'private-sign-in'),
    });
  },
  privateSignInStatus: () => credentials.status(),
  fillPrivateSignIn: () => credentials.fill(),
  closePrivateSignIn: () => credentials.closeAfterReply(),
};

const forward = (e: LiveEvent) => {
  win?.webContents.send('sun:live', e);
  if (e.kind === 'sessions' || e.kind === 'settings' || e.kind === 'connection') miniWindow?.webContents.send('sun:mini-update');
  if (e.kind === 'settings') void syncDesktopPreferences().catch(() => undefined);
};

function wireBundleTransfer(transfer: {
  importSessionBundle(source: Readable, options?: SessionImportOptions): Promise<SessionSummary>;
  exportSessionBundle(id: string): Readable | Promise<Readable>;
}) {
  handlers.importSessionBundle = (bytes: Uint8Array, options?: SessionImportOptions) => {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > BUNDLE_MAX_COMPRESSED_BYTES) throw new Error('Invalid session bundle size.');
    return transfer.importSessionBundle(Readable.from([bytes], { objectMode: false }), options);
  };
  handlers.exportSessionBundle = async (id: string) => {
    const bytes = await buffer(await transfer.exportSessionBundle(id));
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  };
}

function detachConnection(): number {
  host?.stopComputerUse();
  activeAppshotSession = undefined;
  host?.resetAppshotDraft();
  appshotShortcut.prepare('')?.commit();
  releaseLive?.();
  releaseApprover?.();
  releaseLive = undefined;
  releaseApprover = undefined;
  return ++connectionGeneration;
}

function finalizeHandlers() {
  Object.assign(handlers, surface);
  wrapSettings();
  void syncDesktopPreferences().catch(() => undefined);
}

function localOverlay(remote: SettingsSnapshot | undefined): SettingsSnapshot {
  const local = readSettings();
  if (!remote) return {
    ...local, revision: 'unavailable', userRevision: local.revision, hostSettingsUnavailable: true,
    capabilities: ['general', 'appearance', 'notifications', 'read-aloud', 'shortcuts'].map(id => ({
      id: `core.settings.${id}`, owner: 'core', state: 'available', surface: ['desktop'], configKeys: [],
    })),
  };
  const origins = Object.fromEntries(Object.entries(local.origins).filter(([key]) => key.startsWith('ui.')));
  return { ...remote, userRevision: local.revision, values: { ...remote.values, ui: local.values.ui }, origins: { ...remote.origins, ...origins } };
}

type HostInfo = { home: string; defaultCwd: string; platform: string; version: string; settingsProtocolVersion: number };
type GatewaySnapshot = { identity: GatewayConnection; settings: SettingsSnapshot; info: HostInfo; sessions: SessionSummary[]; approvals: PendingApproval[] };

async function snapshotGateway(client: GatewayClient): Promise<GatewaySnapshot> {
  const identity = await client.connection();
  const [settings, info, sessions, approvals] = await Promise.all([
    client.call<SettingsSnapshot>('getSettings', SETTINGS_PROTOCOL_VERSION), client.call<HostInfo>('appInfo'),
    client.call<SessionSummary[]>('listSessions'), client.call<PendingApproval[]>('pendingApprovals'),
  ]);
  return { identity, settings, info, sessions, approvals };
}

function configureGateway(client: GatewayClient, profile?: RemoteEntry, seed?: GatewaySnapshot) {
  const generation = detachConnection();
  remoteName = profile?.name;
  let latest = seed;
  let sync = 0;
  let streamReady = false;
  let buffered: LiveEvent[] = [];
  connectionStatus = { state: 'stale', url: client.info.url, hostId: profile?.hostId, label: profile?.label };
  const status = (state: GatewayStatus['state'], identity?: GatewayConnection) => {
    connectionStatus = {
      ...connectionStatus, state, ...(identity && { hostId: identity.hostId, label: identity.label }),
    };
    forward({ kind: 'connection', status: connectionStatus });
  };
  const requireReady = () => {
    if (generation !== connectionGeneration || connectionStatus?.state !== 'ready') throw new Error('GATEWAY_CONNECTION_STALE');
  };
  const get = (snapshot?: SettingsSnapshot) => profile ? localOverlay(snapshot) : snapshot ?? { ...localOverlay(undefined), userRevision: undefined };
  handlers = Object.fromEntries(API_METHODS.map(method => [method, (...args: unknown[]) => {
    if (computerMethods.has(method) || ['captureAppshot', 'prepareAppshot', 'cancelAppshot', 'sendAppshotMessage'].includes(method)) {
      throw new Error('CAPABILITY_UNAVAILABLE: Native adapters are unavailable when attached to a gateway.');
    }
    if (!isGatewayRead(method)) requireReady();
    return client.call(method, ...args);
  }]));
  handlers.appInfo = () => ({
    ...latest?.info, home: latest?.info.home ?? '', localHome: sunHome(), gateway: client.info.url,
    mode: profile ? 'remote' : 'gateway', connection: connectionStatus,
  });
  handlers.getSettings = async (version: unknown) => {
    requireSettingsProtocol(version);
    if (connectionStatus?.state !== 'ready') return get(latest?.settings);
    const settings = await client.call<SettingsSnapshot>('getSettings', version);
    if (latest) latest.settings = settings;
    return get(settings);
  };
  handlers.listCapabilities = async (version: unknown) => (await handlers.getSettings(version) as SettingsSnapshot).capabilities;
  handlers.updateSettings = async (input: SettingsPatch, version: unknown): Promise<SettingsWriteResult> => {
    requireSettingsProtocol(version);
    if (profile && input?.scope === 'user') {
      const { result } = writeSettings(input, () => false);
      if (result.ok) {
        forward({ kind: 'settings', scope: 'user', revision: result.snapshot.revision });
        return { ...result, snapshot: localOverlay(latest?.settings) };
      }
      return result;
    }
    requireReady();
    const result = await client.call<SettingsWriteResult>('updateSettings', input, version);
    if (!result.ok) return result;
    if (latest) latest.settings = result.snapshot;
    return { ...result, snapshot: get(result.snapshot) };
  };
  handlers.listSessions = () => connectionStatus?.state === 'ready' ? client.call('listSessions') : latest?.sessions ?? [];
  handlers.pendingApprovals = () => connectionStatus?.state === 'ready' ? client.call('pendingApprovals') : latest?.approvals ?? [];
  wireBundleTransfer({
    importSessionBundle: (source, options) => { requireReady(); return client.importSessionBundle(source, options); },
    exportSessionBundle: id => client.exportSessionBundle(id),
  });
  releaseLive = client.subscribe(event => {
    if (generation !== connectionGeneration) return;
    if (connectionStatus?.state === 'ready') {
      if (latest && event.kind === 'sessions') latest.sessions = event.sessions;
      if (latest && event.kind === 'approvals') latest.approvals = event.approvals;
      forward(event);
    } else if (streamReady && buffered.length < 1024) buffered.push(event);
  }, {
    approver: true,
    onState: state => {
      if (generation !== connectionGeneration) return;
      const ticket = ++sync;
      streamReady = state === 'ready';
      buffered = [];
      if (!streamReady) { status(state); return; }
      void snapshotGateway(client).then(snapshot => {
        if (generation !== connectionGeneration || ticket !== sync) return;
        latest = snapshot;
        status('ready', snapshot.identity);
        forward({ kind: 'sessions', sessions: snapshot.sessions });
        forward({ kind: 'approvals', approvals: snapshot.approvals });
        forward({ kind: 'settings', revision: snapshot.settings.revision });
        for (const event of buffered) forward(event);
        buffered = [];
      }, error => {
        if (generation !== connectionGeneration || ticket !== sync) return;
        status(String(error).includes('GATEWAY_HOST_CHANGED') ? 'identity-changed' : 'stale');
      });
    },
  });
  finalizeHandlers();
}

async function attachRemote(entry: RemoteEntry) {
  entry = { ...entry, url: remoteEndpoint(entry.url) };
  if (!entry.url.startsWith('https://') || !entry.cert || !entry.fingerprint) throw new Error('INVALID_GATEWAY_ENDPOINT');
  const old = getRemote(entry.name);
  if (old?.hostId && old.url !== entry.url) throw new Error('GATEWAY_HOST_CHANGED');
  const identity = await new GatewayClient({ ...entry, hostId: old?.hostId ?? entry.hostId }).connection();
  const bound = { ...entry, hostId: identity.hostId, label: identity.label };
  const client = new GatewayClient(bound);
  const snapshot = await snapshotGateway(client);
  storeRemote(bound, true);
  configureGateway(client, bound, snapshot);
}

async function connectLocal(clearSelection = false): Promise<void> {
  const gw = await findGateway();
  if (gw) {
    const client = new GatewayClient(gw);
    const snapshot = await snapshotGateway(client).catch(() => undefined);
    if (clearSelection) clearDesktopRemote();
    configureGateway(client, undefined, snapshot);
    return;
  }
  if (!host) {
    const helper = app.isPackaged ? join(process.resourcesPath, 'sun-appshot') : join(here, '../../build/native/sun-appshot');
    const computerHelper = app.isPackaged ? join(process.resourcesPath, 'sun-computer') : join(here, '../../build/native/sun-computer');
    const created: HarnessHost = new HarnessHost({
      nativeCapabilities: {
        appshots: macAppshots(helper, () => created.config.ui.appshots, credentials.captureGuard),
        computerUse: macComputer(computerHelper, app.isPackaged ? 'dev.sun-harness.desktop' : 'com.github.Electron', credentials.captureGuard),
      },
    });
    await created.init();
    created.startBackground(60_000, { intel: true });
    host = created;
  }
  if (clearSelection) clearDesktopRemote();
  detachConnection();
  remoteName = undefined;
  connectionStatus = undefined;
  handlers = hostMethods(host, { mode: 'local', surface: 'desktop' });
  wireBundleTransfer(host);
  releaseLive = host.subscribe(forward);
  if (win) releaseApprover = host.registerApprover();
  finalizeHandlers();
}

async function connect(): Promise<void> {
  const saved = loadRemotes();
  const selected = saved.remotes.find(entry => entry.name === saved.desktop);
  if (selected?.hostId && selected.cert && selected.fingerprint) {
    let endpoint: string | undefined;
    try { endpoint = remoteEndpoint(selected.url); } catch { /* Invalid legacy endpoint. */ }
    if (endpoint?.startsWith('https://')) {
      const entry = { ...selected, url: endpoint };
      configureGateway(new GatewayClient(entry), entry);
      return;
    }
  }
  try {
    await connectLocal();
  } catch (error) {
    if (!(error instanceof SettingsConfigError)) throw error;
    handlers = { ...surface, appInfo: () => ({ home: sunHome(), mode: 'local', settingsRecovery: error.code }) };
  }
}

async function changeConnection(action: () => Promise<void>): Promise<void> {
  if (switching) throw new Error('GATEWAY_SWITCH_IN_PROGRESS');
  switching = true;
  try {
    await action();
    rendererEpoch++;
    pendingMiniSession = undefined;
    miniWindow?.close();
  } finally {
    switching = false;
  }
}

ipcMain.on('sun:epoch', event => { event.returnValue = rendererEpoch; });
ipcMain.handle('sun:call', async (event, method: string, args: unknown[], epoch: number) => {
  if (computerMethods.has(method) && (event.sender !== win?.webContents || event.senderFrame !== event.sender.mainFrame)) {
    throw new Error('DESKTOP_METHOD_UNAVAILABLE');
  }
  if (credentials.isControls(event.sender) || privateSignInMethods.has(method) || credentialMethods.has(method)) {
    const isControls = credentials.isControls(event.sender);
    const authorized = isControls ? privateSignInMethods.has(method)
      : event.sender === win?.webContents && credentialMethods.has(method) && epoch === rendererEpoch;
    if (!credentials.supported || !authorized || event.senderFrame !== event.sender.mainFrame) throw new Error('CREDENTIAL_METHOD_UNAVAILABLE');
    try {
      requireSettingsProtocol(args?.[0]);
      return await surface[method](...args.slice(1));
    } catch (error) {
      if (error instanceof Error && /^CREDENTIAL_[A-Z_]{1,45}$/.test(error.message)) throw error;
      throw new Error('CREDENTIAL_OPERATION_FAILED');
    }
  }
  if (epoch !== rendererEpoch) throw new Error('GATEWAY_VIEW_CHANGED');
  if (event.sender === miniWindow?.webContents) {
    if (!miniMethods.has(method)) throw new Error('MINI_METHOD_UNAVAILABLE');
  } else if (desktopMethods.has(method) && (event.sender !== win?.webContents || miniMethods.has(method))) {
    throw new Error('DESKTOP_METHOD_UNAVAILABLE');
  }
  if (!(API_METHODS as readonly string[]).includes(method) || !handlers[method]) throw new Error(`Unknown method ${method}`);
  return handlers[method](...(args ?? []));
});

const webPreferences = {
  preload: join(here, '../preload/index.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

function loadRenderer(window: BrowserWindow, hash?: string) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    if (hash) url.hash = hash;
    void window.loadURL(url.href);
  } else {
    void window.loadFile(join(here, '../renderer/index.html'), { hash });
  }
}

function showMini() {
  if (!miniEnabled) return;
  if (!miniWindow) {
    miniWindow = new BrowserWindow({
      width: 420,
      height: 260,
      resizable: false,
      title: 'sun-harness',
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences,
    });
    miniWindow.on('closed', () => { miniWindow = null; });
    miniWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    miniWindow.webContents.on('will-navigate', event => event.preventDefault());
    const panel = miniWindow;
    panel.once('ready-to-show', () => { if (miniEnabled && miniWindow === panel) panel.show(); });
    loadRenderer(miniWindow, 'mini');
  } else {
    miniWindow.show();
  }
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    title: 'sun-harness',
    backgroundColor: '#13100d',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences,
  });
  win.webContents.on('will-prevent-unload', event => {
    if (!win) return;
    const language = host?.config.ui.language;
    const chinese = language === 'zh-CN' || (language !== 'en' && /^zh/i.test(app.getLocale()));
    const text = (key: string) => chinese ? zhCN[key] ?? key : key;
    const action = dialog.showMessageBoxSync(win, {
      type: 'question',
      message: text('Discard unsaved settings changes? Choose Cancel to stay.'),
      buttons: [text('Cancel'), text('Discard edit')],
      defaultId: 0,
      cancelId: 0,
    });
    if (action === 1) event.preventDefault();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(win, pendingMiniSession ? 'chat' : undefined);
  if (!connectionStatus) releaseApprover = host?.registerApprover();
  win.on('closed', () => {
    host?.stopComputerUse();
    credentials.close();
    releaseApprover?.();
    win = null;
    miniWindow?.close();
  });
}

app.whenReady().then(async () => {
  // The renderer may use the microphone (voice input) and show notifications; every other permission is refused.
  session.defaultSession.setPermissionRequestHandler((contents, permission, cb, details) =>
    cb(contents === win?.webContents && (permission === 'notifications' || (permission === 'media' && (details as { mediaTypes?: string[] }).mediaTypes?.every((t) => t === 'audio') !== false))),
  );
  await connect();
  createWindow();
  app.on('activate', () => { if (!win) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

let disposing: Promise<void> | undefined;
app.on('before-quit', (event) => {
  if (disposing) return;
  credentials.close();
  globalShortcut.unregisterAll();
  releaseLive?.();
  if (!host) return;
  // Managed Chromium and other children are not killed with Electron; finish disposal (bounded) first.
  event.preventDefault();
  disposing = Promise.race([host.dispose().catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  // Re-quitting in the same task as a SIGTERM-initiated quit closes the windows without quitting.
  void disposing.then(() => setTimeout(() => app.quit(), 0));
});
