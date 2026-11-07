import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { acceptProposal, listProposals, rejectProposal } from './evolution.js';
import type { HarnessHost } from './host.js';
import { listIntelReports, readIntelReport } from './intel.js';
import { readMemory, writeMemory } from './memory.js';
import { ensureDir, homePath, sunHome } from './paths.js';
import { readSse } from './providers/sse.js';
import { listSchedules, removeSchedule } from './schedule.js';
import { fingerprintOf, matchDevice } from './remote.js';
import type { RouteHandler } from './bots/adapters.js';
import type { ApprovalDecision, LiveEvent, RunStatus, SessionEvent, SessionSummary } from './types.js';

export const VERSION = '0.3.1';

type Method = (...args: any[]) => unknown;

/**
 * The one method table every surface uses (desktop IPC, gateway HTTP, remote clients).
 * Surface-specific methods (folder pickers, opening files) are added by each surface.
 */
export function hostMethods(host: HarnessHost, info: { mode: 'local' | 'gateway' }): Record<string, Method> {
  return {
    appInfo: () => ({ home: sunHome(), version: VERSION, platform: platform(), defaultCwd: homedir(), mode: info.mode }),
    listSessions: () => host.listSessions(),
    getEvents: (id: string) => host.getEvents(id),
    createSession: (input) => host.createSession(input),
    deleteSession: (id: string) => host.deleteSession(id),
    renameSession: (id: string, title: string) => host.renameSession(id, title),
    send: (id: string, text: string) => host.send(id, text),
    resume: (id: string, model?: string) => host.resume(id, { model }),
    abort: (id: string) => host.abort(id),
    isRunning: (id: string) => host.isRunning(id),
    listCheckpoints: (id: string) => host.listCheckpoints(id),
    undo: (id: string, steps?: number) => host.undo(id, { steps }),
    sandboxInfo: (id?: string) => host.sandboxInfo(id),
    browserInfo: (id?: string) => host.browserInfo(id),
    browserView: (id: string, on: boolean) => host.browserView(id, on),
    browserTakeover: (id: string, on: boolean) => host.browserTakeover(id, on),
    browserInput: (id: string, ev: Parameters<HarnessHost['browserInput']>[1]) => host.browserInput(id, ev),
    approve: (callId: string, decision: ApprovalDecision, promptId?: string) => {
      if (!host.approve(callId, decision, promptId)) throw new Error(`No pending approval for ${callId} with this prompt (already answered, expired, or re-issued).`);
      return true;
    },
    pendingApprovals: () => host.pendingApprovals(),
    switchModel: (id: string, model: string) => host.switchModel(id, model),
    switchMode: (id: string, mode: string) => host.switchMode(id, mode),
    listJobs: (sessionId?: string) => host.listJobs(sessionId),
    jobOutput: (jobId: string) => host.jobOutput(jobId),
    killJob: (jobId: string) => host.killJob(jobId),
    worktreeStatus: (id: string) => host.worktreeStatus(id),
    worktreeDiff: (id: string) => host.worktreeDiff(id),
    mergeWorktree: (id: string, strategy?: 'squash' | 'merge') => host.mergeWorktree(id, { strategy }),
    discardWorktree: (id: string) => host.discardWorktree(id),
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
    kbIndex: () => host.kbIndex(),
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
  };
}

// ---------------- discovery ----------------

export interface GatewayInfo {
  url: string;
  token: string;
  pid: number;
  startedAt: string;
  /** Present when the gateway serves HTTPS: local clients pin this certificate. */
  cert?: string;
  fingerprint?: string;
}

function infoFile(): string {
  return homePath('gateway.json');
}

export function readGatewayInfo(): GatewayInfo | undefined {
  try {
    return JSON.parse(readFileSync(infoFile(), 'utf8'));
  } catch {
    return undefined;
  }
}

