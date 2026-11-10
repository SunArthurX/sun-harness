import { contextBridge, ipcRenderer } from 'electron';

const epoch = ipcRenderer.sendSync('sun:epoch') as number;
const api = {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('sun:call', method, args, epoch),
  onMiniUpdate: (fn: () => void) => {
    const listener = () => fn();
    ipcRenderer.on('sun:mini-update', listener);
    return () => ipcRenderer.removeListener('sun:mini-update', listener);
  },
  onMiniOpen: (fn: () => void) => {
    const listener = () => fn();
    ipcRenderer.on('sun:mini-open', listener);
    return () => ipcRenderer.removeListener('sun:mini-open', listener);
  },
  onAppshot: (fn: (payload: unknown) => void) => {
    const listener = (_: unknown, payload: unknown) => fn(payload);
    ipcRenderer.on('sun:appshot', listener);
    return () => ipcRenderer.removeListener('sun:appshot', listener);
  },
  onLive: (fn: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => fn(e);
    ipcRenderer.on('sun:live', listener);
    return () => ipcRenderer.removeListener('sun:live', listener);
  },
};

contextBridge.exposeInMainWorld('sun', api);
