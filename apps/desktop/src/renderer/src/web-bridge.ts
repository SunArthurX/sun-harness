// In a plain browser (the gateway's web UI) there is no Electron preload; provide the same window.sun API over HTTP.
// The bootstrap token is exchanged for an HttpOnly gateway session.
import { isGatewayRead, requireSettingsProtocol, SETTINGS_PROTOCOL_VERSION, usesGatewayRequestId, type GatewayConnection, type GatewayStatus } from '@sun/core/settings-protocol';
import { t } from './i18n';

type Live = (e: unknown) => void;

if (!(window as unknown as { sun?: unknown }).sun) {
  async function establishSession() {
    const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
    if (fromHash) history.replaceState(null, '', location.pathname + location.search);
    let legacy: string | null = null;
    try {
      legacy = localStorage.getItem('sun-token');
      localStorage.removeItem('sun-token');
    } catch {
      // Private browser sessions can deny storage access.
    }
    const token = fromHash ?? legacy;
    if (!token) return;
    const response = await fetch('/api/web-session', {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, redirect: 'error',
    });
    if (!response.ok && fromHash) throw new Error('GATEWAY_AUTH_REQUIRED');
  }

  const session = establishSession();
  void session.catch(() => undefined);
  let status: GatewayStatus = { state: 'stale', url: location.origin };
  const sessionFetch = async (path: string, init?: RequestInit): Promise<Response> => {
    await session;
    const headers = new Headers(init?.headers);
    if (status.hostId) headers.set('x-sun-host-id', status.hostId);
    return fetch(path, { ...init, headers, redirect: 'error' });
  };
  let connection: Promise<{ identity: GatewayConnection; clockOffset: number }> | undefined;
  const handshake = async () => {
    const response = await sessionFetch(`/api/connection?version=${SETTINGS_PROTOCOL_VERSION}`);
    const { result, error } = await response.json() as { result?: GatewayConnection; error?: string };
    if (!result) throw new Error(error ?? 'GATEWAY_AUTH_REQUIRED');
    requireSettingsProtocol(result.protocolVersion);
    return { identity: result, clockOffset: result.serverTime - Date.now() };
  };
  const local: Record<string, (...a: any[]) => unknown> = {
    connectionStatus: () => status,
    pickFolder: async () => prompt(t('Workspace folder (absolute path on the gateway machine):')) || undefined,
    openPath: async (p: string) => {
      await navigator.clipboard?.writeText(p).catch(() => undefined);
      alert(`${t('Path copied:')}\n${p}`);
      return '';
    },
    microphonePermission: () => undefined,
    askMicrophone: () => typeof navigator.mediaDevices?.getUserMedia === 'function',
    importSessionBundle: async (bytes: Uint8Array<ArrayBuffer>, options: { cwd?: string } = {}) => {
      if (status.state !== 'ready') throw new Error('GATEWAY_CONNECTION_STALE');
      const query = options.cwd ? `?${new URLSearchParams({ cwd: options.cwd })}` : '';
      const response = await sessionFetch(`/api/session-bundles${query}`, {
        method: 'POST', body: bytes, headers: { 'content-type': 'application/octet-stream' },
      });
      const body = await response.json();
      if (!body.ok) throw new Error(body.error);
      return body.result;
    },
    exportSessionBundle: async (id: string) => {
      const response = await sessionFetch(`/api/session-bundles/${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error((await response.json()).error);
      return new Uint8Array(await response.arrayBuffer());
    },
    openExternal: async (url: string) => void window.open(url, '_blank', 'noopener'),
  };

  const listeners = new Set<Live>();
  const emit = (event: unknown) => { for (const listener of listeners) listener(event); };
  const setStatus = (state: GatewayStatus['state'], identity?: GatewayConnection) => {
    status = { ...status, state, ...(identity && { label: identity.label, hostId: identity.hostId }) };
    emit({ kind: 'connection', status });
  };
  let source: EventSource | undefined;
  let sync = 0;
  let buffered: unknown[] = [];

  async function rpc(method: string, args: unknown[], requestId?: string) {
    const payload = JSON.stringify({ method, args, requestId });
    const invoke = async () => {
      const response = await sessionFetch('/api/call', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: payload,
      });
      if (response.status === 401) {
        setStatus('unauthorized');
        return { ok: false, error: t('Unauthorized: open the URL printed by `sun serve` (it contains #token=…).') };
      }
      return response.json();
    };
    const body = requestId ? await invoke().catch(() => invoke()) : await invoke();
    if (body.error === 'GATEWAY_INSTANCE_CHANGED' || body.error === 'GATEWAY_REQUEST_EXPIRED') connection = undefined;
    if (body.error === 'GATEWAY_HOST_CHANGED') setStatus('identity-changed');
    if (!body.ok) throw new Error(body.error);
    return body.result;
  }

  const connect = async () => {
    await session;
    if (source || !listeners.size) return;
    source = new EventSource('/api/events?approver=1');
    source.onerror = () => {
      sync++;
      buffered = [];
      connection = undefined;
      if (status.state !== 'identity-changed') setStatus(source?.readyState === EventSource.CLOSED ? 'unauthorized' : 'stale');
    };
    source.onopen = () => {
      const ticket = ++sync;
      connection = handshake();
      void Promise.all([connection, rpc('listSessions', []), rpc('pendingApprovals', []),
        rpc('getSettings', [SETTINGS_PROTOCOL_VERSION])]).then(([current, sessions, approvals, settings]) => {
        if (ticket !== sync) return;
        emit({ kind: 'sessions', sessions });
        emit({ kind: 'approvals', approvals });
        emit({ kind: 'settings', revision: settings.revision });
        setStatus('ready', current.identity);
        for (const event of buffered) emit(event);
        buffered = [];
      }, () => {
        if (ticket === sync && status.state === 'ready') setStatus('stale');
      });
    };
    source.onmessage = message => {
      const event = JSON.parse(message.data);
      if (status.state === 'ready') emit(event);
      else if (buffered.length < 1024) buffered.push(event);
    };
  };

  (window as unknown as { sun: unknown }).sun = {
    call: async (method: string, ...args: unknown[]) => {
      if (Object.hasOwn(local, method)) return local[method](...args);
      if (!isGatewayRead(method) && status.state !== 'ready') throw new Error('GATEWAY_CONNECTION_STALE');
      let requestId: string | undefined;
      if (usesGatewayRequestId(method)) {
        connection ??= handshake().catch(error => { connection = undefined; throw error; });
        const { identity, clockOffset } = await connection;
        const nonce = Array.from(crypto.getRandomValues(new Uint8Array(18)), byte => byte.toString(16).padStart(2, '0')).join('');
        requestId = `${identity.gatewayId}:${Date.now() + clockOffset}:${nonce}`;
      }
      const result = await rpc(method, args, requestId);
      if (method === 'appInfo') return { ...result, mode: 'web', connection: status };
      return result;
    },
    onLive: (fn: Live) => {
      listeners.add(fn);
      if (!source) void connect().catch(() => setStatus('unauthorized'));
      return () => listeners.delete(fn);
    },
  };
}

export {};