/** A running, reachable gateway for this SUN_HOME, or undefined. */
export async function findGateway(timeoutMs = 800): Promise<GatewayInfo | undefined> {
  if (process.env.SUN_NO_GATEWAY) return undefined;
  const info = readGatewayInfo();
  if (!info) return undefined;
  try {
    const r = await pinnedFetch(info, '/api/health', { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (r.status !== 200) return undefined;
    const body = (await r.json()) as { home?: string };
    return body.home === sunHome() ? info : undefined;
  } catch {
    return undefined;
  }
}

// ---------------- server ----------------

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};

export interface GatewayOptions {
  port?: number;
  hostname?: string;
  token?: string;
  /** Built web UI (apps/desktop/out/renderer) to serve at "/". */
  webRoot?: string;
  /** Write ~/.sun/gateway.json so clients can find this gateway (default true). */
  advertise?: boolean;
  /** Serve HTTPS with this certificate (see ensureTls). Required for non-loopback addresses. */
  tls?: { cert: string; key: string };
  /** Allow plain HTTP on a non-loopback address (not recommended). */
  insecure?: boolean;
  /** Extra GET/POST routes (chat bots; GET for WeChat/WeCom URL verification). Handlers get `authorized` (owner or device token) and the raw body; they do their own auth. */
  routes?: Record<string, RouteHandler>;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export interface RunningGateway {
  url: string;
  token: string;
  server: Server;
  close(): Promise<void>;
}

/**
 * HTTP gateway: POST /api/call {method, args} and GET /api/events (SSE) over one HarnessHost.
 * Binds to 127.0.0.1 by default; every request needs the bearer token (header, or ?token= for EventSource).
 */
export async function startGateway(host: HarnessHost, opts: GatewayOptions = {}): Promise<RunningGateway> {
  const hostname = opts.hostname ?? '127.0.0.1';
  if (!LOOPBACK.has(hostname) && !opts.tls && !opts.insecure) {
    throw new Error(`Refusing to listen on ${hostname} without TLS. Use --tls (self-signed certificate, pinned by clients) or --insecure.`);
  }
  const token = opts.token ?? randomBytes(24).toString('hex');
  const methods = hostMethods(host, { mode: 'gateway' });
  const webRoot = opts.webRoot && existsSync(join(opts.webRoot, 'index.html')) ? resolve(opts.webRoot) : undefined;
  // The owner token (gateway.json) or any non-revoked device token (sun gateway token create).
  const authed = (req: IncomingMessage, url: URL) => {
    const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token') ?? undefined;
    return presented === token || !!matchDevice(presented);
  };

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = opts.routes?.[url.pathname];
    if (route && (req.method === 'POST' || req.method === 'GET')) {
      let body = '';
      for await (const chunk of req) body += chunk;
      return route(req, res, { authorized: authed(req, url), body });
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authed(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, home: sunHome(), version: VERSION, pid: process.pid });
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ kind: 'notice', level: 'info', text: 'connected' })}\n\n`);
        const release = url.searchParams.get('approver') === '1' ? host.registerApprover() : () => undefined;
        const unsub = host.subscribe((e) => res.write(`data: ${JSON.stringify(e)}\n\n`));
        const beat = setInterval(() => res.write(': ping\n\n'), 15_000);
        req.on('close', () => {
          clearInterval(beat);
          unsub();
          release();
        });
        return;
      }
      if (url.pathname === '/api/call' && req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        let body: { method?: string; args?: unknown[] };
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return send(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const fn = body.method ? methods[body.method] : undefined;
        if (!fn) return send(res, 404, { ok: false, error: `Unknown method ${body.method}` });
        try {
          const result = await fn(...(body.args ?? []));
          return send(res, 200, { ok: true, result: result ?? null });
        } catch (e) {
          return send(res, 200, { ok: false, error: (e as Error).message ?? String(e) });
        }
      }
      return send(res, 404, { ok: false, error: 'not found' });
    }
    if (!webRoot) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('sun-harness gateway. Build the web UI (pnpm build) to serve it here.');
    }
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = resolve(webRoot, rel || 'index.html');
    if (!file.startsWith(webRoot) || !existsSync(file) || statSync(file).isDirectory()) file = join(webRoot, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  };
  const server: Server = opts.tls ? createHttpsServer({ cert: opts.tls.cert, key: opts.tls.key }, handler) : createServer(handler);

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4471, hostname, () => ok());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const urlBase = `${opts.tls ? 'https' : 'http'}://${hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname}:${port}`;
  if (opts.advertise !== false) {
    ensureDir(sunHome());
    const info: GatewayInfo = { url: urlBase, token, pid: process.pid, startedAt: new Date().toISOString() };
    if (opts.tls) Object.assign(info, { cert: opts.tls.cert, fingerprint: fingerprintOf(opts.tls.cert) });
    writeFileSync(infoFile(), JSON.stringify(info, null, 2), { mode: 0o600 });
  }
  return {
    url: urlBase,
    token,
    server,
    close: () =>
      new Promise<void>((ok) => {
        if (opts.advertise !== false && readGatewayInfo()?.pid === process.pid) {
          try {
            unlinkSync(infoFile());
          } catch {
            // already gone
          }
        }
        server.closeAllConnections?.();
        server.close(() => ok());
      }),
  };
}

