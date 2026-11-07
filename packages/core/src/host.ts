import { localDate } from './util/date.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join, relative } from 'node:path';
import { FileState } from './tools/edit.js';
import { detectVerifyCommands } from './verify.js';
import { buildRepoMap } from './repomap.js';
import { BrowserManager, type BrowserInput } from './browser/browser.js';
import { createBrowserTools } from './browser/tools.js';
import { PythonKernel } from './research/python.js';
import { createResearchTools } from './research/tools.js';
import { scanInjection, wrapUntrusted } from './research/taint.js';
import { EXTRACT_SYSTEM, MemoryStore, formatRecall, parseExtraction, type MemoryKind } from './assistant/memstore.js';
import { routeTier } from './assistant/router.js';
import { dingtalkTools } from './assistant/connectors.js';
import { briefingFile, briefingPrompt } from './assistant/briefing.js';
import { TriggerWatchers, renderTrigger } from './assistant/triggers.js';
import { transcribe } from './assistant/voice.js';
import { conversationMetrics, type ModeMetrics } from './assistant/metrics.js';
import { disposeLspClients } from './lsp.js';
import { expandCommand, loadCommands, type CustomCommand } from './ux/commands.js';
import { completePaths, expandMentions, imageMime } from './ux/mentions.js';
import { DEFAULT_PRICING, sessionCost, type CostReport, type ModelPrice } from './ux/pricing.js';
import { sessionToHtml, sessionToMarkdown } from './ux/export.js';
import { createSandbox, secretEnvNames, startAllowlistProxy, type ExecSandbox, type SandboxMode } from './sandbox.js';
import { JobManager, restorableJobIds, type JobResult } from './jobs.js';
import { createWorktree, mergeWorktree, removeWorktree, worktreeDiff, worktreeStatus, type WorktreeInfo, type WorktreeStatus } from './worktree.js';
import { Agent, type AgentHooks, type ApprovalRequest, type RunResult } from './agent.js';
import { availableModels, compactionLimit, contextWindowOf, createProviderFactory, isProviderReady, loadConfig, parseModelRef, providerKey, saveConfig, supportsVision, type ApprovalMode, type ProviderFactory, type SunConfig } from './config.js';
import { createShellHooks } from './hooks.js';
import { HttpKnowledgeProvider } from './kb/company.js';
import { LocalMarkdownKB } from './kb/local.js';
import { HybridKB, openAIEmbedder, type EmbedFn } from './kb/hybrid.js';
import type { KnowledgeProvider } from './kb/types.js';
import { SessionLog } from './log.js';
import { McpManager, type McpServerState } from './mcp.js';
import { readMemory, saveMemoryFact } from './memory.js';
import { BUILTIN_MODES, type ModeDef } from './modes.js';
import { ensureDir, ensureHome, homePath } from './paths.js';
import { loadPlugins, type PluginState } from './plugins.js';
import { buildSystemPrompt } from './prompt.js';
import { findProjectRoot, loadProjectContext } from './rules.js';
import { addSchedule, dueTasks, listSchedules, saveSchedules } from './schedule.js';
import { discoverSkills, loadSkillBody, skillDirs, type Skill } from './skills.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import { SERVICE_TOOLS } from './tools/services.js';
import type { Tool, ToolServices } from './tools/types.js';
import type { ApprovalDecision, LiveEvent, PendingApproval, SessionEvent, SessionEventBody, SessionSummary, TodoItem } from './types.js';
import { analyzeIntelDay, listIntelReports, loadIntelState, runIntel, type IntelRunResult } from './intel.js';
import { reflectSession, type Proposal } from './evolution.js';

export interface HostOptions {
  providerFactory?: ProviderFactory;
  config?: SunConfig;
  loadPlugins?: boolean;
  connectMcp?: boolean;
  shellHooks?: boolean;
  /** Override the embedding function (tests). */
  embedder?: EmbedFn;
}

export interface CreateSessionInput {
  cwd?: string;
  mode?: string;
  model?: string;
  title?: string;
  parent?: string;
  /** Run in an isolated git worktree on a new branch (coding sessions in a git repo). */
  worktree?: boolean;
  /** Approval mode for this session only (default: config.approval). */
  approval?: ApprovalMode;
  /** Shell sandbox for this session only (default: config.sandbox.mode). */
  sandbox?: SandboxMode;
}

const AUTO_RESUME_REASONS = new Set(['quota', 'rate_limit', 'network']);

/** Turn the numbered or bulleted steps of a plan into todo items. */
export function planTodos(plan: string): TodoItem[] {
  const steps = plan
    .split('\n')
    .map((l) => /^\s*(?:\d+[.)]|[-*]\s+\[[ x]\]|[-*])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x && x.length > 3)
    .slice(0, 20);
  return steps.map((content, i) => ({ id: String(i + 1), content, status: i === 0 ? 'in_progress' : 'pending' }));
}

export class HarnessHost {
  config: SunConfig;
  private factory: ProviderFactory;
  private readonly opts: HostOptions;
  private modes = new Map<string, ModeDef>(BUILTIN_MODES.map((m) => [m.id, m]));
  private pluginTools: Tool[] = [];
  private pluginKnowledge: KnowledgeProvider[] = [];
  private promptSections: { title: string; text: () => string }[] = [];
  private pluginListeners: ((sessionId: string, e: SessionEvent) => void)[] = [];
  private listeners = new Set<(e: LiveEvent) => void>();
  private runs = new Map<string, { controller: AbortController; promise: Promise<RunResult> }>();
  private queued = new Map<string, Parameters<SessionLog['append']>[0][]>();
  private approvals = new Map<string, { pending: PendingApproval; resolve: (d: ApprovalDecision) => void }>();
  private mcp = new Map<string, McpManager>();
  private personalKb: LocalMarkdownKB;
  private hybridKb?: HybridKB;
  readonly jobs = new JobManager(
    (job) => this.append(SessionLog.open(job.sessionId), { type: 'job/started', jobId: job.id, name: job.name, command: job.command }),
    (r) => this.deliverJob(r),
  );
  private timer?: NodeJS.Timeout;
  pluginStates: PluginState[] = [];

  constructor(opts: HostOptions = {}) {
    ensureHome();
    this.opts = opts;
    this.config = opts.config ?? loadConfig();
    this.factory = opts.providerFactory ?? createProviderFactory(this.config);
    this.personalKb = new LocalMarkdownKB(this.config.kb.roots);
    this.hybridKb = this.makeHybrid();
  }

  /** Hybrid KB when embeddings are enabled and their provider is configured. */
  private makeHybrid(): HybridKB | undefined {
    const e = this.config.kb.embeddings;
    if (!e?.enabled) return undefined;
    const { provider, model } = parseModelRef(e.model);
    const p = this.config.providers[provider];
    if (!p || p.type !== 'openai') return undefined;
    return new HybridKB(this.personalKb, {
      embed: this.opts.embedder ?? openAIEmbedder({ baseUrl: p.baseUrl, apiKey: providerKey(p), model, dimensions: e.dimensions }),
      model: e.model,
    });
  }

  async init(): Promise<void> {
    const restorable = new Set(restorableJobIds());
    for (const s of SessionLog.list()) {
      if (s.status === 'running' || s.status === 'awaiting_approval') {
        SessionLog.open(s.id).append({ type: 'run/status', status: 'paused', reason: 'interrupted', detail: 'The app stopped during a run.' });
      }
      const log = SessionLog.open(s.id);
      const open = new Map<string, string>();
      for (const e of log.all()) {
        if (e.type === 'job/started') open.set(e.jobId, e.name);
        else if (e.type === 'job/finished') open.delete(e.jobId);
      }
      for (const [jobId, name] of open) if (!restorable.has(jobId)) log.append({ type: 'job/finished', jobId, name, state: 'lost' });
    }
    // Re-attach after the cleanup above: a job that already finished is delivered (and may start a run) right away.
    this.jobs.restore();
    if (this.opts.loadPlugins !== false) await this.reloadPlugins();
  }

  // ---------- live events ----------

