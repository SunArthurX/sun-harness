/** Minimal Chrome DevTools Protocol client over the platform WebSocket (Node >= 22), with flat target sessions. */
export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>();
  private listeners = new Map<string, Set<(params: any, sessionId?: string) => void>>();
  private closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.onMessage(String((ev as MessageEvent).data)));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error(`CDP connection closed (${p.method})`));
      this.pending.clear();
      this.emit('__close', {});
    });
  }

  static connect(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const t = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(t);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(t);
        reject(new Error(`Could not connect to the browser at ${url}`));
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 60_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('The browser connection is closed.'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method: string, fn: (params: any, sessionId?: string) => void): () => void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => void set!.delete(fn);
  }

  /** Resolve with the first `method` event for `sessionId` that matches `pred`, or undefined after the timeout. */
  waitFor(method: string, sessionId: string | undefined, timeoutMs: number, pred: (p: any) => boolean = () => true): Promise<any | undefined> {
    return new Promise((resolve) => {
      const off = this.on(method, (p, sid) => {
        if (sid === sessionId && pred(p)) {
          off();
          clearTimeout(t);
          resolve(p);
        }
      });
      const t = setTimeout(() => {
        off();
        resolve(undefined);
      }, timeoutMs);
    });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }

  async closeAndWait(timeoutMs = 5000): Promise<void> {
    if (this.closed) return;
    await new Promise<void>(resolve => {
      const finish = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const off = this.on('__close', finish);
      const timer = setTimeout(finish, timeoutMs);
      this.close();
    });
  }

  private emit(method: string, params: any, sessionId?: string): void {
    for (const fn of this.listeners.get(method) ?? []) fn(params, sessionId);
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`));
      else p.resolve(msg.result);
    } else if (msg.method) this.emit(msg.method, msg.params, msg.sessionId);
  }
}

/** The browser-level WebSocket URL of a DevTools HTTP endpoint (http://host:port), rewritten to that host. */
export async function browserWsUrl(httpBase: string): Promise<string> {
  const res = await fetch(`${httpBase.replace(/\/$/, '')}/json/version`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`DevTools endpoint ${httpBase} answered ${res.status}`);
  const j = (await res.json()) as { webSocketDebuggerUrl: string };
  // Behind socat or a port mapping the reported host is the browser's own loopback; use the one we reached.
  const u = new URL(j.webSocketDebuggerUrl);
  const b = new URL(httpBase);
  u.host = b.host;
  return u.toString();
}
