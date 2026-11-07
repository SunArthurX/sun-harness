import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GatewayClient, HarnessHost, augmentPath, findGateway, hostMethods, importCredentialEnv, type LiveEvent } from '@sun/core';
import { API_METHODS } from '../shared/api';

// GUI apps on macOS do not inherit the login shell env; pick up API keys from ~/.sun/.env and shell rc files.
if (!process.env.SUN_SKIP_SHELL_ENV) importCredentialEnv();
augmentPath();

const here = dirname(fileURLToPath(import.meta.url));

type Handler = (...args: any[]) => unknown;

let win: BrowserWindow | null = null;
let handlers: Record<string, Handler> = {};
/** In-process host, or undefined when attached to a gateway that owns the sessions. */
let host: HarnessHost | undefined;
let releaseLive: (() => void) | undefined;
let releaseApprover: (() => void) | undefined;

const surface: Record<string, Handler> = {
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  },
  openPath: (p: string) => shell.openPath(p),
  openExternal: (url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined),
};

const forward = (e: LiveEvent) => win?.webContents.send('sun:live', e);

/** Attach to a running gateway (`sun serve`) if there is one; otherwise host sessions in-process. */
async function connect(): Promise<void> {
  const gw = await findGateway();
  if (gw) {
    const client = new GatewayClient(gw);
    handlers = Object.fromEntries(API_METHODS.map((m) => [m, (...args: unknown[]) => client.call(m, ...args)]));
    const appInfo = handlers.appInfo;
    handlers.appInfo = async () => ({ ...((await appInfo()) as object), mode: 'gateway', gateway: gw.url });
    // The window is a human who can answer approvals, so the event stream registers as an approver.
    releaseLive = client.subscribe(forward, { approver: true });
  } else {
    host = new HarnessHost();
    await host.init();
    handlers = hostMethods(host, { mode: 'local' });
    releaseLive = host.subscribe(forward);
    host.startBackground(60_000, { intel: true });
  }
  Object.assign(handlers, surface);
}

ipcMain.handle('sun:call', async (_e, method: string, args: unknown[]) => {
  if (!(API_METHODS as readonly string[]).includes(method) || !handlers[method]) throw new Error(`Unknown method ${method}`);
  return handlers[method](...(args ?? []));
});

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
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else win.loadFile(join(here, '../renderer/index.html'));
  releaseApprover = host?.registerApprover();
  win.on('closed', () => {
    releaseApprover?.();
    win = null;
  });
}

app.whenReady().then(async () => {
  await connect();
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  releaseLive?.();
  void host?.dispose();
});
