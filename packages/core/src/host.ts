import { localDate } from './util/date.js';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { JobManager, restorableJobIds, type JobResult } from './jobs.js';
import { createWorktree, mergeWorktree, removeWorktree, worktreeDiff, worktreeStatus, type WorktreeInfo, type WorktreeStatus } from './worktree.js';
import { Agent, type AgentHooks, type ApprovalRequest, type RunResult } from './agent.js';
import { availableModels, compactionLimit, contextWindowOf, createProviderFactory, isProviderReady, loadConfig, parseModelRef, providerKey, saveConfig, type ApprovalMode, type ProviderFactory, type SunConfig } from './config.js';
import { createShellHooks } from './hooks.js';
import { HttpKnowledgeProvider } from './kb/company.js';
import { LocalMarkdownKB } from './kb/local.js';
import { HybridKB, openAIEmbedder, type EmbedFn } from './kb/hybrid.js';
import type { KnowledgeProvider } from './kb/types.js';
import { SessionLog } from './log.js';
import { McpManager, type McpServerState } from './mcp.js';
import { readMemory, saveMemoryFact } from './memory.js';
import { BUILTIN_MODES, type ModeDef } from './modes.js';
import { ensureHome, homePath } from './paths.js';
import { loadPlugins, type PluginState } from './plugins.js';
import { buildSystemPrompt } from './prompt.js';
import { findProjectRoot, loadProjectContext } from './rules.js';
import { addSchedule, dueTasks, listSchedules, saveSchedules } from './schedule.js';
import { discoverSkills, loadSkillBody, skillDirs, type Skill } from './skills.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import { SERVICE_TOOLS } from './tools/services.js';
import type { Tool, ToolServices } from './tools/types.js';
import type { ApprovalDecision, LiveEvent, PendingApproval, SessionEvent, SessionSummary } from './types.js';
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
}

const AUTO_RESUME_REASONS = new Set(['quota', 'rate_limit', 'network']);

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
  private queued = new Map<string, { text: string; source: 'user' | 'schedule' | 'system' | 'job' }[]>();
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
    if (mode === 'coding') return process.cwd();
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
    const log = SessionLog.create({ mode, cwd, model: input.model || this.config.defaultModel, title: input.title, parent: input.parent, worktree, approval: input.approval });
    this.broadcastSessions();
    return log.summary()!;
  }

  deleteSession(id: string): void {
    this.abort(id);
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
  async send(id: string, text: string, source: 'user' | 'schedule' | 'system' | 'job' = 'user'): Promise<void> {
    if (this.runs.has(id)) {
      this.queued.set(id, [...(this.queued.get(id) ?? []), { text, source }]);
      return;
    }
    const log = SessionLog.open(id);
    if (!log.meta()) throw new Error(`No session ${id}`);
    const closed = log.last('worktree/closed');
    if (closed) throw new Error(`This session's worktree was ${closed.action}; start a new session to continue.`);
    if (!log.all().some((e) => e.type === 'user/message') && this.opts.shellHooks !== false) {
      const ctx = await createShellHooks(log.meta()!.cwd).sessionStart(id);
      if (ctx) this.append(log, { type: 'user/message', text: `[sessionStart hook context]\n${ctx}`, source: 'hook' });
    }
    this.append(log, { type: 'user/message', text, source });
    if (log.meta()!.title === 'New session' && !log.last('session/title')) {
      const t = text.replace(/\s+/g, ' ').trim();
      this.append(log, { type: 'session/title', title: t.length > 60 ? t.slice(0, 57) + '...' : t || 'Untitled' });
    }
    this.startRun(id);
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
      const log = SessionLog.open(id);
      const cwd = log.meta()!.cwd;
      const tools = await this.toolsFor(log);
      const hooks: AgentHooks | undefined = this.opts.shellHooks === false ? undefined : createShellHooks(cwd);
      const agent = new Agent({
        log,
        config: this.config,
        resolveModel: (ref) => this.factory(ref),
        tools: () => tools.filter((t) => this.modeAllows(log.currentMode(), t, !!log.meta()?.parent)),
        systemPrompt: (modelRef) => this.systemPrompt(log, modelRef),
        approvalMode: () => log.meta()?.approval ?? this.config.approval,
        contextLimit: (ref) => compactionLimit(this.config, ref),
        requestApproval: (req, signal) => this.requestApproval(req, log.meta()?.parent ?? id, signal),
        services: this.services(log, controller.signal),
        hooks,
        onLive: (e) => this.broadcast(e),
      });
      return agent.run(controller.signal);
    })();
    this.runs.set(id, { controller, promise });
    this.broadcastSessions();
    promise
      .catch(() => undefined)
      .finally(() => {
        this.runs.delete(id);
        const q = this.queued.get(id);
        if (q?.length) {
          this.queued.delete(id);
          const log = SessionLog.open(id);
          for (const t of q) this.append(log, { type: 'user/message', text: t.text, source: t.source });
          this.startRun(id);
        } else this.broadcastSessions();
      });
    return promise;
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
    for (const t of [...BUILTIN_TOOLS, ...SERVICE_TOOLS, ...this.pluginTools, ...slowSafe]) byName.set(t.name, t);
    return [...byName.values()];
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

  private approvers = 0;

  /** A UI that can answer approvals (desktop window, interactive terminal). Without one, approvals are denied, not awaited. */
  registerApprover(): () => void {
    this.approvers++;
    let done = false;
    return () => {
      if (!done) (this.approvers--, (done = true));
    };
  }

  private requestApproval(req: ApprovalRequest, displaySessionId: string, signal: AbortSignal): Promise<{ decision: ApprovalDecision; reason?: string }> {
    if (this.config.denyInsteadOfPrompting || this.approvers === 0) {
      return Promise.resolve({
        decision: 'deny',
        reason: `No human is available to approve "${req.name}" (${this.approvers === 0 ? 'headless run' : 'denyInsteadOfPrompting'}), so it was denied. Continue without it, or finish and explain what approval you need.`,
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
      setTodos: (items) => this.append(log, { type: 'todo/update', items }),
      kbSearch: (q, k, provider) => this.kbSearchText(q, k ?? 6, provider),
      kbAdd: async (title, text) => `Saved note: ${await this.personalKb.add(title, text)}`,
      memorySave: async (fact, section) => saveMemoryFact(fact, section),
      loadSkill: async (name) => {
        const s = this.listSkills(cwd).find((x) => x.name === name);
        if (!s) throw new Error(`No skill named "${name}". Available: ${this.listSkills(cwd).map((x) => x.name).join(', ')}`);
        return loadSkillBody(s);
      },
      runSubagent: (prompt, o) => this.runSubagent(log, prompt, o.mode, signal),
      startJob: (command, jobCwd) => {
        const job = this.jobs.startProcess(log.id, command, jobCwd);
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
    this.timer = setInterval(() => {
      this.backgroundTick().catch(() => undefined);
    }, intervalMs);
  }

  stopBackground(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async backgroundTick(now = new Date(), opts: { intel?: boolean } = {}): Promise<{ resumed: string[]; scheduled: string[] }> {
    if (opts.intel !== false && this.backgroundIntel) this.intelCatchUp(now).catch(() => undefined);
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
    await Promise.all([...this.mcp.values()].map((m) => m.closeAll()));
  }
}