  subscribe(fn: (e: LiveEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private broadcast(e: LiveEvent): void {
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        // Listener errors never break the run.
      }
    }
    if (e.kind === 'event') {
      for (const pl of this.pluginListeners) {
        try {
          pl(e.sessionId, e.event);
        } catch {
          // ignore
        }
      }
      if (e.event.type === 'run/status' || e.event.type === 'session/title' || e.event.type === 'model/switch') this.broadcastSessions();
    }
  }

  private broadcastSessions(): void {
    this.broadcast({ kind: 'sessions', sessions: this.listSessions() });
  }

  private broadcastApprovals(): void {
    this.broadcast({ kind: 'approvals', approvals: this.pendingApprovals() });
  }

  // ---------- config & models ----------

  reloadConfig(): SunConfig {
    this.config = loadConfig();
    if (!this.opts.providerFactory) this.factory = createProviderFactory(this.config);
    this.personalKb = new LocalMarkdownKB(this.config.kb.roots);
    this.hybridKb = this.makeHybrid();
    return this.config;
  }

  updateConfig(patch: Partial<SunConfig>): SunConfig {
    saveConfig(patch);
    return this.reloadConfig();
  }

  listModels(): { ref: string; provider: string; ready: boolean; contextWindow: number }[] {
    const out: { ref: string; provider: string; ready: boolean; contextWindow: number }[] = [];
    for (const [id, p] of Object.entries(this.config.providers)) {
      for (const m of p.models) out.push({ ref: `${id}/${m}`, provider: id, ready: isProviderReady(p), contextWindow: contextWindowOf(this.config, `${id}/${m}`) });
    }
    return out;
  }

  readyModels(): string[] {
    return availableModels(this.config);
  }

  listModes(): { id: string; label: string; description: string }[] {
    return [...this.modes.values()].map(({ id, label, description }) => ({ id, label, description }));
  }

  // ---------- sessions ----------

  listSessions(): SessionSummary[] {
    return SessionLog.list().map((s) => (this.runs.has(s.id) && s.status === 'idle' ? { ...s, status: 'running' } : s));
  }

  getEvents(id: string): SessionEvent[] {
    return [...SessionLog.open(id).all()];
  }

  defaultCwd(mode: string): string {
    if ((mode === 'coding' || mode === 'plan') && process.cwd() !== '/') return process.cwd();
    const dir = homePath('workspace');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  createSession(input: CreateSessionInput = {}): SessionSummary {
    const mode = input.mode && this.modes.has(input.mode) ? input.mode : 'coding';
    let cwd = input.cwd && existsSync(input.cwd) ? input.cwd : this.defaultCwd(mode);
    const worktree = input.worktree ? createWorktree(cwd, randomUUID().slice(0, 8)) : undefined;
    if (worktree) {
      // Keep the same sub-folder inside the worktree when the session started below the repo root.
      const sub = relative(realpathSync(worktree.repo), realpathSync(cwd));
      cwd = sub && !sub.startsWith('..') ? join(worktree.path, sub) : worktree.path;
    }
    const log = SessionLog.create({ mode, cwd, model: input.model || this.config.defaultModel, title: input.title, parent: input.parent, worktree, approval: input.approval, sandbox: input.sandbox });
    this.broadcastSessions();
    return log.summary()!;
  }

  deleteSession(id: string): void {
    this.abort(id);
    this.sandboxes.get(id)?.dispose?.();
    this.sandboxes.delete(id);
    void this.browser.closeTab(id);
    this.kernels.get(id)?.dispose();
    this.kernels.delete(id);
    SessionLog.delete(id);
    this.broadcastSessions();
  }

  renameSession(id: string, title: string): void {
    this.append(SessionLog.open(id), { type: 'session/title', title });
  }

  private append(log: SessionLog, body: Parameters<SessionLog['append']>[0]): SessionEvent {
    const event = log.append(body);
    this.broadcast({ kind: 'event', sessionId: log.id, event });
    return event;
  }

  isRunning(id: string): boolean {
    return this.runs.has(id);
  }

  /** Send a user message. If a run is active, the message is queued and delivered when it ends. */
  async send(id: string, text: string, source: 'user' | 'schedule' | 'system' | 'job' | 'verify' | 'trigger' = 'user', opts: { images?: { data: string; mime: string }[] } = {}): Promise<void> {
    const log = SessionLog.open(id);
    if (!log.meta()) throw new Error(`No session ${id}`);
    const body = this.prepareUserMessage(log, text, source, opts.images ?? []);
    if (this.runs.has(id)) {
      this.queued.set(id, [...(this.queued.get(id) ?? []), body]);
      return;
    }
    const closed = log.last('worktree/closed');
    if (closed) throw new Error(`This session's worktree was ${closed.action}; start a new session to continue.`);
    if (!log.all().some((e) => e.type === 'user/message') && this.opts.shellHooks !== false) {
      const ctx = await createShellHooks(log.meta()!.cwd).sessionStart(id);
      if (ctx) this.append(log, { type: 'user/message', text: `[sessionStart hook context]\n${ctx}`, source: 'hook' });
    }
    if (source === 'user') this.recallMemories(log, text);
    this.append(log, body);
    if (log.meta()!.title === 'New session' && !log.last('session/title')) {
      const t = text.replace(/\s+/g, ' ').trim();
      this.append(log, { type: 'session/title', title: t.length > 60 ? t.slice(0, 57) + '...' : t || 'Untitled' });
    }
    this.startRun(id);
  }

  /**
   * Turn what the user typed into the logged message: a custom /command expands to its prompt (and may switch mode or
   * model), @mentions attach files, and images are copied into ~/.sun/attachments so the log stays reconstructable.
   */
  private prepareUserMessage(log: SessionLog, text: string, source: NonNullable<Extract<SessionEvent, { type: 'user/message' }>['source']>, images: { data: string; mime: string }[]): Extract<SessionEventBody, { type: 'user/message' }> {
    if (source !== 'user') return { type: 'user/message', text, source };
    const cwd = log.meta()!.cwd;
    let body = text;
    let command: { name: string; input: string } | undefined;
    const cmd = text.trim().startsWith('/') ? expandCommand(text, loadCommands(cwd)) : undefined;
    if (cmd) {
      body = cmd.prompt;
      command = { name: cmd.command.name, input: text };
      if (cmd.command.mode && this.modes.has(cmd.command.mode) && cmd.command.mode !== log.currentMode()) this.append(log, { type: 'mode/switch', from: log.currentMode(), to: cmd.command.mode });
      if (cmd.command.model && cmd.command.model !== log.currentModel()) this.append(log, { type: 'model/switch', from: log.currentModel(), to: cmd.command.model, reason: `/${cmd.command.name}` });
    }
    const m = expandMentions(body, cwd);
    const dir = ensureDir(homePath('attachments', log.id));
    let n = readdirSync(dir).length;
    const stored: { path: string; mime: string }[] = [];
    for (const f of m.images) {
      const p = join(dir, `${++n}${extname(f).toLowerCase()}`);
      copyFileSync(f, p);
      stored.push({ path: p, mime: imageMime(f)! });
    }
    for (const i of images) {
      const ext = i.mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png';
      const p = join(dir, `${++n}.${ext}`);
      writeFileSync(p, Buffer.from(i.data, 'base64'));
      stored.push({ path: p, mime: i.mime });
    }
    return { type: 'user/message', text: m.text, source, ...(stored.length ? { images: stored } : {}), ...(command ? { command } : {}) };
  }

  /** Base64 of an image attachment (only files under ~/.sun/attachments), for thumbnails in the UI. */
  readAttachment(path: string): { data: string; mime: string } {
    const root = realpathSync(ensureDir(homePath('attachments')));
    const abs = realpathSync(path);
    if (!abs.startsWith(root + '/')) throw new Error('Not an attachment.');
    return { data: readFileSync(abs).toString('base64'), mime: imageMime(abs) ?? 'application/octet-stream' };
  }

  listCommands(cwd?: string): CustomCommand[] {
    return loadCommands(cwd ?? process.cwd());
  }

  completePaths(cwd: string, query: string): string[] {
    return completePaths(cwd, query);
  }

  /** Estimated cost from logged usage and the pricing table (config.pricing overrides the defaults). */
  cost(sessionId: string): CostReport {
    return sessionCost(SessionLog.open(sessionId).all(), { ...DEFAULT_PRICING, ...(this.config.pricing ?? {}) });
  }

  /** /compact: summarize older history now. */
  async compact(sessionId: string): Promise<boolean> {
    if (this.runs.has(sessionId)) throw new Error('Wait for the run to finish (or stop it) before compacting.');
    const agent = await this.buildAgent(SessionLog.open(sessionId), new AbortController());
    return agent.compactNow(new AbortController().signal);
  }

  /**
   * Rewind: a new session with the conversation before the user message at `beforeSeq` (the log is append-only, so the
   * original stays intact). With restoreFiles, file edits made from that message on are undone first.
   */
  fork(sessionId: string, opts: { beforeSeq: number; restoreFiles?: boolean }): { session: SessionSummary; text: string } {
    if (this.runs.has(sessionId)) throw new Error('Stop the run before rewinding.');
    const src = SessionLog.open(sessionId);
    const meta = src.meta();
    if (!meta) throw new Error(`No session ${sessionId}`);
    const target = src.all().find((e) => e.seq === opts.beforeSeq);
    if (!target || target.type !== 'user/message') throw new Error('Rewind needs the position of a user message.');
    if (opts.restoreFiles) {
      const later = this.listCheckpoints(sessionId).filter((c) => !c.undone && (src.all().find((e) => e.type === 'checkpoint' && e.id === c.id)?.seq ?? -1) > opts.beforeSeq);
      if (later.length) this.undo(sessionId, { to: later[0].id });
    }
    const before = src.all().filter((e) => e.seq < opts.beforeSeq);
    const at = (type: 'mode/switch' | 'model/switch') => [...before].reverse().find((e) => e.type === type) as { to: string } | undefined;
    const title = ([...before].reverse().find((e) => e.type === 'session/title') as { title: string } | undefined)?.title ?? meta.title;
    const log = SessionLog.create({ title: `${title} (rewound)`, mode: at('mode/switch')?.to ?? meta.mode, cwd: meta.cwd, model: at('model/switch')?.to ?? meta.model, approval: meta.approval, sandbox: meta.sandbox, forkOf: { session: sessionId, seq: opts.beforeSeq } });
    for (const e of before) {
      if (e.type === 'session/meta' || e.type === 'run/status' || e.type === 'session/title') continue;
      const { seq: _s, ...body } = e;
      log.append(body as SessionEventBody);
      if (e.type === 'checkpoint') {
        const f = homePath('checkpoints', sessionId, `${e.id}.json`);
        if (existsSync(f)) {
          ensureDir(homePath('checkpoints', log.id));
          copyFileSync(f, homePath('checkpoints', log.id, `${e.id}.json`));
        }
      }
    }
    this.broadcastSessions();
    return { session: log.summary()!, text: target.command?.input ?? target.text };
  }

  exportSession(sessionId: string, format: 'markdown' | 'html' | 'jsonl' = 'markdown'): string {
    const log = SessionLog.open(sessionId);
    if (!log.meta()) throw new Error(`No session ${sessionId}`);
    if (format === 'jsonl') return readFileSync(log.file, 'utf8');
    return format === 'html' ? sessionToHtml(log.all()) : sessionToMarkdown(log.all());
  }

  /** Import a session exported as JSONL (new id; events and timestamps kept). */
  importSession(jsonl: string): SessionSummary {
    const events = jsonl
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as SessionEvent);
    const meta = events.find((e) => e.type === 'session/meta') as Extract<SessionEvent, { type: 'session/meta' }> | undefined;
    if (!meta) throw new Error('Not a sun-harness session export (no session/meta line).');
    const log = SessionLog.create({ title: meta.title, mode: meta.mode, cwd: existsSync(meta.cwd) ? meta.cwd : this.defaultCwd(meta.mode), model: meta.model, approval: meta.approval });
    for (const e of events) {
      if (e.type === 'session/meta') continue;
      const { seq: _s, ...body } = e;
      log.append(body as SessionEventBody);
    }
    this.broadcastSessions();
    return log.summary()!;
  }

