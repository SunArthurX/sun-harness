import { readBriefing } from './assistant/briefing.js';
import type { CustomCommand } from './ux/commands.js';
import type { CostReport } from './ux/pricing.js';
import type { ContextReport } from './ux/context.js';
import type { Automation, FileChange } from './host.js';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { existsSync, readFileSync, statSync, unlinkSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir, hostname as machineName, platform } from 'node:os';
import { basename, dirname, extname, join, normalize, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { acceptProposal, listProposals, rejectProposal } from './evolution.js';
import type { HookFixtureRequest, HookTrustChange } from './hooks.js';
import type { HarnessHost } from './host.js';
import { listIntelReports, readIntelReport } from './intel.js';
import { readMemory, readPersonalInstructions, readUserProfile, writeMemory, writePersonalInstructions, writeUserProfile } from './memory.js';
import { ensureDir, homePath, sunHome } from './paths.js';
import { readSse } from './providers/sse.js';
import { BUNDLE_MAX_BYTES, BUNDLE_MAX_COMPRESSED_BYTES } from './settings/bundle.js';
import type { AppshotMetadata } from './settings/capture.js';
import type { StorageConfirmation } from './settings/storage.js';
import type { SessionImportOptions } from './settings/import.js';
import { requireSettingsProtocol, SETTINGS_PROTOCOL_VERSION, usesGatewayRequestId, type GatewayConnection, type GatewayLiveState } from './settings/protocol.js';
import { listSchedules, removeSchedule } from './schedule.js';
import { devicesFile, fingerprintOf, gatewayHostId, listDevices, loadRemotes, matchDevice, remoteEndpoint } from './remote.js';
import { GatewayReceipts, type RpcReply } from './gateway-receipts.js';
import { ExecutionJobs, executionOperationPattern, type ExecutionJobAdapter, type ExecutionJobRequest,
  type ExecutionJobReceipt, type ExecutionTarget, type StartExecutionJob } from './settings/targets.js';
import type { RouteHandler } from './bots/adapters.js';
import type { ApprovalDecision, LiveEvent, RunStatus, SessionEvent, SessionSummary } from './types.js';

export const VERSION = '0.7.0';

type Method = (...args: any[]) => unknown;

function replaceNotes(read: () => string, write: (text: string) => void, text: string, expected?: string): boolean | undefined {
  if (expected !== undefined && read() !== expected) return false;
  write(text);
  return expected === undefined ? undefined : true;
}

function executionMethods(host: HarnessHost) {
  const localHostId = () => gatewayHostId();
  const requireHost = (expected: unknown) => {
    if (typeof expected !== 'string' || expected !== localHostId()) throw new Error('EXECUTION_TARGET_IDENTITY_CHANGED');
    return expected;
  };
  const localTarget = (kind: 'local' | 'container'): ExecutionTarget => {
    const ready = kind === 'local' || host.executionDockerReady();
    const hostId = localHostId();
    return {
      id: `${kind}:${hostId}`, hostId, label: machineName(),
      kind, health: ready ? 'ready' : 'unsupported', capabilities: ready ? ['shell-jobs'] : [],
    };
  };
  const entries = () => {
    const profiles = loadRemotes().remotes;
    if (!Array.isArray(profiles)) return [];
    return [...new Map(profiles.flatMap(entry => {
      if (!entry || typeof entry.hostId !== 'string' || !executionOperationPattern.test(entry.hostId)
        || typeof entry.cert !== 'string' || !entry.cert || typeof entry.fingerprint !== 'string' || !entry.fingerprint
        || typeof entry.token !== 'string' || !entry.token || typeof entry.name !== 'string') return [];
      try {
        const url = remoteEndpoint(entry.url);
        if (url.startsWith('https://')) return [[`remote-gateway:${entry.hostId}`, { ...entry, url }] as const];
      } catch { /* Ignore a malformed or unpinned saved profile. */ }
      return [];
    })).entries()];
  };
  const adapterFor = async (id: string): Promise<ExecutionJobAdapter | undefined> => {
    const local = id === `local:${localHostId()}` ? localTarget('local')
      : id === `container:${localHostId()}` ? localTarget('container') : undefined;
    if (local) return {
      target: local, sessions: async () => host.listExecutionSessions().filter(session =>
        session.environment === (local.kind === 'container' ? 'container' : 'host')),
      start: input => host.startExecutionJob(input, local.hostId),
      inspect: async op => host.jobs.execution(op, local.hostId),
      cancel: async op => host.jobs.execution(op, local.hostId, true),
      output: async op => host.executionProviderOutput(op, local.hostId),
    };
    const remote = entries().find(([key]) => key === id)?.[1];
    if (!remote) return;
    const client = new GatewayClient(remote);
    const target: ExecutionTarget = { id, hostId: remote.hostId!, label: remote.label ?? remote.name,
      kind: 'remote-gateway', health: 'offline', capabilities: [] };
    try {
      const identity = await client.connection();
      target.health = identity.capabilities.some(item => item.id === 'core.execution-jobs' && item.state === 'available')
        ? 'ready' : 'unsupported';
      target.capabilities = target.health === 'ready' ? ['shell-jobs'] : [];
    } catch (error) {
      if (/HOST_CHANGED|fingerprint/i.test(String(error))) target.health = 'identity-changed';
    }
    const call = <T>(method: string, ...args: unknown[]) => client.callBounded<T>(method, 12_000, SETTINGS_PROTOCOL_VERSION, ...args);
    return {
      target, sessions: () => call('executionProviderSessions', target.hostId),
      start: input => call<ExecutionJobReceipt>('startExecutionProviderJob', input),
      inspect: op => call('inspectExecutionProviderJob', op, target.hostId),
      cancel: op => call('cancelExecutionProviderJob', op, target.hostId),
      output: op => call('executionProviderOutput', op, target.hostId),
    };
  };
  const controller = new ExecutionJobs(adapterFor);
  return {
    executionTargets: async (version: unknown) => {
      requireSettingsProtocol(version);
      const remotes = await Promise.all(entries().map(([id]) => adapterFor(id)));
      return [localTarget('local'), localTarget('container'), ...remotes.flatMap(adapter => adapter ? [adapter.target] : [])];
    },
    executionTargetSessions: (version: unknown, targetId: string) => {
      requireSettingsProtocol(version);
      return controller.sessions(targetId);
    },
    listExecutionJobs: (version: unknown) => {
      requireSettingsProtocol(version);
      return controller.list();
    },
    startExecutionJob: (version: unknown, input: StartExecutionJob) => {
      requireSettingsProtocol(version);
      return controller.start(input);
    },
    refreshExecutionJob: (version: unknown, id: string) => {
      requireSettingsProtocol(version);
      return controller.refresh(id);
    },
    cancelExecutionJob: (version: unknown, id: string) => {
      requireSettingsProtocol(version);
      return controller.cancel(id);
    },
    executionJobOutput: (version: unknown, id: string) => {
      requireSettingsProtocol(version);
      return controller.output(id);
    },
    executionProviderSessions: (version: unknown, expected: string) => {
      requireSettingsProtocol(version);
      requireHost(expected);
      return host.listExecutionSessions();
    },
    startExecutionProviderJob: (version: unknown, input: ExecutionJobRequest) => {
      requireSettingsProtocol(version);
      return host.startExecutionJob(input, requireHost(input?.hostId));
    },
    inspectExecutionProviderJob: (version: unknown, id: string, expected: string) => {
      requireSettingsProtocol(version);
      return host.jobs.execution(id, requireHost(expected));
    },
    cancelExecutionProviderJob: (version: unknown, id: string, expected: string) => {
      requireSettingsProtocol(version);
      return host.jobs.execution(id, requireHost(expected), true);
    },
    executionProviderOutput: (version: unknown, id: string, expected: string) => {
      requireSettingsProtocol(version);
      return host.executionProviderOutput(id, requireHost(expected));
    },
  };
}

/**
 * The one method table every surface uses (desktop IPC, gateway HTTP, remote clients).
 * Surface-specific methods (folder pickers, opening files) are added by each surface.
 */
export function hostMethods(host: HarnessHost, info: { mode: 'local'; surface?: 'desktop' } | { mode: 'gateway' }): Record<string, Method> {
  const surface = info.mode === 'gateway' ? 'web' : info.surface ?? 'cli';
  return {
    ...executionMethods(host),
    appInfo: () => ({ home: sunHome(), version: VERSION, platform: platform(), defaultCwd: homedir(), mode: info.mode, settingsProtocolVersion: SETTINGS_PROTOCOL_VERSION }),
    listSessions: () => host.listSessions(),
    getEvents: (id: string) => host.getEvents(id),
    createSession: (input) => host.createSession(input),
    deleteSession: (id: string) => host.deleteSession(id),
    storageInventory: (includeProfiles?: boolean) => host.storageInventory(includeProfiles),
    previewStorage: (ids: string[], includeProfiles?: boolean) => host.previewStorage(ids, includeProfiles),
    moveStorage: (input: StorageConfirmation) => host.moveStorage(input),
    storageOperations: () => host.storageOperations(),
    renameSession: (id: string, title: string) => host.renameSession(id, title),
    send: (id: string, text: string) => host.send(id, text),
    resume: (id: string, model?: string) => host.resume(id, { model }),
    abort: (id: string) => host.abort(id),
    isRunning: (id: string) => host.isRunning(id),
    listCheckpoints: (id: string) => host.listCheckpoints(id),
    undo: (id: string, steps?: number) => host.undo(id, { steps }),
    sandboxInfo: (id?: string) => host.sandboxInfo(id),
    browserInfo: (id?: string) => host.browserInfo(id),
    deliverables: (id: string) => host.deliverables(id),
    sendMessage: (id: string, text: string, images?: { data: string; mime: string }[], opts?: { noDetect?: boolean }) => host.send(id, text, 'user', { images, noDetect: opts?.noDetect }),
    listCommands: (cwd?: string) => host.listCommands(cwd),
    completePaths: (cwd: string, query: string) => host.completePaths(cwd, query),
    cost: (id: string) => host.cost(id),
    compact: (id: string) => host.compact(id),
    fork: (id: string, beforeSeq: number, restoreFiles?: boolean) => host.fork(id, { beforeSeq, restoreFiles }),
    exportSession: (id: string, format?: 'markdown' | 'html' | 'jsonl') => host.exportSession(id, format),
    importSession: (jsonl: string, options?: SessionImportOptions) => host.importSession(jsonl, options),
    searchSessions: (query: string) => host.searchSessions(query),
    readAttachment: (path: string, expected?: AppshotMetadata | null) => host.readAttachment(path, expected ?? undefined),
    contextUsage: (id: string) => host.contextUsage(id),
    setSessionFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) => host.setSessionFlags(id, flags),
    resolveProposal: (id: string, proposalId: string, action: 'create' | 'run' | 'both', edits?: { title?: string; prompt?: string; schedule?: string }) => host.resolveProposal(id, proposalId, action, edits),
    previewSchedule: (text: string) => host.previewSchedule(text),
    listAutomations: () => host.listAutomations(),
    createAutomation: (input: Parameters<HarnessHost['createAutomation']>[0]) => host.createAutomation(input),
    updateAutomation: (id: string, patch: Parameters<HarnessHost['updateAutomation']>[1]) => host.updateAutomation(id, patch),
    deleteAutomation: (id: string) => host.deleteAutomation(id),
    runAutomation: (id: string) => host.runAutomation(id),
    sessionChanges: (id: string, fromSeq?: number, toSeq?: number) => host.sessionChanges(id, { fromSeq, toSeq }),
    reviewSession: (id: string) => host.reviewSession(id),
    reviewStatus: (id: string) => host.reviewStatus(id),
    revertFile: (id: string, path: string, fromSeq?: number) => host.revertFile(id, path, { fromSeq }),
    readSessionFile: (id: string, path: string) => host.readSessionFile(id, path),
    listWorkspace: (id: string, rel?: string) => host.listWorkspace(id, rel),
    contextReportHtml: (id: string) => host.contextReportHtml(id),
    metrics: (days?: number) => host.metrics(days),
    runBriefing: () => host.runBriefing(),
    readBriefing: (date: string) => readBriefing(date),
    listMemories: () => host.memoryStore.list(),
    removeMemory: (id: string) => host.memoryStore.remove(id),
    transcribe: (audioBase64: string, mime: string, requestId?: string) => host.transcribe(audioBase64, mime, requestId),
    cancelTranscription: (requestId: string) => host.cancelTranscription(requestId),
    fireTrigger: (id: string, payload?: string) => host.fireTrigger(id, { payload }),
    browserView: (...args: Parameters<HarnessHost['browserView']>) => host.browserView(...args),
    browserTakeover: (...args: Parameters<HarnessHost['browserTakeover']>) => host.browserTakeover(...args),
    browserInput: (...args: Parameters<HarnessHost['browserInput']>) => host.browserInput(...args),
    previewBrowserUpload: (id: string, version: unknown) => {
      requireSettingsProtocol(version);
      return host.previewBrowserUpload(id);
    },
    approveBrowserUpload: (id: string, request: Parameters<HarnessHost['approveBrowserUpload']>[1], version: unknown) => {
      requireSettingsProtocol(version);
      return host.approveBrowserUpload(id, request);
    },
    browserPermissions: (version: unknown) => {
      requireSettingsProtocol(version);
      return host.browser.permissions.snapshot();
    },
    updateBrowserPermission: (request: Parameters<HarnessHost['browser']['permissions']['update']>[0], version: unknown) => {
      requireSettingsProtocol(version);
      return host.browser.permissions.update(request);
    },
    approve: (callId: string, decision: ApprovalDecision, promptId?: string) => {
      if (!['allow', 'allow_always', 'deny'].includes(decision) || (info.mode === 'gateway' && !promptId)
        || !host.approve(callId, decision, promptId)) throw new Error(`No pending approval for ${callId} with this prompt (already answered, expired, or re-issued).`);
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
    worktreeInventory: () => host.worktreeInventory(),
    previewWorktreeCleanup: (ids: string[]) => host.previewWorktreeCleanup(ids),
    cleanupWorktrees: (ids: string[], revision: string) => host.cleanupWorktrees(ids, revision),
    runWorktreeSetup: (id: string, hookId: string, digest: string) => host.runWorktreeSetup(id, hookId, digest),
    acknowledgeWorktreeRecovery: (id: string) => host.acknowledgeWorktreeRecovery(id),
    mergeWorktree: (id: string, strategy?: 'squash' | 'merge') => host.mergeWorktree(id, { strategy }),
    discardWorktree: (id: string) => host.discardWorktree(id),
    listModels: () => host.listModels(),
    readyModels: () => host.readyModels(),
    listModes: () => host.listModes(),
    getSettings: (version: unknown) => {
      requireSettingsProtocol(version);
      return host.getSettings(surface);
    },
    updateSettings: (patch: unknown, version: unknown) => {
      requireSettingsProtocol(version);
      return host.updateSettings(patch, surface);
    },
    listCapabilities: (version: unknown) => {
      requireSettingsProtocol(version);
      return host.listCapabilities(surface);
    },
    ...(surface === 'desktop' ? {
      captureAppshot: (version: unknown, id: string) => {
        requireSettingsProtocol(version);
        return host.captureAppshot(id, 'own-app');
      },
      prepareAppshot: (version: unknown, ...args: Parameters<HarnessHost['prepareAppshot']>) => {
        requireSettingsProtocol(version);
        return host.prepareAppshot(...args);
      },
      cancelAppshot: (version: unknown, ...args: Parameters<HarnessHost['cancelAppshot']>) => {
        requireSettingsProtocol(version);
        return host.cancelAppshot(...args);
      },
      sendAppshotMessage: (version: unknown, ...args: Parameters<HarnessHost['sendAppshotMessage']>) => {
        requireSettingsProtocol(version);
        return host.sendAppshotMessage(...args);
      },
      inspectComputerUse: (version: unknown) => {
        requireSettingsProtocol(version);
        return host.inspectComputerUse();
      },
      grantComputerUse: (version: unknown, ...args: Parameters<HarnessHost['grantComputerUse']>) => {
        requireSettingsProtocol(version);
        return host.grantComputerUse(...args);
      },
      beginComputerUse: (version: unknown, id: string, appId: string) => {
        requireSettingsProtocol(version);
        return host.beginComputerUse(id, appId);
      },
      stopComputerUse: (version: unknown) => {
        requireSettingsProtocol(version);
        return host.stopComputerUse();
      },
      computerOwner: (version: unknown) => {
        requireSettingsProtocol(version);
        return host.computerOwner();
      },
    } : {}),
    getConfig: () => { throw new Error('Settings protocol mismatch. Update the client.'); },
    updateConfig: () => { throw new Error('Settings protocol mismatch. Update the client.'); },
    listHooks: (cwd: string, version: unknown) => {
      requireSettingsProtocol(version);
      return host.listHooks(cwd);
    },
    reviewHooks: (cwd: string, changes: HookTrustChange[], version: unknown) => {
      requireSettingsProtocol(version);
      return host.reviewHooks(cwd, changes);
    },
    runHookFixture: (request: HookFixtureRequest, version: unknown) => {
      requireSettingsProtocol(version);
      return host.runHookFixture(request);
    },
    cancelHookFixture: (id: string, version: unknown) => {
      requireSettingsProtocol(version);
      return host.cancelHookFixture(id);
    },
    listSkills: (cwd: string) => host.listSkills(cwd),
    listMcp: (cwd: string) => host.listMcp(cwd),
    reloadMcp: (cwd: string) => host.reloadMcp(cwd),
    listPlugins: () => host.pluginStates,
    reloadPlugins: () => host.reloadPlugins(),
    setPluginEnabled: (request: unknown, version: unknown) => {
      requireSettingsProtocol(version);
      return host.setPluginEnabled(request, surface);
    },
    kbStats: () => host.kbStats(),
    kbSearch: (q: string) => host.kbSearch(q, 10),
    kbAdd: (title: string, text: string) => host.kbAdd(title, text),
    kbIndex: () => host.kbIndex(),
    getMemory: (full?: boolean) => readMemory(full === true),
    setMemory: (text: string, expected?: string) => replaceNotes(() => readMemory(true), writeMemory, text, expected),
    getUserProfile: () => readUserProfile(),
    setUserProfile: (text: string, expected?: string) => replaceNotes(readUserProfile, writeUserProfile, text, expected),
    getPersonalInstructions: () => readPersonalInstructions(),
    setPersonalInstructions: (text: string, expected: string) => replaceNotes(readPersonalInstructions, writePersonalInstructions, text, expected),
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
const WEB_SESSION_MS = 24 * 60 * 60_000;

type RequestPrincipal = { key: string; deviceId?: string };
type WebSession = { principal: RequestPrincipal; expires: number };

function browserCookie(req: IncomingMessage): { name: string; value?: string } {
  const name = `sun_gateway_${req.socket.localPort}`;
  const prefix = `${name}=`;
  const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length);
  return { name, value };
}

function webSessionKey(value: string | undefined): string | undefined {
  return value && /^[a-f0-9]{64}$/.test(value) ? createHash('sha256').update(value).digest('hex') : undefined;
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
  const hostname = opts.hostname ?? '127.0.0.1';
  if (!LOOPBACK.has(hostname) && !opts.tls && !opts.insecure) {
    throw new Error(`Refusing to listen on ${hostname} without TLS. Use --tls (self-signed certificate, pinned by clients) or --insecure.`);
  }
  const token = opts.token ?? randomBytes(24).toString('hex');
  const methods = hostMethods(host, { mode: 'gateway' });
  const hostId = gatewayHostId();
  const gatewayId = randomUUID();
  const clockOffset = Date.now() - performance.now();
  const serverTime = () => Math.floor(clockOffset + performance.now());
  const receipts = new GatewayReceipts(gatewayId, serverTime);
  const label = machineName().slice(0, 128);
  const deviceFile = devicesFile();
  const deviceStreams = new Map<ServerResponse, { id: string; close(): void }>();
  const webSessions = new Map<string, WebSession>();
  const deviceIsActive = (id: string) => listDevices(deviceFile).some(device => device.id === id);
  const closeRevokedStreams = () => {
    if (!deviceStreams.size && !webSessions.size) return;
    const active = new Set(listDevices(deviceFile).map(device => device.id));
    for (const [key, { principal: { deviceId } }] of webSessions) {
      if (deviceId && !active.has(deviceId)) webSessions.delete(key);
    }
    let revoked = false;
    for (const stream of deviceStreams.values()) {
      if (active.has(stream.id)) continue;
      stream.close();
      revoked = true;
    }
    if (revoked) host.denyUnattendedApprovals();
  };
  const webRoot = opts.webRoot && existsSync(join(opts.webRoot, 'index.html')) ? resolve(opts.webRoot) : undefined;
  // The owner token (gateway.json) or any non-revoked device token (sun gateway token create).
  const bearerPrincipal = (presented?: string): RequestPrincipal | undefined => {
    if (presented === token) return { key: 'owner' };
    const device = matchDevice(presented, deviceFile);
    return device && { key: `device:${device.id}`, deviceId: device.id };
  };
  const sameWebOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    const fetchSite = req.headers['sec-fetch-site'];
    return (!origin || origin === `${opts.tls ? 'https' : 'http'}://${req.headers.host}`)
      && (!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none');
  };
  const sessionFor = (key: string) => {
    const session = webSessions.get(key);
    if (!session || session.expires <= serverTime()) return undefined;
    const { deviceId } = session.principal;
    return !deviceId || deviceIsActive(deviceId) ? session : undefined;
  };
  const authenticate = (req: IncomingMessage, url: URL): (RequestPrincipal & { webKey?: string }) | undefined => {
    const presented = req.headers.authorization?.replace(/^Bearer /, '') ?? url.searchParams.get('token') ?? undefined;
    if (presented !== undefined) return bearerPrincipal(presented);
    if (!sameWebOrigin(req)) return undefined;
    const webKey = webSessionKey(browserCookie(req).value);
    const session = webKey && sessionFor(webKey);
    return session ? { ...session.principal, webKey: webKey || undefined } : undefined;
  };
  const authed = (req: IncomingMessage, url: URL) => !!authenticate(req, url);

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
    // Webhook triggers: the trigger's shared secret (X-Sun-Trigger-Secret) or a gateway/device token.
    const trig = /^\/trigger\/([\w.-]+)$/.exec(url.pathname);
    if (trig && req.method === 'POST') {
      const def = host.config.triggers?.find((t) => t.id === trig[1] && t.kind === 'webhook' && t.enabled !== false);
      if (!def) return send(res, 404, { ok: false, error: 'no such trigger' });
      const secret = def.secretEnv ? process.env[def.secretEnv] : undefined;
      const presented = req.headers['x-sun-trigger-secret'];
      const usesTriggerSecret = secret && presented === secret;
      if (!usesTriggerSecret && !authed(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });
      let body = '';
      for await (const chunk of req) if ((body += chunk).length > 200_000) break;
      if (!usesTriggerSecret && !authed(req, url)) return send(res, 401, { ok: false, error: 'unauthorized' });
      try {
        return send(res, 202, { ok: true, sessionId: await host.fireTrigger(def.id, { payload: body }) });
      } catch (e) {
        return send(res, 500, { ok: false, error: (e as Error).message });
      }
    }
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname === '/api/web-session' && req.method === 'POST') {
        const principal = sameWebOrigin(req) && bearerPrincipal(req.headers.authorization?.replace(/^Bearer /, ''));
        if (!principal) return send(res, 401, { ok: false, error: 'unauthorized' });
        const { name, value } = browserCookie(req);
        const previous = webSessionKey(value);
        if (previous) webSessions.delete(previous);
        const now = serverTime();
        for (const [key, session] of webSessions) if (session.expires <= now) webSessions.delete(key);
        if (webSessions.size >= 1024) return send(res, 503, { ok: false, error: 'GATEWAY_WEB_SESSIONS_BUSY' });
        const credential = randomBytes(32).toString('hex');
        webSessions.set(webSessionKey(credential)!, { principal, expires: now + WEB_SESSION_MS });
        res.setHeader('set-cookie', `${name}=${credential}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=${WEB_SESSION_MS / 1000}${opts.tls ? '; Secure' : ''}`);
        res.setHeader('cache-control', 'no-store');
        return send(res, 200, { ok: true });
      }
      const auth = authenticate(req, url);
      if (!auth) return send(res, 401, { ok: false, error: 'unauthorized' });
      if (req.headers['x-sun-host-id'] !== undefined && req.headers['x-sun-host-id'] !== hostId) {
        return send(res, 409, { ok: false, error: 'GATEWAY_HOST_CHANGED' });
      }
      const authorized = () => auth.webKey ? !!sessionFor(auth.webKey) : !auth.deviceId || deviceIsActive(auth.deviceId);
      if (url.pathname === '/api/health') return send(res, 200, { ok: true, home: sunHome(), version: VERSION, pid: process.pid });
      if (url.pathname === '/api/connection' && req.method === 'GET') {
        if (url.searchParams.get('version') !== String(SETTINGS_PROTOCOL_VERSION)) {
          return send(res, 409, { ok: false, error: 'SETTINGS_PROTOCOL_MISMATCH' });
        }
        const connection: GatewayConnection = {
          hostId, gatewayId, label, protocolVersion: SETTINGS_PROTOCOL_VERSION,
          serverTime: serverTime(), capabilities: host.listCapabilities('web'),
        };
        return send(res, 200, { ok: true, result: connection });
      }
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`data: ${JSON.stringify({ kind: 'notice', level: 'info', text: 'connected' })}\n\n`);
        const release = url.searchParams.get('approver') === '1' ? host.registerApprover(authorized) : () => undefined;
        const write = (text: string) => {
          if (authorized()) res.write(text);
          else {
            cleanup();
            res.destroy();
            host.denyUnattendedApprovals();
          }
        };
        const unsub = host.subscribe(e => write(`data: ${JSON.stringify(e)}\n\n`));
        const beat = setInterval(() => write(': ping\n\n'), 15_000);
        const cleanup = () => {
          clearInterval(beat);
          unsub();
          release();
          deviceStreams.delete(res);
        };
        if (auth.deviceId) deviceStreams.set(res, { id: auth.deviceId, close: () => { cleanup(); res.destroy(); } });
        res.once('close', cleanup);
        closeRevokedStreams();
        return;
      }
      if (url.pathname === '/api/session-bundles' && req.method === 'POST') {
        if (Number(req.headers['content-length']) > BUNDLE_MAX_COMPRESSED_BYTES) {
          res.setHeader('connection', 'close');
          return send(res, 413, { ok: false, error: 'Session bundle exceeds the compressed size limit.' });
        }
        try {
          const result = await host.importSessionBundle(req.iterator({ destroyOnReturn: false }), { cwd: url.searchParams.get('cwd') ?? undefined }, () => {
            if (!authorized()) throw new Error('unauthorized');
          });
          return send(res, 200, { ok: true, result });
        } catch (error) {
          if (!res.destroyed) {
            res.setHeader('connection', 'close');
            return authorized() ? send(res, 400, { ok: false, error: (error as Error).message })
              : send(res, 401, { ok: false, error: 'unauthorized' });
          }
          return;
        }
      }
      const bundleId = /^\/api\/session-bundles\/([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.exec(url.pathname)?.[1];
      if (bundleId && req.method === 'GET') {
        try {
          const bundle = host.exportSessionBundle(bundleId);
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'content-disposition': `attachment; filename="${bundleId}.sunbundle"`,
            'cache-control': 'no-store',
          });
          await pipeline(bundle, res);
        } catch (error) {
          if (!res.headersSent && !res.destroyed) return send(res, 400, { ok: false, error: (error as Error).message });
        }
        return;
      }
      if (url.pathname === '/api/call' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > 2 * BUNDLE_MAX_BYTES + 4096) {
            res.setHeader('connection', 'close');
            return send(res, 413, { ok: false, error: 'Gateway request exceeds the size limit.' });
          }
          chunks.push(chunk);
        }
        const raw = Buffer.concat(chunks, size).toString('utf8');
        let body: { method?: string; args?: unknown[]; requestId?: unknown } | null;
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          return send(res, 400, { ok: false, error: 'invalid JSON' });
        }
        const fn = typeof body?.method === 'string' && Object.hasOwn(methods, body.method) ? methods[body.method] : undefined;
        if (!fn || !body?.method) return send(res, 404, { ok: false, error: `Unknown method ${body?.method}` });
        if (body.args !== undefined && !Array.isArray(body.args)) return send(res, 400, { ok: false, error: 'invalid arguments' });
        if (!authorized()) return send(res, 401, { ok: false, error: 'unauthorized' });
        const args = body.args ?? [];
        const reply = await receipts.dispatch(auth.key, body.requestId, body.method, args, async (): Promise<RpcReply> => {
          if (!authorized()) return { ok: false, error: 'unauthorized' };
          try { return { ok: true, result: await fn(...args) ?? null }; }
          catch (error) { return { ok: false, error: (error as Error)?.message ?? String(error) }; }
        });
        if (!authorized()) return send(res, 401, { ok: false, error: 'unauthorized' });
        return send(res, 200, reply);
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
  let deviceWatcher: FSWatcher | undefined;
  try {
    const watcher = watch(dirname(deviceFile), { persistent: false }, (_event, name) => {
      if (name === null || name === basename(deviceFile)) closeRevokedStreams();
    });
    deviceWatcher = watcher;
    watcher.on('error', () => watcher.close());
  } catch {
    // The live event and heartbeat checks cover unavailable filesystem notifications.
  }
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
        deviceWatcher?.close();
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
  hostId?: string;
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
export function pinnedFetch(target: ClientTarget, path: string, init: { method?: string; headers?: Record<string, string>; body?: string | Readable; signal?: AbortSignal }): Promise<MiniResponse> {
  const url = `${target.url}${path}`;
  if (!url.startsWith('https://') || !target.cert) {
    const request = init.body instanceof Readable
      ? { ...init, body: Readable.toWeb(init.body) as unknown as ReadableStream<Uint8Array>, duplex: 'half' }
      : { ...init, body: init.body };
    return fetch(url, { ...request, redirect: 'error' }) as unknown as Promise<MiniResponse>;
  }
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
          json: () => new Response(body).json(),
        });
      },
    );
    req.on('error', reject);
    if (init.body instanceof Readable) void pipeline(init.body, req).catch(reject);
    else req.end(init.body);
  });
}

