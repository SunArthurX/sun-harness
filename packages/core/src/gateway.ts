import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
import type { ApprovalDecision, LiveEvent, RunStatus, SessionEvent, SessionSummary } from './types.js';

export const VERSION = '0.2.0';

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
    const r = await fetch(`${info.url}/api/health`, { headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return undefined;
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
}

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
  const token = opts.token ?? randomBytes(24).toString('hex');
  const methods = hostMethods(host, { mode: 'gateway' });
  const webRoot = opts.webRoot && existsSync(join(opts.webRoot, 'index.html')) ? resolve(opts.webRoot) : undefined;
  const authed = (req: IncomingMessage, url: URL) => req.headers.authorization === `Bearer ${token}` || url.searchParams.get('token') === token;

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
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
  });

  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4471, opts.hostname ?? '127.0.0.1', () => ok());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  const urlBase = `http://${opts.hostname && opts.hostname !== '0.0.0.0' ? opts.hostname : '127.0.0.1'}:${port}`;
  if (opts.advertise !== false) {
    ensureDir(sunHome());
    writeFileSync(infoFile(), JSON.stringify({ url: urlBase, token, pid: process.pid, startedAt: new Date().toISOString() } satisfies GatewayInfo, null, 2), { mode: 0o600 });
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

/** Thin client for a running gateway: method calls plus a live event stream. */
export class GatewayClient {
  constructor(readonly info: Pick<GatewayInfo, 'url' | 'token'>) {}

  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    const r = await fetch(`${this.info.url}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${this.info.token}` },
      body: JSON.stringify({ method, args }),
    });
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
          const r = await fetch(`${this.info.url}/api/events?approver=${opts.approver ? 1 : 0}`, {
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
  /** Resolves when every live subscription is connected (remote hosts); send only after this. */
  ready?(): Promise<void>;
  dispose(): Promise<void>;
}

export class RemoteHost implements SessionHost {
  readonly client: GatewayClient;
  private approver = false;
  private unsubs: (() => void)[] = [];

  constructor(info: Pick<GatewayInfo, 'url' | 'token'>) {
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