  /** Full-text search over session titles and messages. */
  searchSessions(query: string, limit = 30): { id: string; title: string; mode: string; updatedAt: string; snippet: string }[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: { id: string; title: string; mode: string; updatedAt: string; snippet: string; rank: number }[] = [];
    for (const s of this.listSessions()) {
      if (s.title.toLowerCase().includes(q)) {
        out.push({ id: s.id, title: s.title, mode: s.mode, updatedAt: s.updatedAt, snippet: s.title, rank: 0 });
        continue;
      }
      for (const e of SessionLog.open(s.id).all()) {
        const text = e.type === 'user/message' || e.type === 'assistant/message' ? e.text : '';
        const i = text.toLowerCase().indexOf(q);
        if (i >= 0) {
          out.push({ id: s.id, title: s.title, mode: s.mode, updatedAt: s.updatedAt, snippet: `${i > 40 ? '…' : ''}${text.slice(Math.max(0, i - 40), i + q.length + 60).replace(/\s+/g, ' ')}…`, rank: 1 });
          break;
        }
      }
      if (out.length >= limit * 2) break;
    }
    return out.sort((a, b) => a.rank - b.rank).slice(0, limit).map(({ rank: _r, ...x }) => x);
  }

  /** Resume a paused/errored/aborted session, optionally on another model (quota recovery path). */
  resume(id: string, opts: { model?: string } = {}): void {
    if (this.runs.has(id)) return;
    const log = SessionLog.open(id);
    if (opts.model && opts.model !== log.currentModel()) this.switchModel(id, opts.model, 'user resume');
    this.startRun(id);
  }

  switchModel(id: string, model: string, reason = 'user'): void {
    const log = SessionLog.open(id);
    const from = log.currentModel();
    if (from !== model) this.append(log, { type: 'model/switch', from, to: model, reason });
  }

  switchMode(id: string, mode: string): void {
    if (!this.modes.has(mode)) throw new Error(`Unknown mode ${mode}`);
    const log = SessionLog.open(id);
    const from = log.currentMode();
    if (from !== mode) this.append(log, { type: 'mode/switch', from, to: mode });
    this.broadcastSessions();
  }

  abort(id: string): void {
    this.queued.delete(id);
    this.runs.get(id)?.controller.abort();
  }

  /** Await the current run of a session (if any). */
  async wait(id: string): Promise<RunResult | undefined> {
    let last: RunResult | undefined;
    while (this.runs.has(id)) last = await this.runs.get(id)!.promise;
    return last;
  }

  private startRun(id: string, parentSignal?: AbortSignal): Promise<RunResult> {
    const controller = new AbortController();
    if (parentSignal) parentSignal.addEventListener('abort', () => controller.abort(), { once: true });
    const promise = (async () => {
      const agent = await this.buildAgent(SessionLog.open(id), controller);
      return agent.run(controller.signal);
    })();
    this.runs.set(id, { controller, promise });
    this.broadcastSessions();
    promise
      .then((r) => {
        if (r?.status === 'idle') this.extractMemories(id).catch(() => undefined);
      })
      .catch(() => undefined)
      .finally(() => {
        this.runs.delete(id);
        const q = this.queued.get(id);
        if (q?.length) {
          this.queued.delete(id);
          const log = SessionLog.open(id);
          for (const b of q) this.append(log, b);
          this.startRun(id);
        } else this.broadcastSessions();
      });
    return promise;
  }