// ---------------- client ----------------

export interface ClientTarget {
  url: string;
  token: string;
  /** Pinned certificate for https gateways: trusted as the only CA, and its fingerprint must match. */
  cert?: string;
  fingerprint?: string;
}

interface MiniResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
  json(): Promise<unknown>;
}

/** fetch for http; node:https with certificate pinning for https (self-signed gateways). */
export function pinnedFetch(target: ClientTarget, path: string, init: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }): Promise<MiniResponse> {
  const url = `${target.url}${path}`;
  if (!url.startsWith('https://') || !target.cert) return fetch(url, init) as unknown as Promise<MiniResponse>;
  return new Promise((resolve, reject) => {
    const norm = (f?: string) => (f ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
    const req = httpsRequest(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        ca: target.cert,
        // The certificate is pinned: identity is its fingerprint, not the hostname it was issued for.
        checkServerIdentity: (_host, peer) =>
          norm(peer.fingerprint256) === norm(target.fingerprint) ? undefined : new Error(`Gateway certificate fingerprint changed (got ${peer.fingerprint256}). Refusing to connect.`),
        signal: init.signal,
        // No pooled sockets: a connection verified for another client (or another pin) must never be reused.
        agent: false,
      },
      (res) => {
        const peer = (res.socket as import('node:tls').TLSSocket).getPeerCertificate?.();
        if (!peer || norm(peer.fingerprint256) !== norm(target.fingerprint)) {
          res.destroy();
          return reject(new Error('Gateway certificate fingerprint changed. Refusing to connect.'));
        }
        const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
        resolve({
          status: res.statusCode ?? 0,
          body,
          json: async () => {
            let text = '';
            for await (const chunk of res) text += chunk;
            return JSON.parse(text);
          },
        });
      },
    );
    req.on('error', reject);
    req.end(init.body);
  });
}

/** Thin client for a running gateway: method calls plus a live event stream. */
export class GatewayClient {
  constructor(readonly info: ClientTarget) {}

  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    const r = await pinnedFetch(this.info, '/api/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.info.token}` },
      body: JSON.stringify({ method, args }),
    });
    if (r.status === 401) throw new Error('Gateway rejected the token (revoked or wrong).');
    const body = (await r.json()) as { ok: boolean; result?: T; error?: string };
    if (!body.ok) throw new Error(body.error ?? `gateway call ${method} failed`);
    return body.result as T;
  }

  /**
   * Stream live events. `approver` makes this connection count as a human who can answer approvals.
   * `onReady` fires once the stream is connected (the gateway's first "connected" notice).
   */
  subscribe(fn: (e: LiveEvent) => void, opts: { approver?: boolean; onReady?: () => void } = {}): () => void {
    const ctrl = new AbortController();
    let ready = false;
    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await pinnedFetch(this.info, `/api/events?approver=${opts.approver ? 1 : 0}`, {
            headers: { authorization: `Bearer ${this.info.token}` },
            signal: ctrl.signal,
          });
          if (!r.body) throw new Error('no event stream');
          for await (const { data } of readSse(r.body)) {
            try {
              const e = JSON.parse(data) as LiveEvent;
              if (!ready && e.kind === 'notice' && e.text === 'connected') {
                ready = true;
                opts.onReady?.();
                continue;
              }
              fn(e);
            } catch {
              // ignore malformed event
            }
          }
        } catch {
          if (ctrl.signal.aborted) return;
        }
        await new Promise((res) => setTimeout(res, 1000));
      }
    })();
    return () => ctrl.abort();
  }
}

/**
 * The session API surfaces need (CLI chat/run), implemented by HarnessHost in-process
 * and by RemoteHost when a gateway owns the sessions.
 */
