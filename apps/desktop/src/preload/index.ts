import { contextBridge, ipcRenderer } from 'electron';

const api = {
  call: (method: string, ...args: unknown[]) => ipcRenderer.invoke('sun:call', method, args),
  onLive: (fn: (e: unknown) => void) => {
    const listener = (_: unknown, e: unknown) => fn(e);
    ipcRenderer.on('sun:live', listener);
    return () => ipcRenderer.removeListener('sun:live', listener);
  },
};

contextBridge.exposeInMainWorld('sun', api);