  private async buildAgent(log: SessionLog, controller: AbortController): Promise<Agent> {
      const id = log.id;
      const cwd = log.meta()!.cwd;
      await this.ensureProxy();
      const tools = await this.toolsFor(log);
      const hooks: AgentHooks | undefined = this.opts.shellHooks === false ? undefined : createShellHooks(cwd);
      return new Agent({
        log,
        config: this.config,
        resolveModel: (ref) => this.factory(ref),
        tools: () => tools.filter((t) => this.modeAllows(log.currentMode(), t, !!log.meta()?.parent)),
        systemPrompt: (modelRef) => this.systemPrompt(log, modelRef),
        approvalMode: () => log.meta()?.approval ?? this.config.approval,
        routeModel: (ref) => (ref === 'auto' ? this.routeAuto(log) : ref),
        vision: (ref) => supportsVision(this.config, ref),
        policy: () => {
          const taints = log.all().filter((e): e is Extract<SessionEvent, { type: 'context/taint' }> => e.type === 'context/taint');
          return {
            sandboxedShell: this.config.sandbox.autoApprove && this.sandboxFor(log).kind !== 'none',
            tainted: taints.length > 0,
            injected: this.config.taint.enabled && taints.some((t) => t.findings.length > 0),
          };
        },
        contextLimit: (ref) => compactionLimit(this.config, ref),
        verify:
          this.config.verify?.enabled
            ? { commands: (dir) => (log.currentMode() === 'coding' ? detectVerifyCommands(dir) : []), maxAttempts: this.config.verify.maxAttempts, timeoutMs: this.config.verify.timeoutMs, sandbox: () => this.sandboxFor(log) }
            : undefined,
        requestApproval: (req, signal) => this.requestApproval(req, log.meta()?.parent ?? id, signal),
        services: this.services(log, controller.signal),
        hooks,
        onLive: (e) => this.broadcast(e),
      });
  }

  private modeAllows(modeId: string, t: Tool, isChild: boolean): boolean {
    if (isChild && t.name === 'task') return false;
    const mode = this.modes.get(modeId) ?? this.modes.get('coding')!;
    return !mode.allowTool || mode.allowTool(t);
  }

  private async toolsFor(log: SessionLog): Promise<Tool[]> {
    const cwd = log.meta()!.cwd;
    const mcpTools = this.opts.connectMcp === false || !this.config.mcp.enabled ? [] : (await this.mcpFor(cwd)).listTools();
    const byName = new Map<string, Tool>();
    const promote = this.config.jobs?.promoteAfterMs ?? 0;
    const slowSafe = mcpTools.map((t) => ({
      ...t,
      execute: (args: unknown, ctx: Parameters<Tool['execute']>[1]) => this.jobs.promoteIfSlow(ctx.sessionId, t.name, args, () => t.execute(args, ctx), promote),
    }));
    for (const t of [...BUILTIN_TOOLS, ...this.researchTools, ...SERVICE_TOOLS, ...this.browserTools, ...this.connectorTools, ...this.pluginTools, ...slowSafe]) byName.set(t.name, t);
    // Capability gating: drop tools whose backend is unreachable right now.
    const all = [...byName.values()];
    const ok = await Promise.all(all.map((t) => (t.available ? t.available().catch(() => false) : Promise.resolve(true))));
    return all.filter((_, i) => ok[i]);
  }

  private repoMaps = new Map<string, string>();

  // ---------- browser ----------

  private lastFrame = new Map<string, number>();
  readonly browser = new BrowserManager(
    () => this.config.browser,
    (f) => {
      // At most ~4 frames per second per session over IPC/SSE.
      const now = Date.now();
      if (now - (this.lastFrame.get(f.sessionId) ?? 0) < 250) return;
      this.lastFrame.set(f.sessionId, now);
      this.broadcast({ kind: 'browser', sessionId: f.sessionId, frame: f.data, width: f.width, height: f.height, url: f.url, title: f.title, takeover: this.browser.isTakenOver(f.sessionId) });
    },
  );
  private browserTools = createBrowserTools(this.browser);

  // ---------- assistant: memory, routing, briefing, triggers, voice, metrics ----------

  readonly memoryStore = new MemoryStore();
  private connectorTools = dingtalkTools();
  private triggerWatchers = new TriggerWatchers();

  /** Attach relevant long-term memories before a user message (logged, so the model's view is reproducible). */
  private recallMemories(log: SessionLog, text: string): void {
    const m = this.config.memory;
    if (!m || !m.recallModes.includes(log.currentMode())) return;
    const already = new Set(
      log
        .all()
        .filter((e) => e.type === 'user/message' && e.source === 'memory')
        .flatMap((e) => [...(e as { text: string }).text.matchAll(/\(id (m_[\w]+)\)/g)].map((x) => x[1])),
    );
    const hits = this.memoryStore.search(text, m.recallK).filter((h) => !already.has(h.item.id));
    if (!hits.length) return;
    this.memoryStore.touch(hits.map((h) => h.item.id));
    this.append(log, { type: 'user/message', source: 'memory', text: `${formatRecall(hits)}\n${hits.map((h) => `(id ${h.item.id})`).join(' ')}` });
  }

  /** The model for harness-internal calls: router.background when it is ready, else the given model. */
  backgroundModel(fallback: string): string {
    const bg = this.config.router?.background;
    return bg && this.readyModels().includes(bg) ? bg : fallback;
  }

  /** "auto" sessions: fast model for light turns, strong model for hard ones (both must be configured and ready). */
  private routeAuto(log: SessionLog): string {
    const r = this.config.router ?? {};
    const ready = this.readyModels();
    const fast = r.fast && ready.includes(r.fast) ? r.fast : undefined;
    const strong = r.strong && ready.includes(r.strong) ? r.strong : undefined;
    const fallback = this.config.defaultModel === 'auto' ? ready[0] : this.config.defaultModel;
    if (!fast && !strong) return fallback;
    const ev = log.all();
    const lastUser = [...ev].reverse().find((e) => e.type === 'user/message' && (!e.source || e.source === 'user')) as { text: string; seq: number } | undefined;
    const since = ev.filter((e) => e.seq > (lastUser?.seq ?? -1));
    const tier = routeTier({
      text: lastUser?.text ?? '',
      recentToolErrors: since.filter((e) => e.type === 'tool/result' && e.isError).length,
      steps: since.filter((e) => e.type === 'assistant/message').length,
    });
    return (tier === 'strong' ? (strong ?? fast) : (fast ?? strong)) ?? fallback;
  }

  /** Mine a finished run for durable memories with a background model call; logs memory/extract. */
  async extractMemories(sessionId: string): Promise<{ added: number }> {
    const m = this.config.memory;
    const log = SessionLog.open(sessionId);
    if (!m?.autoExtract || !m.extractModes.includes(log.currentMode()) || log.meta()?.parent) return { added: 0 };
    const ev = log.all();
    const lastExtract = [...ev].reverse().find((e) => e.type === 'memory/extract')?.seq ?? -1;
    const fresh = ev.filter((e) => e.seq > lastExtract);
    if (!fresh.some((e) => e.type === 'user/message' && (!e.source || e.source === 'user'))) return { added: 0 };
    const transcript = fresh
      .filter((e) => (e.type === 'user/message' && e.source !== 'memory') || (e.type === 'assistant/message' && e.text))
      .map((e) => (e.type === 'user/message' ? `User: ${e.text}` : `Assistant: ${(e as { text: string }).text}`))
      .join('\n\n')
      .slice(-8000);
    const known = this.memoryStore.search(transcript, 12, 0.1).map((h) => `- ${h.item.text}`);
    const model = this.backgroundModel(log.currentModel() === 'auto' ? this.routeAuto(log) : log.currentModel());
    const text = await this.complete(EXTRACT_SYSTEM, `Known:\n${[readMemory().slice(0, 3000), ...known].join('\n') || '(nothing yet)'}\n\nConversation:\n${transcript}`, model);
    const parsed = parseExtraction(text);
    const added: { id: string; text: string; kind: string }[] = [];
    for (const x of parsed.memories.slice(0, 8)) {
      if (x.core) {
        if (saveMemoryFact(x.text, 'Profile') !== 'Already remembered.') added.push({ id: 'core', text: x.text, kind: 'core' });
        continue;
      }
      const r = this.memoryStore.add(x.text, x.kind, sessionId);
      if (!r.duplicate) added.push({ id: r.item.id, text: r.item.text, kind: r.item.kind });
    }
    if (parsed.episode) this.memoryStore.add(`${localDate(new Date())}: ${parsed.episode}`, 'episode', sessionId);
    this.append(log, { type: 'memory/extract', added, ...(parsed.episode ? { episode: parsed.episode } : {}), model });
    return { added: added.length };
  }