export interface SessionHost {
  createSession(input: Parameters<HarnessHost['createSession']>[0]): SessionSummary | Promise<SessionSummary>;
  send(id: string, text: string): Promise<void>;
  resume(id: string, opts?: { model?: string }): void | Promise<void>;
  abort(id: string): void | Promise<void>;
  switchModel(id: string, model: string): void | Promise<void>;
  switchMode(id: string, mode: string): void | Promise<void>;
  approve(callId: string, d: ApprovalDecision, promptId?: string): unknown;
  subscribe(fn: (e: LiveEvent) => void): () => void;
  registerApprover(): () => void;
  wait(id: string): Promise<{ status: RunStatus; reason?: string; detail?: string } | undefined>;
  isRunning(id: string): boolean | Promise<boolean>;
  listSessions(): SessionSummary[] | Promise<SessionSummary[]>;
  getEvents(id: string): SessionEvent[] | Promise<SessionEvent[]>;
  readyModels(): string[] | Promise<string[]>;
  listJobs(sessionId?: string): { state: string }[] | Promise<{ state: string }[]>;
  reflect(id: string): Promise<{ id: string; type: string; title: string }[]>;
  undo(id: string, opts?: { steps?: number }): { undone: string[]; restored: string[] } | Promise<{ undone: string[]; restored: string[] }>;
  /** Resolves when every live subscription is connected (remote hosts); send only after this. */
  ready?(): Promise<void>;
  dispose(): Promise<void>;
}

export class RemoteHost implements SessionHost {
  readonly client: GatewayClient;
  private approver = false;
  private unsubs: (() => void)[] = [];

  constructor(info: ClientTarget) {
    this.client = new GatewayClient(info);
  }

  createSession(input: Parameters<HarnessHost['createSession']>[0]) {
    return this.client.call<SessionSummary>('createSession', input);
  }
  send(id: string, text: string) {
    return this.client.call<void>('send', id, text);
  }
  resume(id: string, opts: { model?: string } = {}) {
    return this.client.call<void>('resume', id, opts.model);
  }
  abort(id: string) {
    return this.client.call<void>('abort', id);
  }
  switchModel(id: string, model: string) {
    return this.client.call<void>('switchModel', id, model);
  }
  undo(id: string, opts: { steps?: number } = {}) {
    return this.client.call<{ undone: string[]; restored: string[] }>('undo', id, opts.steps);
  }
  switchMode(id: string, mode: string) {
    return this.client.call<void>('switchMode', id, mode);
  }
  approve(callId: string, d: ApprovalDecision, promptId?: string) {
    return this.client.call<boolean>('approve', callId, d, promptId);
  }
  /** Call before subscribe(): the event stream then registers this client as an approver. */
  registerApprover(): () => void {
    this.approver = true;
    return () => (this.approver = false);
  }
  private pending: Promise<void>[] = [];

  subscribe(fn: (e: LiveEvent) => void): () => void {
    let onReady!: () => void;
    this.pending.push(Promise.race([new Promise<void>((r) => (onReady = r)), new Promise<void>((r) => setTimeout(r, 5000))]));
    const u = this.client.subscribe(fn, { approver: this.approver, onReady });
    this.unsubs.push(u);
    return u;
  }

  async ready(): Promise<void> {
    await Promise.all(this.pending);
  }
  isRunning(id: string) {
    return this.client.call<boolean>('isRunning', id);
  }
  async wait(id: string) {
    // Let a just-sent message start its run before polling.
    await new Promise((r) => setTimeout(r, 150));
    while (await this.isRunning(id)) await new Promise((r) => setTimeout(r, 300));
    const s = (await this.listSessions()).find((x) => x.id === id);
    return s ? { status: s.status, reason: s.statusReason, detail: s.statusDetail } : undefined;
  }
  listSessions() {
    return this.client.call<SessionSummary[]>('listSessions');
  }
  getEvents(id: string) {
    return this.client.call<SessionEvent[]>('getEvents', id);
  }
  readyModels() {
    return this.client.call<string[]>('readyModels');
  }
  listJobs(sessionId?: string) {
    return this.client.call<{ state: string }[]>('listJobs', sessionId);
  }
  reflect(id: string) {
    return this.client.call<{ id: string; type: string; title: string }[]>('reflect', id);
  }
  async dispose() {
    for (const u of this.unsubs) u();
  }
}
