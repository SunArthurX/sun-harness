import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HarnessHost,
  acceptProposal,
  importCredentialEnv,
  listIntelReports,
  listProposals,
  listSchedules,
  readIntelReport,
  readMemory,
  rejectProposal,
  removeSchedule,
  sunHome,
  writeMemory,
} from '@sun/core';
import { API_METHODS, type ApiMethod } from '../shared/api';

// GUI apps on macOS do not inherit the login shell env; pick up API keys from ~/.sun/.env and shell rc files.
if (!process.env.SUN_SKIP_SHELL_ENV) importCredentialEnv();

const here = dirname(fileURLToPath(import.meta.url));

let win: BrowserWindow | null = null;
const host = new HarnessHost();

type Handler = (...args: any[]) => unknown;

const handlers: Record<ApiMethod, Handler> = {
  appInfo: () => ({ home: sunHome(), version: app.getVersion(), platform: process.platform, defaultCwd: app.getPath('home') }),
  listSessions: () => host.listSessions(),
  getEvents: (id: string) => host.getEvents(id),
  createSession: (input) => host.createSession(input),
  deleteSession: (id: string) => host.deleteSession(id),
  renameSession: (id: string, title: string) => host.renameSession(id, title),
  send: (id: string, text: string) => host.send(id, text),
  resume: (id: string, model?: string) => host.resume(id, { model }),
  abort: (id: string) => host.abort(id),
  approve: (callId: string, decision) => host.approve(callId, decision),
  pendingApprovals: () => host.pendingApprovals(),
  switchModel: (id: string, model: string) => host.switchModel(id, model),
  switchMode: (id: string, mode: string) => host.switchMode(id, mode),
  listModels: () => host.listModels(),
  readyModels: () => host.readyModels(),
  listModes: () => host.listModes(),
  getConfig: () => host.config,
  updateConfig: (patch) => host.updateConfig(patch),
  listSkills: (cwd: string) => host.listSkills(cwd),
  listMcp: (cwd: string) => host.listMcp(cwd),
  reloadMcp: (cwd: string) => host.reloadMcp(cwd),
  listPlugins: () => host.pluginStates,
  reloadPlugins: () => host.reloadPlugins(),
  kbStats: () => host.kbStats(),
  kbSearch: (q: string) => host.kbSearch(q, 10),
  kbAdd: (title: string, text: string) => host.kbAdd(title, text),
  getMemory: () => readMemory(),
  setMemory: (text: string) => writeMemory(text),
  listProposals: () => listProposals(),
  acceptProposal: (id: string) => acceptProposal(id),
  rejectProposal: (id: string) => rejectProposal(id),
  reflect: (id: string) => host.reflect(id),
  listIntelReports: () => listIntelReports(),
  readIntelReport: (date: string) => readIntelReport(date),
  runIntel: (force?: boolean) => host.runIntel({ force }),
  analyzeIntel: (date: string) => host.analyzeIntel(date),
  listSchedules: () => listSchedules(),
  removeSchedule: (id: string) => removeSchedule(id),
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? undefined : r.filePaths[0];
  },
  openPath: (p: string) => shell.openPath(p),
  openExternal: (url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined),
};

ipcMain.handle('sun:call', async (_e, method: string, args: unknown[]) => {
  if (!(API_METHODS as readonly string[]).includes(method)) throw new Error(`Unknown method ${method}`);
  return handlers[method as ApiMethod](...(args ?? []));
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
  win.on('closed', () => (win = null));
}

app.whenReady().then(async () => {
  await host.init();
  host.subscribe((e) => win?.webContents.send('sun:live', e));
  host.startBackground(60_000, { intel: true });
  createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createWindow());
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void host.dispose();
});