  /** Run today's briefing in a new assistant session, save it, and announce it (desktop notice, bot chats). */
  async runBriefing(now = new Date()): Promise<{ date: string; path: string; sessionId: string; text: string }> {
    const date = localDate(now);
    const intel = listIntelReports().find((r) => r.date === date && !r.pending);
    const s = this.createSession({ mode: 'assistant', title: `[briefing] ${date}` });
    const dingtalk = await this.connectorTools[0].available!().catch(() => false);
    await this.send(s.id, briefingPrompt(date, { dingtalk, intelDate: intel?.date, extra: this.config.briefing?.extra }), 'schedule');
    await this.wait(s.id);
    const text = SessionLog.open(s.id).last('assistant/message')?.text?.trim() || '(The briefing run produced no text.)';
    const path = briefingFile(date);
    ensureDir(dirname(path));
    writeFileSync(path, `# Briefing ${date}\n\n${text}\n`);
    this.broadcast({ kind: 'briefing', date, path, text });
    this.broadcast({ kind: 'notice', level: 'info', text: `Daily briefing for ${date} is ready.` });
    return { date, path, sessionId: s.id, text };
  }

  private briefingRunning?: Promise<unknown>;

  private async briefingCatchUp(now: Date): Promise<void> {
    const b = this.config.briefing;
    if (!b?.enabled || this.briefingRunning) return;
    if (now.getHours() * 60 + now.getMinutes() < b.hour * 60 + b.minute) return;
    if (existsSync(briefingFile(localDate(now)))) return;
    this.briefingRunning = this.runBriefing(now).finally(() => (this.briefingRunning = undefined));
  }

  /** Start a session for a trigger; webhook payloads are external content (wrapped, scanned, logged as taint). */
  async fireTrigger(id: string, vars: { files?: string[]; payload?: string }): Promise<string> {
    const t = this.config.triggers.find((x) => x.id === id && x.enabled !== false);
    if (!t) throw new Error(`No enabled trigger ${id}`);
    const s = this.createSession({ mode: t.mode ?? 'assistant', cwd: t.cwd ?? (t.kind === 'watch' ? t.path : undefined), title: `[trigger] ${t.id}` });
    const log = SessionLog.open(s.id);
    let payload = vars.payload;
    if (payload !== undefined) {
      const findings = scanInjection(payload);
      this.append(log, { type: 'context/taint', tool: `trigger:${t.id}`, findings });
      payload = wrapUntrusted(`trigger:${t.id}`, payload.slice(0, 50_000), findings);
    }
    await this.send(s.id, renderTrigger(t, { files: vars.files, payload }), 'trigger');
    return s.id;
  }

  startTriggers(): void {
    this.triggerWatchers.start(this.config.triggers ?? [], (t, files) => void this.fireTrigger(t.id, { files }).catch(() => undefined));
  }

  /** Speech to text with config.voice.stt (a provider/model ref). */
  async transcribe(audioBase64: string, mime: string): Promise<string> {
    const ref = this.config.voice?.stt ?? 'qwen/qwen3-asr-flash';
    const [pid, ...rest] = ref.split('/');
    const p = this.config.providers[pid];
    if (!p) throw new Error(`Unknown provider in voice.stt: ${ref}`);
    return transcribe(Buffer.from(audioBase64, 'base64'), mime, { baseUrl: p.baseUrl, apiKey: providerKey(p), model: rest.join('/') });
  }

  metrics(days = 7): ModeMetrics[] {
    const since = Date.now() - days * 86_400_000;
    const sessions = this.listSessions()
      .filter((s) => Date.parse(s.updatedAt) >= since && !s.title.startsWith('[eval]'))
      .map((s) => ({ mode: s.mode, events: SessionLog.open(s.id).all() }));
    return conversationMetrics(sessions);
  }

  // ---------- research ----------

  private kernels = new Map<string, PythonKernel>();
  private researchTools = createResearchTools({
    search: () => this.config.search,
    kernel: (sessionId, cwd) => {
      let k = this.kernels.get(sessionId);
      if (!k) this.kernels.set(sessionId, (k = new PythonKernel(cwd, this.sandboxFor(SessionLog.open(sessionId)))));
      return k;
    },
  });

  /** Files the session created or changed in its workspace (from checkpoints), plus screenshots and figures. */
  deliverables(sessionId: string): { path: string; abs: string; created: boolean; size: number; mtime: string }[] {
    const log = SessionLog.open(sessionId);
    const cwd = log.meta()!.cwd;
    const seen = new Map<string, boolean>();
    for (const e of log.all()) {
      if (e.type !== 'checkpoint') continue;
      try {
        const snap = JSON.parse(readFileSync(homePath('checkpoints', sessionId, `${e.id}.json`), 'utf8')) as { files: { path: string; before: string | null }[] };
        for (const f of snap.files) if (!seen.has(f.path)) seen.set(f.path, f.before === null);
      } catch {
        for (const f of e.files) if (!seen.has(f)) seen.set(f, false);
      }
    }
    for (const dir of ['screenshots', 'figures']) {
      const d = join(cwd, dir);
      if (existsSync(d)) for (const f of readdirSync(d)) if (!seen.has(join(d, f))) seen.set(join(d, f), true);
    }
    return [...seen.entries()]
      .filter(([p]) => existsSync(p))
      .map(([p, created]) => {
        const st = statSync(p);
        return { path: relative(cwd, p) || p, abs: p, created, size: st.size, mtime: st.mtime.toISOString() };
      })
      .sort((a, b) => b.mtime.localeCompare(a.mtime));
  }

  browserInfo(sessionId?: string): { available: boolean; description: string; active: boolean; takeover: boolean; vncUrl?: string } {
    return {
      available: this.browser.available(),
      description: this.browser.describe(),
      active: sessionId ? this.browser.hasTab(sessionId) : false,
      takeover: sessionId ? this.browser.isTakenOver(sessionId) : false,
      vncUrl: this.browser.vncUrl,
    };
  }

  /** Start or stop streaming the session's tab to clients (live view). */
  async browserView(sessionId: string, on: boolean): Promise<void> {
    await this.browser.setScreencast(sessionId, on);
  }

  /** A human takes the browser (agent browser tools wait) or hands it back. Logged: the model is told. */
  browserTakeover(sessionId: string, on: boolean): void {
    if (this.browser.isTakenOver(sessionId) === on) return;
    this.browser.setTakeover(sessionId, on);
    this.append(SessionLog.open(sessionId), { type: 'browser/takeover', on });
    this.broadcast({ kind: 'browser', sessionId, takeover: on });
  }

  browserInput(sessionId: string, ev: BrowserInput): Promise<void> {
    return this.browser.input(sessionId, ev);
  }
  private sandboxes = new Map<string, ExecSandbox>();
  private proxy?: { port: number; server: import('node:http').Server };
  /** Hosts the allowlist proxy refused (shown by `sun sandbox status`). */
  readonly blockedHosts = new Set<string>();

  /** The session's shell sandbox (created once per session; Docker containers start on first use). */
  sandboxFor(log: SessionLog): ExecSandbox {
    let sb = this.sandboxes.get(log.id);
    if (!sb) {
      const meta = log.meta()!;
      try {
        sb = createSandbox({
          mode: meta.sandbox ?? this.config.sandbox.mode,
          cfg: this.config.sandbox,
          sessionId: log.id,
          cwd: meta.cwd,
          secretEnv: secretEnvNames(this.config),
          proxyPort: () => this.proxy?.port,
        });
      } catch (e) {
        // An explicitly requested sandbox that is unavailable must not silently fall back to running unsandboxed.
        const msg = `Shell sandbox unavailable: ${(e as Error).message}`;
        sb = { kind: 'docker', describe: () => msg, shell: () => { throw new Error(msg); }, env: (b) => b };
      }
      this.sandboxes.set(log.id, sb);
    }
    return sb;
  }

