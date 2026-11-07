// In a plain browser (the gateway's web UI) there is no Electron preload; provide the same window.sun API over HTTP.
// The token comes from the URL fragment (#token=…, printed by `sun serve`) and is kept in localStorage.
type Live = (e: unknown) => void;

if (!(window as unknown as { sun?: unknown }).sun) {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
  if (fromHash) {
    localStorage.setItem('sun-token', fromHash);
    history.replaceState(null, '', location.pathname);
  }
  const token = localStorage.getItem('sun-token') ?? '';

  const local: Record<string, (...a: any[]) => unknown> = {
    pickFolder: async () => prompt('Workspace folder (absolute path on the gateway machine):') || undefined,
    openPath: async (p: string) => {
      await navigator.clipboard?.writeText(p).catch(() => undefined);
      alert(`Path copied:\n${p}`);
      return '';
    },
    openExternal: async (url: string) => void window.open(url, '_blank', 'noopener'),
  };

  const listeners = new Set<Live>();
  let source: EventSource | undefined;
  const connect = () => {
    source = new EventSource(`/api/events?approver=1&token=${encodeURIComponent(token)}`);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data);
      for (const l of listeners) l(e);
    };
  };

  (window as unknown as { sun: unknown }).sun = {
    call: async (method: string, ...args: unknown[]) => {
      if (local[method]) return local[method](...args);
      const r = await fetch('/api/call', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ method, args }),
      });
      if (r.status === 401) throw new Error('Unauthorized: open the URL printed by `sun serve` (it contains #token=…).');
      const body = await r.json();
      if (!body.ok) throw new Error(body.error);
      if (method === 'appInfo') return { ...body.result, mode: 'web' };
      return body.result;
    },
    onLive: (fn: Live) => {
      listeners.add(fn);
      if (!source) connect();
      return () => listeners.delete(fn);
    },
  };
}

export {};