/** Thin client for a running gateway: method calls plus a live event stream. */
export class GatewayClient {
  private handshake?: Promise<{ identity: GatewayConnection; clockOffset: number }>;

  constructor(readonly info: ClientTarget) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { authorization: `Bearer ${this.info.token}`,
      ...(this.info.hostId ? { 'x-sun-host-id': this.info.hostId } : {}), ...extra };
  }

  async connection(): Promise<GatewayConnection> {
    const response = await pinnedFetch(this.info, `/api/connection?version=${SETTINGS_PROTOCOL_VERSION}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) throw new Error('Gateway rejected the token (revoked or wrong).');
    const { result, error } = await response.json() as { result?: GatewayConnection; error?: string };
    if (!result) throw new Error(error ?? 'Gateway connection handshake failed.');
    requireSettingsProtocol(result.protocolVersion);
    if (this.info.hostId && result.hostId !== this.info.hostId) throw new Error('GATEWAY_HOST_CHANGED');
    return result;
  }

  async call<T = any>(method: string, ...args: unknown[]): Promise<T> {
    if (!usesGatewayRequestId(method)) return this.dispatch<T>(method, args);
    this.handshake ??= this.connection().then(identity => ({ identity, clockOffset: identity.serverTime - Date.now() })).catch(error => {
      this.handshake = undefined;
      throw error;
    });
    const { identity, clockOffset } = await this.handshake;
    const requestId = `${identity.gatewayId}:${Date.now() + clockOffset}:${randomUUID()}`;
    return this.dispatch<T>(method, args, requestId);
  }

  callBounded<T>(method: string, timeoutMs: number, ...args: unknown[]): Promise<T> {
    return this.dispatch<T>(method, args, undefined, timeoutMs);
  }

  private async dispatch<T>(method: string, args: unknown[], requestId?: string, timeoutMs?: number): Promise<T> {
    const payload = JSON.stringify({ method, args, requestId });
    const invoke = () => pinnedFetch(this.info, '/api/call', {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: payload,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    }).then(async response => {
      if (response.status === 401) return { ok: false, error: 'Gateway rejected the token (revoked or wrong).' };
      return await response.json() as { ok: boolean; result?: T; error?: string };
    });
    const body = requestId ? await invoke().catch(() => invoke()) : await invoke();
    if (body.error === 'GATEWAY_INSTANCE_CHANGED' || body.error === 'GATEWAY_REQUEST_EXPIRED') this.handshake = undefined;
    if (!body.ok) throw new Error(body.error ?? `gateway call ${method} failed`);
    return body.result as T;
  }

  async importSessionBundle(input: Readable, options?: SessionImportOptions): Promise<SessionSummary> {
    const query = options?.cwd ? `?${new URLSearchParams({ cwd: options.cwd })}` : '';
    const response = await pinnedFetch(this.info, `/api/session-bundles${query}`, {
      method: 'POST', body: input,
      headers: this.headers({ 'content-type': 'application/octet-stream' }),
    });
    const body = await response.json() as { ok: boolean; result?: SessionSummary; error?: string };
    if (!body.ok || !body.result) throw new Error(body.error ?? 'Session bundle import failed.');
    return body.result;
  }

  async exportSessionBundle(id: string): Promise<Readable> {
    const response = await pinnedFetch(this.info, `/api/session-bundles/${encodeURIComponent(id)}`, {
      headers: this.headers(),
    });
    if (response.status !== 200 || !response.body) {
      const body = await response.json() as { error?: string };
      throw new Error(body.error ?? 'Session bundle export failed.');
    }
    return Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>);
  }

  /**
   * Stream live events. `approver` makes this connection count as a human who can answer approvals.
   * `onReady` fires once the stream is connected (the gateway's first "connected" notice).
   */
  subscribe(fn: (e: LiveEvent) => void, opts: { approver?: boolean; onReady?: () => void; onState?: (state: GatewayLiveState) => void } = {}): () => void {
    const ctrl = new AbortController();
    let ready = false;
    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await pinnedFetch(this.info, `/api/events?approver=${opts.approver ? 1 : 0}`, {
            headers: this.headers(),
            signal: ctrl.signal,
          });
          if (r.status === 401 || r.status === 409) {
            await r.body?.cancel().catch(() => undefined);
            opts.onState?.(r.status === 401 ? 'unauthorized' : 'identity-changed');
            return;
          }
          if (r.status !== 200) {
            await r.body?.cancel().catch(() => undefined);
            throw new Error('Gateway event stream unavailable.');
          }
          if (!r.body) throw new Error('no event stream');
          for await (const { data } of readSse(r.body)) {
            try {
              const e = JSON.parse(data) as LiveEvent;
              if (e.kind === 'notice' && e.text === 'connected') {
                if (!ready) opts.onReady?.();
                ready = true;
                opts.onState?.('ready');
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
        if (ctrl.signal.aborted) return;
        this.handshake = undefined;
        opts.onState?.('stale');
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
  compact(id: string): Promise<boolean>;
  cost(id: string): CostReport | Promise<CostReport>;
  listCommands(cwd?: string): CustomCommand[] | Promise<CustomCommand[]>;
  exportSession(id: string, format?: 'markdown' | 'html' | 'jsonl'): string | Promise<string>;
  fork(id: string, opts: { beforeSeq: number; restoreFiles?: boolean }): { session: SessionSummary; text: string } | Promise<{ session: SessionSummary; text: string }>;
  contextUsage(id: string): Promise<ContextReport>;
  sessionChanges(id: string, opts?: { fromSeq?: number; toSeq?: number }): FileChange[] | Promise<FileChange[]>;
  reviewSession(id: string): Promise<string>;
  revertFile(id: string, path: string, opts?: { fromSeq?: number }): unknown;
  resolveProposal(id: string, proposalId: string, action: 'create' | 'run' | 'both'): { automation?: Automation } | Promise<{ automation?: Automation }>;
  setSessionFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): SessionSummary | Promise<SessionSummary>;
  send(id: string, text: string, source?: 'user', opts?: { images?: { data: string; mime: string }[]; noDetect?: boolean }): Promise<void>;
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
  send(id: string, text: string, _source?: 'user', opts: { images?: { data: string; mime: string }[]; noDetect?: boolean } = {}) {
    return opts.images?.length || opts.noDetect ? this.client.call<void>('sendMessage', id, text, opts.images ?? [], { noDetect: opts.noDetect }) : this.client.call<void>('send', id, text);
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
  compact(id: string) {
    return this.client.call<boolean>('compact', id);
  }
  cost(id: string) {
    return this.client.call<CostReport>('cost', id);
  }
  listCommands(cwd?: string) {
    return this.client.call<CustomCommand[]>('listCommands', cwd);
  }
  exportSession(id: string, format?: 'markdown' | 'html' | 'jsonl') {
    return this.client.call<string>('exportSession', id, format);
  }
  fork(id: string, opts: { beforeSeq: number; restoreFiles?: boolean }) {
    return this.client.call<{ session: SessionSummary; text: string }>('fork', id, opts.beforeSeq, opts.restoreFiles);
  }
  contextUsage(id: string) {
    return this.client.call<ContextReport>('contextUsage', id);
  }
  sessionChanges(id: string, opts: { fromSeq?: number; toSeq?: number } = {}) {
    return this.client.call<FileChange[]>('sessionChanges', id, opts.fromSeq, opts.toSeq);
  }
  reviewSession(id: string) {
    return this.client.call<string>('reviewSession', id);
  }
  revertFile(id: string, path: string, opts: { fromSeq?: number } = {}) {
    return this.client.call<FileChange>('revertFile', id, path, opts.fromSeq);
  }
  resolveProposal(id: string, proposalId: string, action: 'create' | 'run' | 'both') {
    return this.client.call<{ automation?: Automation }>('resolveProposal', id, proposalId, action);
  }
  setSessionFlags(id: string, flags: { pinned?: boolean; archived?: boolean }) {
    return this.client.call<SessionSummary>('setSessionFlags', id, flags);
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