  /** Start the allowlist proxy once, when the network policy needs it. */
  private async ensureProxy(): Promise<void> {
    if (this.proxy || this.config.sandbox.network !== 'allowlist') return;
    this.proxy = await startAllowlistProxy(
      () => this.config.sandbox.allow,
      (h) => this.blockedHosts.add(h),
    );
  }

  sandboxInfo(sessionId?: string): { mode: string; kind: string; description: string; network: string; proxyPort?: number; blocked: string[] } {
    const sb = sessionId ? this.sandboxFor(SessionLog.open(sessionId)) : createSandbox({ mode: this.config.sandbox.mode, cfg: this.config.sandbox, sessionId: 'probe', cwd: process.cwd(), secretEnv: [] });
    return { mode: this.config.sandbox.mode, kind: sb.kind, description: sb.describe(), network: this.config.sandbox.network, proxyPort: this.proxy?.port, blocked: [...this.blockedHosts] };
  }

  /** One repository map per session: stable for the whole session so the provider's prompt cache keeps hitting. */
  private repoMapFor(log: SessionLog): string | undefined {
    if (!this.config.repoMap?.enabled || !['coding', 'plan'].includes(log.currentMode())) return undefined;
    let m = this.repoMaps.get(log.id);
    if (m === undefined) {
      try {
        const r = buildRepoMap(log.meta()!.cwd, { budget: this.config.repoMap.budget });
        m = r.totalFiles >= this.config.repoMap.minFiles ? r.text : '';
      } catch {
        m = '';
      }
      this.repoMaps.set(log.id, m);
    }
    return m || undefined;
  }

  systemPrompt(log: SessionLog, modelRef: string): string {
    const meta = log.meta()!;
    const mode = this.modes.get(log.currentMode()) ?? this.modes.get('coding')!;
    return buildSystemPrompt({
      mode,
      cwd: meta.cwd,
      model: modelRef,
      project: loadProjectContext(meta.cwd, this.config.rules),
      skills: this.listSkills(meta.cwd).map((s) => ({ name: s.name, description: s.description })),
      memory: readMemory(),
      repoMap: this.repoMapFor(log),
      untrustedNote: this.config.taint.enabled,
      sandbox: this.sandboxFor(log).kind === 'none' ? undefined : `${this.sandboxFor(log).describe()}. Writes outside the workspace fail with "Operation not permitted"${this.config.sandbox.network === 'off' ? '; there is no network access' : this.config.sandbox.network === 'allowlist' ? `; network only to: ${this.config.sandbox.allow.join(', ')}` : ''}. Ask the user if a command genuinely needs more access.`,
      knowledgeProviders: this.knowledgeProviders().map((k) => ({ id: k.id, name: k.name })),
      extraSections: this.promptSections.map((s) => ({ title: s.title, text: s.text() })),
    });
  }

  // ---------- background jobs ----------

  /** Log the end of a job and deliver its result to the session (starting or queueing a run). */
  private deliverJob({ job, tail }: JobResult): void {
    if (!SessionLog.exists(job.sessionId)) return;
    const log = SessionLog.open(job.sessionId);
    const state = job.state === 'running' ? 'done' : job.state;
    this.append(log, { type: 'job/finished', jobId: job.id, name: job.name, state, exitCode: job.exitCode });
    if (state === 'killed' || log.last('worktree/closed')) return;
    const text = `[Background job ${job.id} ${state}${job.exitCode !== undefined ? ` (exit ${job.exitCode})` : ''}: ${job.command.slice(0, 200)}]\n${tail.trim() || '(no output)'}`;
    this.send(job.sessionId, text, 'job').catch(() => undefined);
  }

  listJobs(sessionId?: string) {
    return this.jobs.list(sessionId);
  }

  jobOutput(jobId: string): string {
    return this.jobs.tail(jobId, 50_000);
  }

  killJob(jobId: string): boolean {
    return this.jobs.kill(jobId);
  }

  // ---------- worktrees ----------

  private worktreeOf(id: string): WorktreeInfo {
    const wt = SessionLog.open(id).meta()?.worktree;
    if (!wt) throw new Error(`Session ${id} does not use a worktree.`);
    return wt;
  }

  worktreeStatus(id: string): WorktreeStatus {
    return worktreeStatus(this.worktreeOf(id));
  }

  worktreeDiff(id: string): string {
    return worktreeDiff(this.worktreeOf(id));
  }

  /** Merge the session branch into the main checkout (squash by default), then remove the worktree. */
  mergeWorktree(id: string, opts: { strategy?: 'squash' | 'merge'; keep?: boolean } = {}): { strategy: string; output: string } {
    if (this.runs.has(id)) throw new Error('Stop the run before merging.');
    const log = SessionLog.open(id);
    const info = this.worktreeOf(id);
    const title = log.summary()?.title ?? id;
    const r = mergeWorktree(info, { strategy: opts.strategy, message: `sun: ${title}\n\nSession ${id} (${info.branch})` });
    if (!opts.keep) {
      removeWorktree(info, { keepBranch: r.strategy === 'squash' });
      this.append(log, { type: 'worktree/closed', action: 'merged', detail: `${r.strategy} into ${info.repo}` });
    }
    this.broadcastSessions();
    return r;
  }

  discardWorktree(id: string): void {
    this.abort(id);
    const log = SessionLog.open(id);
    removeWorktree(this.worktreeOf(id));
    this.append(log, { type: 'worktree/closed', action: 'discarded' });
    this.broadcastSessions();
  }

  // ---------- approvals ----------

  pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((a) => a.pending);
  }

  private approvers = new Set<(sessionId: string) => boolean>();
  private fileStates = new Map<string, FileState>();

  private fileStateOf(sessionId: string): FileState {
    let f = this.fileStates.get(sessionId);
    if (!f) this.fileStates.set(sessionId, (f = new FileState()));
    return f;
  }

  // ---------- checkpoints ----------

  /** Snapshot files before an edit (content, or null if the file does not exist yet). */
  private checkpoint(log: SessionLog, paths: string[]): void {
    const id = `cp-${String(log.all().filter((e) => e.type === 'checkpoint').length + 1).padStart(4, '0')}`;
    const files = [...new Set(paths)].map((p) => ({ path: p, before: existsSync(p) ? readFileSync(p, 'utf8') : null }));
    const dir = ensureDir(homePath('checkpoints', log.id));
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, ts: new Date().toISOString(), files }));
    this.append(log, { type: 'checkpoint', id, files: files.map((f) => f.path) });
  }

  listCheckpoints(sessionId: string): { id: string; files: string[]; undone: boolean; ts: string }[] {
    const log = SessionLog.open(sessionId);
    const undone = new Set(log.all().filter((e) => e.type === 'checkpoint/undo').map((e) => (e as Extract<SessionEvent, { type: 'checkpoint/undo' }>).id));
    return log
      .all()
      .filter((e): e is Extract<SessionEvent, { type: 'checkpoint' }> => e.type === 'checkpoint')
      .map((e) => ({ id: e.id, files: e.files, undone: undone.has(e.id), ts: e.ts }));
  }

  /** Revert the last `steps` not-yet-undone checkpoints (newest first), or everything back to and including `to`. */
  undo(sessionId: string, opts: { steps?: number; to?: string } = {}): { undone: string[]; restored: string[] } {
    if (this.runs.has(sessionId)) throw new Error('Stop the run before undoing.');
    const log = SessionLog.open(sessionId);
    const open = this.listCheckpoints(sessionId).filter((c) => !c.undone).reverse();
    const take = opts.to ? open.slice(0, open.findIndex((c) => c.id === opts.to) + 1) : open.slice(0, opts.steps ?? 1);
    if (opts.to && !take.length) throw new Error(`No undoable checkpoint ${opts.to}`);
    const restored = new Set<string>();
    for (const c of take) {
      const snap = JSON.parse(readFileSync(homePath('checkpoints', sessionId, `${c.id}.json`), 'utf8')) as { files: { path: string; before: string | null }[] };
      for (const f of snap.files) {
        if (f.before === null) rmSync(f.path, { force: true });
        else {
          mkdirSync(dirname(f.path), { recursive: true });
          writeFileSync(f.path, f.before);
        }
        restored.add(f.path);
      }
      this.append(log, { type: 'checkpoint/undo', id: c.id, restored: snap.files.map((f) => f.path) });
    }
    if (take.length) {
      this.append(log, {
        type: 'user/message',
        source: 'system',
        text: `[The user undid your last ${take.length} change${take.length > 1 ? 's' : ''}: ${[...restored].map((p) => relative(log.meta()!.cwd, p) || p).join(', ')} restored. Re-read files before editing them again.]`,
      });
    }
    return { undone: take.map((c) => c.id), restored: [...restored] };
  }



  /**
   * A UI that can answer approvals (desktop window, interactive terminal, chat bot). `scope` limits it to the sessions
   * it shows (a bot only sees its chats). Approvals no registered approver can see are denied, not awaited.
   */
  registerApprover(scope: (sessionId: string) => boolean = () => true): () => void {
    const entry = (id: string) => scope(id);
    this.approvers.add(entry);
    return () => void this.approvers.delete(entry);
  }

  private hasApprover(sessionId: string): boolean {
    for (const a of this.approvers) if (a(sessionId)) return true;
    return false;
  }

  private requestApproval(req: ApprovalRequest, displaySessionId: string, signal: AbortSignal): Promise<{ decision: ApprovalDecision; reason?: string }> {
    const nobody = !this.hasApprover(displaySessionId);
    if (this.config.denyInsteadOfPrompting || nobody) {
      return Promise.resolve({
        decision: 'deny',
        reason: `No human is available to approve "${req.name}" (${nobody ? 'headless run' : 'denyInsteadOfPrompting'}), so it was denied. Continue without it, or finish and explain what approval you need.`,
      });
    }
    return new Promise((resolve) => {
      const pending: PendingApproval = { ...req, displaySessionId, promptId: randomUUID(), requestedAt: new Date().toISOString() };
      const done = (d: ApprovalDecision) => {
        if (!this.approvals.has(req.callId)) return;
        this.approvals.delete(req.callId);
        this.broadcastApprovals();
        resolve({ decision: d });
      };
      this.approvals.set(req.callId, { pending, resolve: done });
      signal.addEventListener('abort', () => done('deny'), { once: true });
      this.broadcastApprovals();
    });
  }

  /**
   * Answer a pending approval. Returns false for an unknown call (already answered, expired) or a stale prompt
   * (promptId from an earlier showing of the same call), so a late or misdirected answer never applies.
   */
  approve(callId: string, decision: ApprovalDecision, promptId?: string): boolean {
    const a = this.approvals.get(callId);
    if (!a || (promptId && a.pending.promptId !== promptId)) return false;
    a.resolve(decision);
    return true;
  }

  // ---------- services exposed to tools ----------

  private services(log: SessionLog, signal: AbortSignal): ToolServices {
    const cwd = log.meta()!.cwd;
    return {
      fileState: this.fileStateOf(log.id),
      sandbox: this.sandboxFor(log),
      lsp: this.config.lsp,
      checkpoint: (paths) => this.checkpoint(log, paths),
      setTodos: (items) => this.append(log, { type: 'todo/update', items }),
      kbSearch: (q, k, provider) => this.kbSearchText(q, k ?? 6, provider),
      kbAdd: async (title, text) => `Saved note: ${await this.personalKb.add(title, text)}`,
      memorySave: async (fact, section) => saveMemoryFact(fact, section),
      memoryRemember: async (fact, kind) => {
        const { item, duplicate } = this.memoryStore.add(fact, (kind as MemoryKind) ?? 'fact', log.id);
        return duplicate ? `Already remembered: ${item.text}` : `Remembered (${item.kind}).`;
      },
      memorySearch: async (q) => {
        const hits = this.memoryStore.search(q, 8, 0.1);
        if (hits.length) this.memoryStore.touch(hits.map((h) => h.item.id));
        return hits.map((h) => `- [${h.item.id}] (${h.item.kind}, ${h.item.created.slice(0, 10)}) ${h.item.text}`).join('\n') || 'No matching memories.';
      },
      loadSkill: async (name) => {
        const s = this.listSkills(cwd).find((x) => x.name === name);
        if (!s) throw new Error(`No skill named "${name}". Available: ${this.listSkills(cwd).map((x) => x.name).join(', ')}`);
        return loadSkillBody(s);
      },
      runSubagent: (prompt, o) => this.runSubagent(log, prompt, o.mode, signal),
      startJob: (command, jobCwd) => {
        const sb = this.sandboxFor(log);
        const job = this.jobs.startProcess(log.id, command, jobCwd, 'bash', sb.kind === 'none' && !this.config.sandbox.scrubEnv ? undefined : { shell: sb.shell(command, jobCwd), env: sb.env(process.env) });
        return `Started background job ${job.id}. Its output is logged to ${job.logFile}; you will receive the result in this session when it ends. Use job_status to check progress or job_kill to stop it.`;
      },
      jobStatus: (jobId) => {
        if (!jobId) {
          const list = this.jobs.list(log.id);
          return list.map((j) => `${j.id}  ${j.state}${j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ''}  ${j.command.slice(0, 120)}`).join('\n') || 'No background jobs in this session.';
        }
        const j = this.jobs.get(jobId);
        if (!j) return `No job ${jobId}.`;
        return `${j.id} ${j.state}${j.exitCode !== undefined ? ` (exit ${j.exitCode})` : ''}\n${this.jobs.tail(jobId, 4000) || '(no output yet)'}`;
      },
      exitPlanMode: (plan) => {
        if (log.currentMode() !== 'plan') throw new Error('exit_plan_mode is only available in plan mode.');
        if (!plan.trim()) throw new Error('Provide the plan as Markdown.');
        this.append(log, { type: 'todo/update', items: planTodos(plan) });
        // Same log instance as the running agent, so the next step already sees coding mode and its tools.
        this.append(log, { type: 'mode/switch', from: 'plan', to: 'coding' });
        this.broadcastSessions();
        return 'Plan approved. The session is now in coding mode with full tools: implement the plan step by step, keep the todo list current, and verify at the end.';
      },
      killJob: (jobId) => (this.jobs.kill(jobId) ? `Stopped ${jobId}.` : `${jobId} is not running.`),
      scheduleTask: async (spec) => {
        const t = addSchedule({ title: spec.title ?? spec.prompt.slice(0, 50), prompt: spec.prompt, at: spec.at, cron: spec.cron, mode: 'assistant', cwd });
        return `Scheduled ${t.id} (${t.cron ? `cron ${t.cron}` : `at ${t.at}`}). It runs while the sun-harness gateway (sun gateway install) or desktop app is running.`;
      },
    };
  }

  private async runSubagent(parent: SessionLog, prompt: string, mode: string | undefined, signal: AbortSignal): Promise<string> {
    const meta = parent.meta()!;
    const child = this.createSession({
      cwd: meta.cwd,
      mode: mode ?? parent.currentMode(),
      model: parent.currentModel(),
      parent: parent.id,
      title: `[sub] ${prompt.slice(0, 50)}`,
      approval: meta.approval,
    });
    const log = SessionLog.open(child.id);
    this.append(log, { type: 'user/message', text: prompt, source: 'system' });
    const result = await this.startRun(child.id, signal);
    const text = SessionLog.open(child.id).last('assistant/message')?.text ?? '';
    if (result.status !== 'idle') return `Subagent ${child.id} stopped (${result.status}${result.reason ? `: ${result.reason}` : ''}).\n${text}`;
    return text || '(subagent returned no text)';
  }

  // ---------- skills / mcp / plugins / knowledge ----------

  listSkills(cwd: string): Skill[] {
    return discoverSkills(skillDirs(cwd, this.config.skills.extraDirs, this.config.skills.compat));
  }

  async mcpFor(cwd: string): Promise<McpManager> {
    const root = findProjectRoot(cwd);
    let m = this.mcp.get(root);
    if (!m) {
      m = new McpManager();
      this.mcp.set(root, m);
      await m.connectAll(root);
    }
    return m;
  }

  async listMcp(cwd: string): Promise<McpServerState[]> {
    return [...(await this.mcpFor(cwd)).servers.values()];
  }

  async reloadMcp(cwd: string): Promise<McpServerState[]> {
    const root = findProjectRoot(cwd);
    await this.mcp.get(root)?.closeAll();
    this.mcp.delete(root);
    return this.listMcp(cwd);
  }

  async reloadPlugins(): Promise<PluginState[]> {
    this.pluginTools = [];
    this.pluginKnowledge = [];
    this.promptSections = [];
    this.pluginListeners = [];
    this.modes = new Map(BUILTIN_MODES.map((m) => [m.id, m]));
    this.pluginStates = await loadPlugins(
      {
        addTool: (t) => this.pluginTools.push(t),
        addKnowledge: (p) => this.pluginKnowledge.push(p),
        addMode: (m) => this.modes.set(m.id, m),
        addPrompt: (title, text) => this.promptSections.push({ title, text }),
        addListener: (h) => this.pluginListeners.push(h),
      },
      { disabled: this.config.plugins.disabled, settings: this.config.plugins.settings },
    );
    return this.pluginStates;
  }

  knowledgeProviders(): KnowledgeProvider[] {
    const out: KnowledgeProvider[] = [this.hybridKb ?? this.personalKb];
    const c = this.config.kb.company;
    if (c.enabled && c.baseUrl) out.push(new HttpKnowledgeProvider('company', c.name ?? 'Company KB', c.baseUrl, c.tokenEnv ? process.env[c.tokenEnv] : undefined));
    return [...out, ...this.pluginKnowledge];
  }

  async kbSearch(query: string, k = 6, provider?: string) {
    const providers = this.knowledgeProviders().filter((p) => !provider || p.id === provider);
    const results = await Promise.all(
      providers.map(async (p) => {
        try {
          return (await p.search(query, k)).map((h) => ({ ...h, provider: p.id }));
        } catch (e) {
          return [{ title: `${p.name} error`, text: (e as Error).message, source: '', score: 0, provider: p.id }];
        }
      }),
    );
    return results.flat().sort((a, b) => b.score - a.score).slice(0, k);
  }

  private async kbSearchText(query: string, k: number, provider?: string): Promise<string> {
    const hits = await this.kbSearch(query, k, provider);
    if (!hits.length) return 'No knowledge base results.';
    return hits.map((h, i) => `[${i + 1}] ${h.title} (${h.provider}, score ${h.score})\nSource: ${h.source}\n${h.text}`).join('\n\n---\n\n');
  }

  async kbStats() {
    const personal = this.hybridKb ? await this.hybridKb.stats() : { ...(await this.personalKb.stats()), embedded: 0, model: undefined, lastError: undefined };
    return { personal, roots: this.config.kb.roots, providers: this.knowledgeProviders().map((p) => ({ id: p.id, name: p.name })) };
  }

  /** Precompute embeddings for the personal KB (no-op without hybrid retrieval). */
  async kbIndex(): Promise<{ embedded: number; enabled: boolean }> {
    if (!this.hybridKb) return { embedded: 0, enabled: false };
    return { embedded: await this.hybridKb.index(), enabled: true };
  }

  async kbAdd(title: string, text: string): Promise<string> {
    return this.personalKb.add(title, text);
  }

  // ---------- one-shot completion (intel, evolution) ----------

  async complete(system: string, user: string, modelRef?: string): Promise<string> {
    const { provider, model } = this.factory(modelRef || this.config.defaultModel);
    const r = await provider.complete({ model, system, messages: [{ role: 'user', content: user }], tools: [] });
    return r.text;
  }

  // ---------- intel + evolution ----------

  private intelRunning?: Promise<IntelRunResult>;

  runIntel(opts: { force?: boolean } = {}): Promise<IntelRunResult> {
    if (!this.intelRunning) {
      const model = this.config.intel.analysisModel || this.config.defaultModel;
      this.intelRunning = runIntel({ sources: this.config.intel.sources, complete: (s, u) => this.complete(s, u, model), force: opts.force }).finally(
        () => (this.intelRunning = undefined),
      );
    }
    return this.intelRunning;
  }

  analyzeIntel(date: string): Promise<IntelRunResult> {
    const model = this.config.intel.analysisModel || this.config.defaultModel;
    return analyzeIntelDay(date, (s, u) => this.complete(s, u, model));
  }

  /** Desktop catch-up: run today's intel if the scheduled time passed and no report exists yet. */
  private async intelCatchUp(now: Date): Promise<boolean> {
    const today = localDate(now);
    const { hour, minute } = this.config.intel;
    if (now.getHours() * 60 + now.getMinutes() < hour * 60 + minute) return false;
    const lastRun = loadIntelState().lastRun;
    const last = lastRun ? localDate(new Date(lastRun)) : undefined;
    if (last === today || listIntelReports().some((r) => r.date === today)) return false;
    await this.runIntel();
    return true;
  }

  async reflect(sessionId: string): Promise<Proposal[]> {
    return reflectSession((s, u) => this.complete(s, u, SessionLog.open(sessionId).currentModel()), sessionId, readMemory());
  }

  // ---------- background: auto-resume + schedules ----------

  private backgroundIntel = false;

  startBackground(intervalMs = 60_000, opts: { intel?: boolean } = {}): void {
    this.stopBackground();
    this.backgroundIntel = opts.intel ?? true;
    this.startTriggers();
    this.timer = setInterval(() => {
      this.backgroundTick().catch(() => undefined);
    }, intervalMs);
  }

  stopBackground(): void {
    this.triggerWatchers.stop();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async backgroundTick(now = new Date(), opts: { intel?: boolean } = {}): Promise<{ resumed: string[]; scheduled: string[] }> {
    if (opts.intel !== false && this.backgroundIntel) this.intelCatchUp(now).catch(() => undefined);
    this.briefingCatchUp(now).catch(() => undefined);
    const resumed: string[] = [];
    if (this.config.autoResume.enabled) {
      const waitMs = this.config.autoResume.intervalMinutes * 60_000;
      for (const s of this.listSessions()) {
        if (s.status !== 'paused' || !AUTO_RESUME_REASONS.has(s.statusReason ?? '') || this.runs.has(s.id)) continue;
        const pausedAt = Date.parse(SessionLog.open(s.id).last('run/status')?.ts ?? s.updatedAt);
        if (now.getTime() - pausedAt >= waitMs) {
          this.resume(s.id);
          resumed.push(s.id);
        }
      }
    }
    const scheduled: string[] = [];
    const tasks = listSchedules();
    const due = dueTasks(tasks, now);
    for (const t of due) {
      const s = this.createSession({ cwd: t.cwd, mode: t.mode, title: `[scheduled] ${t.title}` });
      await this.send(s.id, t.prompt, 'schedule');
      t.lastRun = now.toISOString();
      if (t.at) t.enabled = false;
      scheduled.push(s.id);
    }
    if (due.length) saveSchedules(tasks);
    return { resumed, scheduled };
  }

  async dispose(): Promise<void> {
    this.stopBackground();
    if (this.config.jobs?.killOnExit) this.jobs.killAll();
    else this.jobs.detach();
    for (const id of this.runs.keys()) this.abort(id);
    for (const sb of this.sandboxes.values()) sb.dispose?.();
    await this.browser.dispose().catch(() => undefined);
    for (const k of this.kernels.values()) k.dispose();
    disposeLspClients();
    this.proxy?.server.close();
    await Promise.all([...this.mcp.values()].map((m) => m.closeAll()));
  }
}
