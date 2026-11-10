import { executionDockerEndpoint, prepareDockerExecution } from './sandbox.js';
import { requireExecutionOperation, validateExecutionCommand, type ExecutionJobRequest } from './settings/targets.js';
import { AppshotDrafts, readAppshot, storeAppshot, type AppshotEdits, type AppshotMetadata, type AppshotScope, type PreparedAppshot } from './settings/capture.js';
import { ComputerControl, validComputerIdentity, type ComputerSettings } from './settings/computer.js';
import { computerGrants, updateComputerGrant } from './settings/computer-grants.js';
import { BrowserPermissions } from './browser/permissions.js';
import type { BrowserUploadRequest } from './browser/uploads.js';
import { localDate } from './util/date.js';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { FileState } from './tools/edit.js';
import { detectVerifyCommands } from './verify.js';
import { buildRepoMap } from './repomap.js';
import { BrowserManager, type BrowserControl, type BrowserFrameRef, type BrowserInput } from './browser/browser.js';
import { createBrowserTools } from './browser/tools.js';
import { PythonKernel } from './research/python.js';
import { createResearchTools } from './research/tools.js';
import { scanInjection, wrapUntrusted } from './research/taint.js';
import { EXTRACT_SYSTEM, MemoryStore, formatRecall, parseExtraction, type MemoryKind } from './assistant/memstore.js';
import { routeTier } from './assistant/router.js';
import { dingtalkTools } from './assistant/connectors.js';
import { briefingFile, briefingPrompt } from './assistant/briefing.js';
import { TriggerWatchers, renderTrigger } from './assistant/triggers.js';
import { TranscriptionRequests, transcribe } from './assistant/voice.js';
import { conversationMetrics, type ModeMetrics } from './assistant/metrics.js';
import { disposeLspClients } from './lsp.js';
import { isInside, resolveIn } from './policy.js';
import { isIgnored } from './ux/ignore.js';
import { expandCommand, loadCommands, type CustomCommand } from './ux/commands.js';
import { completePaths, expandMentions, imageMime } from './ux/mentions.js';
import { DEFAULT_PRICING, sessionCost, type CostReport, type ModelPrice } from './ux/pricing.js';
import { credentialRedactor, redactSessionEvents, sessionToHtml, sessionToMarkdown } from './ux/export.js';
import { diffStats, unifiedDiff } from './ux/diff.js';
import { buildContextReport, contextReportHtml, type ContextReport } from './ux/context.js';
import { createSandbox, secretEnvNames, startAllowlistProxy, type ExecSandbox, type SandboxMode } from './sandbox.js';
import { JobManager, restorableJobIds, worktreeJobsStillActive, type JobResult } from './jobs.js';
import { assertWorktreeOwned, createWorktree, mergeWorktree, removeWorktree, worktreeDiff, worktreeReviewChanges, worktreeSafety, worktreeStatus,
  type WorktreeCleanupPreview, type WorktreeCleanupResult, type WorktreeInfo, type WorktreeInventoryItem, type WorktreeSetupState, type WorktreeStatus,
} from './worktree.js';
import { Agent, type AgentHooks, type ApprovalRequest, type RunResult } from './agent.js';
import { availableModels, compactionLimit, contextWindowOf, createProviderFactory, isProviderReady, loadConfig, parseModelRef, providerKey, supportsVision, type ApprovalMode, type ProviderFactory, type SunConfig } from './config.js';
import { ownedAttachment } from './attachments.js';
import { exportBundle, importBundle, importTranscript, type SessionImportOptions } from './settings/import.js';
import { hasDataActivity, holdDataActivity, withStorageLock } from './settings/storage-lock.js';
import { StorageManager, type StorageConfirmation } from './settings/storage.js';
import { appendSettingsAudit, getSettings, writeSettings } from './settings/service.js';
import { describeCapabilities, invokeNative, nativeCapability, type NativeCapabilityAdapters } from './settings/capabilities.js';
import type { CapabilityStatus, CapabilitySurface, SettingsSnapshot, SettingsWriteResult } from './settings/types.js';
import { createShellHooks, HOOK_FIXTURES, hookFixturePayload, inspectHooks, reviewHookTrust, runHook,
  type HookDefinition, type HookFixtureRequest, type HookFixtureResult, type HookInspection, type HookRunOptions, type HookTrustChange,
} from './hooks.js';
import { hookMatches } from './hook-config.js';
import { HttpKnowledgeProvider } from './kb/company.js';
import { LocalMarkdownKB } from './kb/local.js';
import { HybridKB, openAIEmbedder, type EmbedFn } from './kb/hybrid.js';
import type { KnowledgeProvider } from './kb/types.js';
import { SessionLog } from './log.js';
import { McpManager, type McpServerState } from './mcp.js';
import { appendDaily, readMemory, readPersonalInstructions, readUserProfile, saveMemoryFact, saveUserFact } from './memory.js';
import { ensureDir, ensureHome, homePath } from './paths.js';
import { pluginDirs, type PluginState } from './plugins.js';
import { PluginRuntime } from './plugin-runtime.js';
import { buildSystemPrompt, buildSystemPromptSections } from './prompt.js';
import { applyRuleBudgets, DEFAULT_RULE_BUDGETS, findProjectRoot, loadProjectContext, rulesForFiles } from './rules.js';
import { prepareReview, REVIEW_SYSTEM, reviewDigest, reviewText, validateReviewFindings, type ReviewChange, type ReviewOutcome, type ReviewRequest, type ReviewStatus } from './review.js';
import { addSchedule, dueTasks, listSchedules, missedTasks, parseCron, recordRun, removeSchedule, saveSchedules, updateSchedule, type ScheduledTask } from './schedule.js';
import { describeCron, missedRun, nextRuns, parseSchedule } from './automation/schedule.js';
import { discoverSkills, expandSkillCommand, loadSkillBody, skillDirs, type Skill } from './skills.js';
import { BUILTIN_TOOLS } from './tools/builtin.js';
import { SERVICE_TOOLS } from './tools/services.js';
import { toSchema, type Tool, type ToolServices } from './tools/types.js';
import type { ApprovalDecision, LiveEvent, PendingApproval, SessionEvent, SessionEventBody, SessionSummary, TodoItem } from './types.js';
import { analyzeIntelDay, listIntelReports, loadIntelState, runIntel, type IntelRunResult } from './intel.js';
import { reflectSession, type Proposal } from './evolution.js';

export interface HostOptions {
  providerFactory?: ProviderFactory;
  config?: SunConfig;
  loadPlugins?: boolean;
  connectMcp?: boolean;
  shellHooks?: boolean;
  nativeCapabilities?: NativeCapabilityAdapters;
  /** Override the embedding function (tests). */
  embedder?: EmbedFn;
}

export interface CreateSessionInput {
  cwd?: string;
  /** Local client working directory, used only when the resolved mode operates in a repository. */
  repoCwd?: string;
  mode?: string;
  model?: string;
  title?: string;
  parent?: string;
  /** Run in an isolated git worktree on a new branch (coding sessions in a git repo). */
  worktree?: boolean;
  worktreeBase?: string;
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

/** An automation as shown to users: the stored task plus its readable schedule and next run. */
/** One file a session changed. */
export interface FileChange {
  path: string;
  abs: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  diff: string;
  binary: boolean;
  contentDigest?: string;
}

export type Automation = ScheduledTask & { description: string; nextRun?: string; lastStatus?: string };

export class HarnessHost {
  config: SunConfig;
  private factory: ProviderFactory;
  private readonly opts: HostOptions;
  private readonly plugins = new PluginRuntime(
    () => this.config.plugins,
    event => appendSettingsAudit({ kind: 'plugin/lifecycle', ...event }),
    () => this.broadcastPlugins(),
  );
  private readonly modes = this.plugins.modes;
  private pluginActivation?: Promise<void>;
  private listeners = new Set<(e: LiveEvent) => void>();
  private runs = new Map<string, { controller: AbortController; promise: Promise<RunResult> }>();
  private readonly startupHooks = new Map<string, { controller: AbortController; log: SessionLog }>();
  private readonly hookFixtures = new Map<string, AbortController>();
  private readonly reviews = new Map<string, Promise<ReviewOutcome | undefined>>();
  private readonly worktreeSetups = new Map<string, AbortController>();
  private readonly computer?: ComputerControl;
  private pendingComputer?: { sessionId: string; appId: string };
  private queued = new Map<string, Parameters<SessionLog['append']>[0][]>();
  private approvals = new Map<string, { pending: PendingApproval; resolve: (d: ApprovalDecision, reason?: string) => void }>();
  private mcp = new Map<string, McpManager>();
  private personalKb: LocalMarkdownKB;
  private hybridKb?: HybridKB;
  readonly jobs = new JobManager(
    (job) => this.append(SessionLog.open(job.sessionId), { type: 'job/started', jobId: job.id, name: job.name, command: job.command }),
    (r) => this.deliverJob(r),
  );
  private timer?: NodeJS.Timeout;
  private lastStorageSweep = 0;
  private readonly storage = new StorageManager({
    preferences: () => this.config.storage,
    sessionActive: id => this.runs.has(id) || this.browser.hasTab(id),
  });
  get pluginStates(): PluginState[] {
    return this.opts.loadPlugins === false ? [] : this.plugins.list();
  }

  constructor(opts: HostOptions = {}) {
    ensureHome();
    this.opts = opts;
    this.config = opts.config ?? loadConfig();
    this.factory = opts.providerFactory ?? createProviderFactory(this.config);
    this.personalKb = new LocalMarkdownKB(this.config.kb.roots);
    this.hybridKb = this.makeHybrid();
    const adapter = opts.nativeCapabilities?.computerUse;
    if (adapter) this.computer = new ComputerControl(adapter, (id, appId) => this.computerAllowed(id, appId), ({ sessionId, ...receipt }) => {
      this.append(SessionLog.open(sessionId), { type: 'computer/action', ...receipt }, true);
      return true;
    }, Date.now, () => holdDataActivity('computer-use', () => {
      if (hasDataActivity('computer-use')) throw new Error('COMPUTER_CONTROL_BUSY');
    }));
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
      if ((s.status === 'running' || s.status === 'awaiting_approval') && !hasDataActivity(`session:${s.id}`)) {
        SessionLog.open(s.id).append({ type: 'run/status', status: 'paused', reason: 'interrupted', detail: 'The app stopped during a run.' });
      }
      const log = SessionLog.open(s.id);
      const open = new Map<string, string>();
      for (const e of log.all()) {
        if (e.type === 'job/started') open.set(e.jobId, e.name);
        else if (e.type === 'job/finished') open.delete(e.jobId);
      }
      for (const [jobId, name] of open) {
        if (restorable.has(jobId)) continue;
        const retained = jobId.startsWith('job-exec-') ? this.jobs.retained(jobId) : undefined;
        const state = retained && retained.state !== 'running' ? retained.state : 'lost';
        log.append({ type: 'job/finished', jobId, name, state, exitCode: retained?.exitCode }, !!retained);
      }
    }
    // Re-attach after the cleanup above: a job that already finished is delivered (and may start a run) right away.
    this.jobs.restore();
    try { this.storage.reconcile(); } catch { /* Retry on the next storage sweep. */ }
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
      this.plugins.notify(e.sessionId, e.event);
      if (e.event.type === 'run/status' || e.event.type === 'session/title' || e.event.type === 'model/switch') this.broadcastSessions();
    }
  }

  private broadcastSessions(): void {
    this.broadcast({ kind: 'sessions', sessions: this.listSessions() });
  }

  private broadcastApprovals(): void {
    this.broadcast({ kind: 'approvals', approvals: this.pendingApprovals() });
  }

  private broadcastPlugins(): void {
    this.broadcast({ kind: 'plugins', plugins: this.pluginStates });
  }

  // ---------- config & models ----------

  listCapabilities(surface: CapabilitySurface = 'cli'): CapabilityStatus[] {
    return describeCapabilities({
      surface,
      mcpEnabled: this.opts.connectMcp !== false && this.config.mcp.enabled,
      pluginsEnabled: this.opts.loadPlugins !== false,
      hooksEnabled: this.opts.shellHooks !== false,
      plugins: this.pluginStates,
      browserAvailable: () => this.browser.available(),
      native: this.opts.nativeCapabilities,
    });
  }

  private readonly appshots = new AppshotDrafts();

  private appshotAdapter() {
    const adapter = this.opts.nativeCapabilities?.appshots;
    const capability = nativeCapability('native.appshots', 'desktop', adapter);
    if (!adapter || capability.state !== 'available') {
      throw new Error(`CAPABILITY_${capability.state.toUpperCase()}: native.appshots (${capability.reasonCode})`);
    }
    return adapter;
  }

  async captureAppshot(sessionId: string, scope: AppshotScope = 'frontmost') {
    const adapter = this.appshotAdapter();
    if (!SessionLog.exists(sessionId)) throw new Error('APPSHOT_SESSION_UNAVAILABLE');
    return this.appshots.capture(sessionId, adapter, scope);
  }

  async prepareAppshot(sessionId: string, id: string, edits: AppshotEdits) {
    return this.appshots.prepare(sessionId, id, edits, this.appshotAdapter());
  }

  resetAppshotDraft(): void { this.appshots.dispose(); }

  cancelAppshot(sessionId: string, id: string): void {
    this.appshots.cancel(sessionId, id);
  }

  async sendAppshotMessage(id: string, text: string, images: { data: string; mime: string }[], approval: string): Promise<void> {
    this.appshotAdapter();
    if (this.isRunning(id)) throw new Error('APPSHOT_SESSION_BUSY');
    const release = this.holdSession(id, true);
    try {
      const claim = this.appshots.claim(id, approval);
      let committed = false;
      try {
        await this.sendActive(id, text, 'user', {
          images, noDetect: true, appshot: claim.image, onAppshotCommitted: () => { committed = true; },
        });
      } finally { claim.finish(committed); }
    } finally { release(); }
  }

  private computerAllowed(id: string, appId: string): boolean {
    try {
      if (!SessionLog.exists(id) || !computerGrants().grants.includes(appId)) return false;
      const log = SessionLog.open(id);
      const meta = log.meta();
      return !!meta && !meta.parent && !log.last('session/flags')?.archived && !log.last('worktree/closed');
    } catch { return false; }
  }

  async inspectComputerUse(): Promise<ComputerSettings> {
    const adapter = this.opts.nativeCapabilities?.computerUse;
    return invokeNative(nativeCapability('native.computer-use', 'desktop', adapter), async () => {
      const { authorized, apps } = await adapter!.inspect();
      const unique = new Map(apps.filter(app => validComputerIdentity(app.id)).map(app => [app.id, app]));
      return { ...computerGrants(), authorized, apps: [...unique.values()], owner: this.computer?.owner() };
    });
  }

  async grantComputerUse(revision: string, appId: string, granted: boolean): Promise<void> {
    const adapter = this.opts.nativeCapabilities?.computerUse;
    const descriptor = nativeCapability('native.computer-use', 'desktop', adapter);
    if (descriptor.state !== 'available') throw new Error('COMPUTER_UNAVAILABLE');
    if (granted === true) {
      const { apps } = await invokeNative(descriptor, () => adapter!.inspect());
      if (!apps.some(app => app.id === appId)) throw new Error('COMPUTER_APP_UNAVAILABLE');
    }
    updateComputerGrant(revision, appId, granted);
    if (!granted && this.pendingComputer?.appId === appId) this.stopComputerUse(this.pendingComputer.sessionId);
    this.computer?.owner();
  }

  async beginComputerUse(id: string, appId: string): Promise<void> {
    const adapter = this.opts.nativeCapabilities?.computerUse;
    const descriptor = nativeCapability('native.computer-use', 'desktop', adapter);
    if (!this.computer || descriptor.state !== 'available') {
      throw new Error('COMPUTER_UNAVAILABLE');
    }
    if (this.pendingComputer || this.computer.owner()) throw new Error('COMPUTER_CONTROL_BUSY');
    const pending = { sessionId: id, appId };
    this.pendingComputer = pending;
    try {
      const { authorized } = await invokeNative(descriptor, () => adapter!.inspect());
      if (this.pendingComputer !== pending) throw new Error('COMPUTER_STOPPED');
      if (!authorized) throw new Error('COMPUTER_OS_PERMISSION_REQUIRED');
      if (nativeCapability('native.computer-use', 'desktop', adapter).state !== 'available') throw new Error('COMPUTER_UNAVAILABLE');
      this.computer.begin(id, appId);
    } finally {
      if (this.pendingComputer === pending) this.pendingComputer = undefined;
    }
  }

  stopComputerUse(id?: string): void {
    if (id === undefined || id === this.pendingComputer?.sessionId) this.pendingComputer = undefined;
    this.computer?.stop(id);
  }

  computerOwner(): ComputerSettings['owner'] { return this.computer?.owner(); }

  private computerTools(sessionId: string): Tool[] {
    const controller = this.computer;
    if (controller?.owner()?.sessionId !== sessionId) return [];
    return [
      {
        name: 'computer_snapshot', description: 'Observe the permitted foreground desktop window. If the assigned app is not ready, wait for the user to bring it forward. Take a new snapshot after every action.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        risk: 'read', source: 'builtin', untrusted: true,
        execute: async (_args, ctx) => JSON.stringify(await controller.snapshot(ctx.sessionId, ctx.signal)),
      },
      {
        name: 'computer_act', description: 'Press an accessibility control or set a text field using its ref from the current native window snapshot. If the outcome is uncertain, ask the user to inspect it before attempting another action.',
        parameters: { type: 'object', properties: { ref: { type: 'string' }, kind: { type: 'string', enum: ['press', 'set-text'] }, text: { type: 'string' } },
          required: ['ref', 'kind'], additionalProperties: false },
        risk: 'exec', source: 'builtin',
        execute: async ({ ref, kind, text }, ctx) => {
          if (typeof ref !== 'string' || (kind !== 'press' && (kind !== 'set-text' || typeof text !== 'string'))) throw new Error('COMPUTER_ACTION_INVALID');
          return controller.act(ctx.sessionId, ref, kind === 'press' ? { kind } : { kind, text }, ctx.signal);
        },
      },
    ];
  }

  getSettings(surface: CapabilitySurface = 'cli'): SettingsSnapshot {
    return { ...getSettings(), capabilities: this.listCapabilities(surface) };
  }

  updateSettings(input: unknown, surface: CapabilitySurface = 'cli'): SettingsWriteResult {
    const { result, config, changedKeys } = writeSettings(input, patch =>
      this.runs.size > 0 || (Object.keys(patch.changes ?? {}).some(key => key.startsWith('sandbox.'))
        && this.jobs.list().some(job => job.state === 'running')),
    );
    if (!result.ok || !config) return result;
    if (changedKeys?.some(key => key.startsWith('sandbox.'))) {
      for (const sb of this.sandboxes.values()) sb.dispose?.();
      this.sandboxes.clear();
    }
    if (changedKeys?.every(key => key.startsWith('ui.'))) {
      this.config = { ...this.config, ui: config.ui };
    } else {
      this.config = { ...config, plugins: this.config.plugins };
      if (!this.opts.providerFactory) this.factory = createProviderFactory(config);
      this.personalKb = new LocalMarkdownKB(config.kb.roots);
      this.hybridKb = this.makeHybrid();
    }
    this.broadcast({ kind: 'settings', revision: result.snapshot.revision });
    return { ...result, snapshot: { ...result.snapshot, capabilities: this.listCapabilities(surface) } };
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
    return SessionLog.list().map((s) => ({
      ...s,
      ...(this.isRunning(s.id) && (s.status === 'idle' || this.startupHooks.has(s.id)) ? { status: 'running' as const } : {}),
      contextWindow: contextWindowOf(this.config, s.model === 'auto' ? this.config.defaultModel : s.model),
    }));
  }

  /** Pin or archive a session (organization only; logged, not model-visible). */
  setSessionFlags(id: string, flags: { pinned?: boolean; archived?: boolean }): SessionSummary {
    const log = SessionLog.open(id);
    if (!log.meta()) throw new Error('Session is no longer available.');
    const cur = log.last('session/flags');
    this.append(log, { type: 'session/flags', pinned: flags.pinned ?? cur?.pinned ?? false, archived: flags.archived ?? cur?.archived ?? false });
    if (flags.archived) this.stopComputerUse(id);
    this.broadcastSessions();
    return log.summary()!;
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
    const selectedMode = input.mode ?? this.config.defaultMode;
    const mode = this.modes.has(selectedMode) ? selectedMode : 'coding';
    const preferredCwd = input.cwd ?? (mode === 'coding' || mode === 'plan' ? input.repoCwd : undefined);
    let cwd = preferredCwd && existsSync(preferredCwd) ? preferredCwd : this.defaultCwd(mode);
    const worktree = input.worktree ? createWorktree(cwd, randomUUID().slice(0, 8), input.worktreeBase) : undefined;
    if (worktree) {
      // Keep the same sub-folder inside the worktree when the session started below the repo root.
      const sub = relative(realpathSync(worktree.repo), realpathSync(cwd));
      const folder = join(worktree.path, sub);
      cwd = sub && isInside(worktree.path, folder) && existsSync(folder) && isInside(realpathSync(worktree.path), realpathSync(folder))
        ? folder : worktree.path;
    }
    const log = SessionLog.create({ mode, cwd, model: input.model || this.config.defaultModel, title: input.title, parent: input.parent, worktree, approval: input.approval, sandbox: input.sandbox });
    this.broadcastSessions();
    return log.summary()!;
  }

  deleteSession(id: string): void {
    const ids = [`session:${id}`];
    this.moveStorage({ ids, revision: this.previewStorage(ids).revision });
  }

  storageInventory(includeProfiles?: boolean) {
    return this.storage.inventory(includeProfiles);
  }

  previewStorage(ids: string[], includeProfiles?: boolean) {
    return this.storage.preview(ids, includeProfiles);
  }

  moveStorage(input: StorageConfirmation) {
    const operation = this.storage.move(input);
    if (operation.moved) this.storageChanged();
    return operation;
  }

  private storageChanged(): void {
    for (const id of new Set([...this.sandboxes.keys(), ...this.kernels.keys()])) {
      if (SessionLog.exists(id)) continue;
      this.sandboxes.get(id)?.dispose?.();
      this.sandboxes.delete(id);
      this.kernels.get(id)?.dispose();
      this.kernels.delete(id);
    }
    this.broadcastSessions();
  }

  storageOperations() {
    return this.storage.operations();
  }

  private holdSession(id: string, execution = false): () => void {
    return holdDataActivity(`session:${id}`, () => {
      if (!SessionLog.exists(id)) throw new Error('Session is no longer available.');
      if (!execution) return;
      const log = SessionLog.open(id);
      const closed = log.last('worktree/closed');
      if (closed) throw new Error(`This session's worktree was ${closed.action}; start a new session to continue.`);
      const cwd = log.meta()!.cwd;
      const root = homePath('worktrees');
      const managed = existsSync(root) ? realpathSync(root) : root;
      const current = existsSync(cwd) ? realpathSync(cwd) : cwd;
      const tracked = isInside(root, cwd) && cwd !== root ? relative(root, cwd)
        : isInside(managed, current) && current !== managed ? relative(managed, current) : undefined;
      if (tracked) {
        const path = join(root, tracked.split(sep)[0]);
        if (!existsSync(cwd)) throw new Error('WORKTREE_MISSING: The worktree workspace is unavailable.');
        if (hasDataActivity(`worktree-setup:${path}`)) throw new Error('WORKTREE_ACTIVE: Worktree setup is running.');
        const ownerId = log.meta()!.worktree ? id : this.listSessions().find(session => session.worktree && !session.worktree.closed
          && SessionLog.open(session.id).meta()?.worktree?.path === path)?.id;
        const owner = ownerId === id ? log : ownerId ? SessionLog.open(ownerId) : undefined;
        if (owner && this.worktreeRecovery(owner)) throw new Error('WORKTREE_RECOVERY_REQUIRED: Inspect and acknowledge the interrupted operation.');
        if (owner?.last('worktree/merge')?.state === 'applied') throw new Error('WORKTREE_ALREADY_MERGED: Start a new session to continue.');
      }
    });
  }

  renameSession(id: string, title: string): void {
    this.append(SessionLog.open(id), { type: 'session/title', title, source: 'user' });
  }

  private append(log: SessionLog, body: Parameters<SessionLog['append']>[0], flush = false): SessionEvent {
    const event = log.append(body, flush);
    this.broadcast({ kind: 'event', sessionId: log.id, event });
    return event;
  }

  isRunning(id: string): boolean {
    return this.runs.has(id) || this.startupHooks.has(id);
  }

  /** Send a user message. If a run is active, the message is queued and delivered when it ends. */
  async send(id: string, text: string, source: 'user' | 'schedule' | 'system' | 'job' | 'verify' | 'trigger' = 'user', opts: { images?: { data: string; mime: string }[]; noDetect?: boolean } = {}): Promise<void> {
    const release = this.holdSession(id, true);
    try { await this.sendActive(id, text, source, opts); } finally { release(); }
  }

  private async sendActive(id: string, text: string, source: 'user' | 'schedule' | 'system' | 'job' | 'verify' | 'trigger',
    opts: { images?: { data: string; mime: string }[]; noDetect?: boolean; appshot?: PreparedAppshot; onAppshotCommitted?: () => void }): Promise<void> {
    const log = this.startupHooks.get(id)?.log ?? SessionLog.open(id);
    if (!log.meta()) throw new Error(`No session ${id}`);
    if (opts.appshot && this.isRunning(id)) throw new Error('APPSHOT_SESSION_BUSY');
    const body = this.prepareUserMessage(log, text, source, opts.images ?? []);
    const appendUserMessage = () => {
      const image = opts.appshot ? storeAppshot(log.attachmentDir(), opts.appshot) : undefined;
      if (!image) return this.append(log, body);
      // Flush the receipt before publishing it to the UI, plugins, or the next model request.
      let event: SessionEvent;
      try {
        event = log.append({ ...body, images: [...(body.images ?? []), image] }, true);
      } catch (error) {
        // A write can reach the file before a flush fails. Preserve any visible receipt and spend its approval.
        try {
          const referenced = SessionLog.open(log.id).all().some(entry =>
            entry.type === 'user/message' && entry.images?.some(attachment => attachment.path === image.path));
          if (referenced) opts.onAppshotCommitted?.();
          else rmSync(image.path, { force: true });
        } catch { /* The receipt state is uncertain. Keep the prepared attachment. */ }
        throw error;
      }
      opts.onAppshotCommitted?.();
      this.broadcast({ kind: 'event', sessionId: log.id, event });
      return event;
    };
    if (this.isRunning(id)) {
      this.queued.set(id, [...(this.queued.get(id) ?? []), body]);
      return;
    }
    const closed = log.last('worktree/closed');
    if (closed) throw new Error(`This session's worktree was ${closed.action}; start a new session to continue.`);
    if (!log.all().some(e => e.type === 'user/message') && this.opts.shellHooks !== false
      && inspectHooks(log.meta()!.cwd).hooks.some(hook => hook.event === 'sessionStart' && !hook.worktreeSetup && hook.status === 'trusted')) {
      const controller = new AbortController();
      this.startupHooks.set(id, { controller, log });
      this.broadcastSessions();
      try {
        await this.ensureProxy();
        const ctx = await this.sessionHooks(log).sessionStart(id, controller.signal);
        if (controller.signal.aborted) {
          appendUserMessage();
          this.append(log, { type: 'run/status', status: 'aborted', reason: 'user' });
          return;
        }
        if (ctx) this.append(log, { type: 'user/message', text: `[sessionStart hook context]\n${ctx}`, source: 'hook' });
      } finally {
        this.startupHooks.delete(id);
        if (controller.signal.aborted) this.broadcastSessions();
      }
    }
    // Scheduling intent ("every weekday at 9 summarize my mail"): propose an automation instead of answering now.
    const intent = source === 'user' && this.config.automations?.detect !== false && !opts.noDetect && !body.command ? parseSchedule(text) : undefined;
    if (intent && intent.prompt.length > 2) {
      appendUserMessage();
      if (log.meta()!.title === 'New session' && !log.last('session/title')) this.append(log, { type: 'session/title', title: `⏲ ${intent.prompt.slice(0, 55)}`, source: 'first-message' });
      this.append(log, {
        type: 'automation/proposal',
        proposalId: randomUUID().slice(0, 8),
        title: intent.prompt.replace(/\s+/g, ' ').slice(0, 60),
        prompt: intent.prompt,
        ...(intent.cron ? { cron: intent.cron } : { at: intent.at }),
        description: intent.description,
      });
      this.broadcastSessions();
      return;
    }
    if (source === 'user') this.recallMemories(log, text);
    appendUserMessage();
    if (log.meta()!.title === 'New session' && !log.last('session/title')) {
      const t = text.replace(/\s+/g, ' ').trim();
      this.append(log, { type: 'session/title', title: t.length > 60 ? t.slice(0, 57) + '...' : t || 'Untitled', source: 'first-message' });
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
    } else if (text.trim().startsWith('/')) {
      const skill = expandSkillCommand(text, this.listSkills(cwd));
      if (skill) {
        body = skill.prompt;
        command = { name: skill.name, input: text };
      }
    }
    const m = expandMentions(body, cwd);
    const dir = log.attachmentDir();
    let n = m.images.length || images.length ? readdirSync(ensureDir(dir)).length : 0;
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
  readAttachment(path: string, expected?: AppshotMetadata): { data: string; mime: string } {
    if (expected !== undefined) {
      const mime = imageMime(path);
      const bytes = mime && readAppshot(path, mime, expected);
      if (!bytes || !mime) throw new Error('APPSHOT_ATTACHMENT_UNAVAILABLE');
      return { data: bytes.toString('base64'), mime };
    }
    const abs = ownedAttachment(path);
    if (!abs) throw new Error('Not an attachment.');
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

  /** What the next request to the model would contain, measured section by section (Claude Code /context). */
  async contextUsage(sessionId: string): Promise<ContextReport> {
    const log = SessionLog.open(sessionId);
    if (!log.meta()) throw new Error(`No session ${sessionId}`);
    const model = log.currentModel() === 'auto' ? this.routeAuto(log) : log.currentModel();
    const tools = (await this.toolsFor(log)).filter((t) => this.modeAllows(log.currentMode(), t, !!log.meta()?.parent));
    return buildContextReport({
      sessionId,
      model,
      window: contextWindowOf(this.config, model),
      compactAt: compactionLimit(this.config, model),
      system: this.systemPromptSections(log, model),
      tools: tools.map(toSchema),
      events: log.all(),
    });
  }

  async contextReportHtml(sessionId: string): Promise<string> {
    const title = SessionLog.open(sessionId).summary()?.title ?? sessionId;
    return contextReportHtml(await this.contextUsage(sessionId), `Context · ${title}`);
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
    return withStorageLock(() => {
      if (this.runs.has(sessionId) || hasDataActivity(`session:${sessionId}`)) throw new Error('Stop the run before rewinding.');
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
      const copied = before.filter(event => event.type !== 'session/meta' && event.type !== 'run/status' && event.type !== 'session/title');
      const importedThrough = meta.importedThrough;
      const log = SessionLog.create({
        title: `${title} (rewound)`, mode: at('mode/switch')?.to ?? meta.mode, cwd: meta.cwd,
        model: at('model/switch')?.to ?? meta.model, approval: meta.approval, sandbox: meta.sandbox,
        forkOf: { session: sessionId, seq: opts.beforeSeq },
        importedThrough: importedThrough === undefined ? undefined : copied.filter(event => event.seq <= importedThrough).length,
      });
      for (const e of copied) {
        const { seq: _s, ...body } = e;
        if (body.type === 'context/compaction') {
          const cut = body.upToSeq;
          body.upToSeq = copied.findLastIndex(event => event.seq <= cut) + 1;
        }
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
    });
  }

  private credentialValues(): (string | undefined)[] {
    const credentials = Object.values(this.config.providers).flatMap(provider => [
      provider.apiKey,
      ...Object.entries(provider.headers ?? {})
        .flatMap(([name, value]) => typeof value === 'string' && /authorization|api[-_]?key|token|secret|cookie/i.test(name)
          ? [value, value.replace(/^(?:Bearer|Basic)\s+/i, '')] : []),
    ]);
    return [...credentials, ...secretEnvNames(this.config).map(name => process.env[name])];
  }

  private exportableEvents(sessionId: string): SessionEvent[] {
    const log = SessionLog.open(sessionId);
    if (!log.meta()) throw new Error(`No session ${sessionId}`);
    return redactSessionEvents(log.all(), this.credentialValues());
  }

  exportSession(sessionId: string, format: 'markdown' | 'html' | 'jsonl' = 'markdown'): string {
    const events = this.exportableEvents(sessionId);
    if (format === 'jsonl') return events.map(event => JSON.stringify(event) + '\n').join('');
    return format === 'html' ? sessionToHtml(events) : sessionToMarkdown(events);
  }

  importSession(jsonl: string, options?: SessionImportOptions): SessionSummary {
    const imported = importTranscript(jsonl, options);
    this.broadcastSessions();
    return imported;
  }

  exportSessionBundle(sessionId: string) {
    return exportBundle(this.exportableEvents(sessionId));
  }

  async importSessionBundle(input: AsyncIterable<Uint8Array>, options?: SessionImportOptions, beforePublish?: () => void): Promise<SessionSummary> {
    const imported = await importBundle(input, options, beforePublish);
    this.broadcastSessions();
    return imported;
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

  // ---------- file changes ----------

  async reviewSession(sessionId: string): Promise<string> {
    const report = await this.runReview(sessionId);
    return report ? reviewText(report) : 'No file changes to review.';
  }

  private reviewChanges(sessionId: string, cwd: string, worktree?: WorktreeInfo): ReviewChange[] {
    if (worktree) return worktreeReviewChanges(worktree).map(change => ({
      ...change,
      ...(isIgnored(worktree.path, join(worktree.path, change.path)) && { omission: 'ignored' as const }),
    }));
    const root = realpathSync(cwd);
    const project = findProjectRoot(cwd);
    return this.sessionChanges(sessionId, { includeContentDigest: true }).map(change => {
      const path = change.path.split(sep).join('/');
      let omission: ReviewChange['omission'];
      if (!isInside(cwd, change.abs) || /[\r\n\0]/.test(path)
        || (existsSync(change.abs) && !isInside(root, realpathSync(change.abs)))) omission = 'outside-workspace';
      else if (isIgnored(project, change.abs)) omission = 'ignored';
      else if (change.binary) omission = 'binary';
      return { path, status: change.status, diff: change.diff, contentDigest: change.contentDigest, omission };
    });
  }

  reviewStatus(sessionId: string): ReviewStatus {
    const log = SessionLog.open(sessionId);
    const minimumSeverity = this.config.review.minimumSeverity;
    const request = log.last('review/request');
    const report = log.last('review/report');
    if (request && (!report || report.seq < request.seq)) {
      return { minimumSeverity, state: this.reviews.has(sessionId) ? 'running' : 'interrupted' };
    }
    if (!report) return { minimumSeverity, state: 'none' };
    if (!report.review) return { minimumSeverity, state: 'legacy', text: report.text };
    let state: ReviewStatus['state'] = 'stale';
    try {
      if (reviewDigest(this.reviewChanges(sessionId, log.meta()!.cwd, log.meta()?.worktree)) === report.review.digest) state = report.review.state;
    } catch { /* The reviewed workspace is no longer available. */ }
    return { state, report: report.review, text: report.text, minimumSeverity };
  }

  private runReview(sessionId: string, signal?: AbortSignal): Promise<ReviewOutcome | undefined> {
    const active = this.reviews.get(sessionId);
    if (active) return active;
    const release = this.holdSession(sessionId);
    const pending = Promise.resolve().then(() => this.executeReview(sessionId, signal)).finally(() => {
      this.reviews.delete(sessionId);
      release();
    });
    this.reviews.set(sessionId, pending);
    return pending;
  }

  private async executeReview(sessionId: string, signal?: AbortSignal): Promise<ReviewOutcome | undefined> {
    const log = SessionLog.open(sessionId);
    const cwd = log.meta()!.cwd;
    const changes = this.reviewChanges(sessionId, cwd, log.meta()?.worktree);
    if (!changes.length) return undefined;
    const config = this.config.review;
    const digest = reviewDigest(changes);
    const { included, omissions, scope } = prepareReview(changes, config.diffBytes);
    const selected = config.model || log.currentModel();
    const modelRef = selected === 'auto' ? this.routeAuto(log) : selected;
    let request: ReviewRequest | undefined;
    let provider: ReturnType<ProviderFactory>['provider'] | undefined;
    let error: ReviewOutcome['error'];
    let findings: ReviewOutcome['findings'] = [];
    if (included.length) {
      try {
        const { provider: resolved, model } = this.factory(modelRef);
        provider = resolved;
        const context = config.rules === 'none' ? undefined : loadProjectContext(cwd);
        const rules = context?.rules.filter(rule => config.rules === 'all' || config.rules === rule.scope) ?? [];
        const paths = included.map(file => relative(context?.root ?? cwd, join(log.meta()?.worktree?.path ?? cwd, file.path)));
        const matching = context && config.rules !== 'global'
          ? rulesForFiles(context.fileRules, paths).map(rule => ({ ...rule, scope: 'project' as const })) : [];
        const selectedRules = applyRuleBudgets([...rules, ...matching], DEFAULT_RULE_BUDGETS)
          .map(({ source, text }) => ({ source, text }));
        request = {
          model, system: REVIEW_SYSTEM, tools: [], maxTokens: 4096,
          messages: [{ role: 'user', content: JSON.stringify({ rules: selectedRules, files: included }) }],
        };
      } catch {
        error = 'PROVIDER_ERROR';
      }
    }
    const recorded = this.append(log, { type: 'review/request', digest, modelRef, omissions, ...(request && { request }) }, true);
    if (request && provider) {
      let text: string | undefined;
      try {
        if (signal?.aborted) throw new Error('Review aborted.');
        const result = await provider.complete({ ...request, signal });
        if (signal?.aborted) throw new Error('Review aborted.');
        if (result.toolCalls.length) error = 'INVALID_RESPONSE';
        else text = result.text;
      } catch {
        error = signal?.aborted ? 'ABORTED' : 'PROVIDER_ERROR';
      }
      if (text !== undefined) {
        try { findings = validateReviewFindings(text, scope); }
        catch { error = 'INVALID_RESPONSE'; }
      }
    }
    const report: ReviewOutcome = {
      requestSeq: recorded.seq, digest, findings, omissions,
      state: error ? 'failed' : omissions.length ? 'incomplete' : findings.length ? 'findings' : 'passed',
      ...(error && { error }),
    };
    this.append(log, { type: 'review/report', text: reviewText(report), review: report }, true);
    return report;
  }

  private async checkReviewGate(id: string, signal: AbortSignal): Promise<boolean> {
    try {
      const report = await this.runReview(id, signal);
      return !report || report.state === 'passed' && this.reviewStatus(id).state === 'passed';
    } catch {
      return false;
    }
  }

  /** Checkpoint changes compare the first saved content in the range with the next snapshot or live file. */
  sessionChanges(sessionId: string, opts: { fromSeq?: number; toSeq?: number; includeContentDigest?: boolean } = {}): FileChange[] {
    const log = SessionLog.open(sessionId);
    const cwd = log.meta()!.cwd;
    const cps = log.all().filter((e): e is Extract<SessionEvent, { type: 'checkpoint' }> => e.type === 'checkpoint');
    const snap = (id: string) => {
      try {
        return JSON.parse(readFileSync(homePath('checkpoints', sessionId, `${id}.json`), 'utf8')) as { files: { path: string; before: string | null }[] };
      } catch {
        return { files: [] };
      }
    };
    const from = opts.fromSeq ?? -1;
    const to = opts.toSeq ?? Number.POSITIVE_INFINITY;
    const before = new Map<string, string | null>();
    for (const c of cps) {
      if (c.seq < from || c.seq > to) continue;
      for (const f of snap(c.id).files) if (!before.has(f.path)) before.set(f.path, f.before);
    }
    const afterOf = (path: string): string | null => {
      for (const c of cps) {
        if (c.seq <= to) continue;
        const f = snap(c.id).files.find((x) => x.path === path);
        if (f) return f.before;
      }
      return existsSync(path) ? readFileSync(path, 'utf8') : null;
    };
    const out: FileChange[] = [];
    for (const [abs, b] of before) {
      const a = afterOf(abs);
      if (a === b) continue;
      const rel = relative(cwd, abs) || abs;
      const binary = (a ?? '').includes('\u0000') || (b ?? '').includes('\u0000');
      const diff = binary ? '' : unifiedDiff(b ?? '', a ?? '', rel);
      const st = diffStats(diff);
      const contentDigest = opts.includeContentDigest
        ? createHash('sha256').update(JSON.stringify([b, a])).digest('hex') : undefined;
      out.push({ path: rel, abs, status: b === null ? 'added' : a === null ? 'deleted' : 'modified', additions: st.added, deletions: st.removed, diff, binary, ...(contentDigest && { contentDigest }) });
    }
    if (opts.fromSeq === undefined && opts.toSeq === undefined) {
      // Files tools wrote without checkpoints (screenshots, figures) count as added.
      for (const d of this.deliverables(sessionId)) if (!before.has(d.abs)) {
        const contentDigest = opts.includeContentDigest ? createHash('sha256').update(readFileSync(d.abs)).digest('hex') : undefined;
        out.push({ path: d.path, abs: d.abs, status: 'added', additions: 0, deletions: 0, diff: '', binary: true, ...(contentDigest && { contentDigest }) });
      }
    }
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  /** Restore one file to its state before the session (or before fromSeq); undoable, and the model is told. */
  revertFile(sessionId: string, path: string, opts: { fromSeq?: number } = {}): FileChange | undefined {
    if (this.runs.has(sessionId)) throw new Error('Stop the run before reverting files.');
    const log = SessionLog.open(sessionId);
    const cwd = log.meta()!.cwd;
    const abs = resolveIn(cwd, path);
    const change = this.sessionChanges(sessionId, { fromSeq: opts.fromSeq }).find((c) => c.abs === abs);
    if (!change) throw new Error(`${path} has no changes in this session${opts.fromSeq !== undefined ? ' from that point' : ''}.`);
    let baseline: string | null = null;
    for (const c of log.all()) {
      if (c.type !== 'checkpoint' || c.seq < (opts.fromSeq ?? -1)) continue;
      const f = (JSON.parse(readFileSync(homePath('checkpoints', sessionId, `${c.id}.json`), 'utf8')) as { files: { path: string; before: string | null }[] }).files.find((x) => x.path === abs);
      if (f) {
        baseline = f.before;
        break;
      }
    }
    this.checkpoint(log, [abs]);
    if (baseline === null) rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, baseline);
    }
    this.append(log, { type: 'file/revert', path: change.path, ...(opts.fromSeq !== undefined ? { fromSeq: opts.fromSeq } : {}) });
    this.append(log, { type: 'user/message', source: 'system', text: `[The user reverted ${change.path} to its state before ${opts.fromSeq !== undefined ? 'that turn' : 'this session'}${baseline === null ? ' (the file was removed)' : ''}. Read it again before editing it.]` });
    this.broadcastSessions();
    return change;
  }

  /** A workspace file for the change viewer (only inside the session's workspace; large files truncated). */
  readSessionFile(sessionId: string, path: string): { path: string; content: string; size: number; truncated: boolean; binary: boolean } {
    const cwd = SessionLog.open(sessionId).meta()!.cwd;
    const abs = resolveIn(cwd, path);
    if (!isInside(cwd, abs)) throw new Error('Only files inside the session workspace can be shown.');
    if (!existsSync(abs)) throw new Error(`${path} does not exist (deleted?).`);
    const size = statSync(abs).size;
    const buf = readFileSync(abs);
    const binary = buf.subarray(0, 8000).includes(0);
    const max = 1_000_000;
    return { path: relative(cwd, abs) || abs, content: binary ? '' : buf.subarray(0, max).toString('utf8'), size, truncated: size > max, binary };
  }

  /** One directory inside the session workspace, for the Files pane. `..` and ignored names are omitted. */
  listWorkspace(sessionId: string, rel = '.'): { name: string; dir: boolean }[] {
    const cwd = SessionLog.open(sessionId).meta()!.cwd;
    const abs = resolveIn(cwd, rel || '.');
    if (!isInside(cwd, abs)) throw new Error('Only folders inside the session workspace can be listed.');
    const skip = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'coverage', '.venv', '__pycache__']);
    const root = findProjectRoot(cwd);
    return readdirSync(abs, { withFileTypes: true })
      .filter((e) => !skip.has(e.name) && !isIgnored(root, join(abs, e.name)))
      .map((e) => ({ name: e.name, dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  }

  // ---------- automations ----------

  /** Answer a scheduling proposal: create the automation, run the message now, or both. */
  resolveProposal(sessionId: string, proposalId: string, action: 'create' | 'run' | 'both', edits: { title?: string; prompt?: string; schedule?: string } = {}): { automation?: Automation } {
    const log = SessionLog.open(sessionId);
    const p = log.all().find((e) => e.type === 'automation/proposal' && e.proposalId === proposalId) as Extract<SessionEvent, { type: 'automation/proposal' }> | undefined;
    if (!p) throw new Error('No such proposal.');
    if (log.all().some((e) => e.type === 'automation/resolved' && e.proposalId === proposalId)) throw new Error('That proposal was already answered.');
    let automation: Automation | undefined;
    if (action !== 'run') {
      automation = this.createAutomation({ title: edits.title ?? p.title, prompt: edits.prompt ?? p.prompt, ...(edits.schedule ? { schedule: edits.schedule } : p.cron ? { cron: p.cron } : { at: p.at }), mode: log.currentMode(), cwd: log.meta()!.cwd, source: sessionId });
    }
    this.append(log, { type: 'automation/resolved', proposalId, action, ...(automation ? { automationId: automation.id } : {}) });
    if (automation) {
      // Keep the conversation coherent for the model: the scheduling request was answered.
      this.append(log, {
        type: 'assistant/message',
        text: `Scheduled “${automation.title}” — ${automation.description}${automation.nextRun ? `; next run ${new Date(automation.nextRun).toLocaleString()}` : ''}. It runs in its own session while the gateway or desktop app is running; manage it under Automations.`,
        toolCalls: [],
        model: 'harness',
      });
    }
    if (action !== 'create') this.startRun(sessionId);
    else this.broadcastSessions();
    return { automation };
  }

  previewSchedule(text: string): { cron?: string; at?: string; description: string; next: string[] } | undefined {
    const s = text.trim();
    if (/^[\d*/,-]+(\s+[\d*/,-]+){4}$/.test(s)) {
      parseCron(s);
      return { cron: s, description: describeCron(s), next: nextRuns(s, new Date(), 3).map((d) => d.toISOString()) };
    }
    const p = parseSchedule(s, new Date(), { explicit: true });
    if (!p) return undefined;
    return { cron: p.cron, at: p.at, description: p.description, next: p.cron ? nextRuns(p.cron, new Date(), 3).map((d) => d.toISOString()) : [p.at!] };
  }

  listAutomations(): Automation[] {
    return listSchedules().map((t) => this.toAutomation(t));
  }

  private toAutomation(t: ScheduledTask): Automation {
    const next = t.enabled ? (t.cron ? nextRuns(t.cron, new Date(), 1)[0]?.toISOString() : !t.lastRun ? t.at : undefined) : undefined;
    return { ...t, description: t.cron ? describeCron(t.cron) : `once at ${t.at ? new Date(t.at).toLocaleString() : '?'}`, nextRun: next, lastStatus: t.runs?.[0]?.status };
  }

  createAutomation(input: { title?: string; prompt: string; schedule?: string; cron?: string; at?: string; mode?: string; model?: string; cwd?: string; chats?: string[]; source?: string; catchUp?: boolean }): Automation {
    let { cron, at } = input;
    if (input.schedule) {
      const p = this.previewSchedule(input.schedule);
      if (!p) throw new Error(`Could not understand the schedule "${input.schedule}". Try "every weekday at 9:00", "每天晚上8点", "tomorrow at 15:00" or a cron expression.`);
      cron = p.cron;
      at = p.at;
    }
    const mode = input.mode && this.modes.has(input.mode) ? input.mode : 'assistant';
    const t = addSchedule({
      title: (input.title ?? input.prompt).replace(/\s+/g, ' ').slice(0, 60),
      prompt: input.prompt,
      cron,
      at,
      mode,
      cwd: input.cwd ?? this.defaultCwd(mode),
      ...(input.model ? { model: input.model } : {}),
      ...(input.chats?.length ? { chats: input.chats } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.schedule ? { schedule: input.schedule } : {}),
      ...(input.catchUp === false ? { catchUp: false } : {}),
    });
    this.broadcast({ kind: 'notice', level: 'info', text: `Automation created: ${t.title}` });
    return this.toAutomation(t);
  }

  updateAutomation(id: string, patch: { title?: string; prompt?: string; schedule?: string; enabled?: boolean; mode?: string; model?: string; chats?: string[]; catchUp?: boolean; cwd?: string }): Automation {
    const { schedule, ...rest } = patch;
    let timing: { cron?: string; at?: string } = {};
    if (schedule) {
      const p = this.previewSchedule(schedule);
      if (!p) throw new Error(`Could not understand the schedule "${schedule}".`);
      timing = p.cron ? { cron: p.cron } : { at: p.at };
    }
    return this.toAutomation(updateSchedule(id, { ...rest, ...timing, ...(schedule ? { schedule } : {}), ...(timing.at ? { lastRun: undefined } : {}) }));
  }

  deleteAutomation(id: string): void {
    removeSchedule(id);
  }

  /** Start one run of an automation in a new session; its outcome is recorded and announced. */
  async runAutomation(id: string, opts: { catchUp?: boolean; at?: Date } = {}): Promise<string> {
    const t = listSchedules().find((x) => x.id === id);
    if (!t) throw new Error(`No automation ${id}`);
    const s = this.createSession({ cwd: existsSync(t.cwd) ? t.cwd : undefined, mode: t.mode, model: t.model, title: `[automation] ${t.title}` });
    const at = (opts.at ?? new Date()).toISOString();
    recordRun(t.id, { at, sessionId: s.id, status: 'running', ...(opts.catchUp ? { catchUp: true } : {}) });
    this.broadcast({ kind: 'automation', id: t.id, title: t.title, sessionId: s.id, status: 'running' });
    await this.send(s.id, opts.catchUp ? `${t.prompt}\n\n(This is a catch-up run: the scheduled time passed while sun-harness was not running.)` : t.prompt, 'schedule');
    void this.wait(s.id).then((r) => {
      const text = SessionLog.open(s.id).last('assistant/message')?.text;
      recordRun(t.id, { at, sessionId: s.id, status: r?.status ?? 'idle', ...(r?.reason ? { reason: r.reason } : {}), ...(opts.catchUp ? { catchUp: true } : {}) });
      this.broadcast({ kind: 'automation', id: t.id, title: t.title, sessionId: s.id, status: r?.status ?? 'idle', text, chats: t.chats });
    });
    return s.id;
  }

  /** Resume a paused/errored/aborted session, optionally on another model (quota recovery path). */
  resume(id: string, opts: { model?: string } = {}): void {
    if (this.isRunning(id)) return;
    const log = SessionLog.open(id);
    if (opts.model && opts.model !== log.currentModel()) this.switchModel(id, opts.model, 'user resume');
    const importedThrough = log.meta()?.importedThrough;
    if (importedThrough !== undefined && !log.all().some(event =>
      event.seq > importedThrough && event.type === 'user/message' && (!event.source || event.source === 'user'))) return;
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
    this.stopComputerUse(id);
    this.queued.delete(id);
    this.startupHooks.get(id)?.controller.abort();
    this.worktreeSetups.get(id)?.abort();
    this.runs.get(id)?.controller.abort();
  }

  /** Await the current run of a session (if any). */
  async wait(id: string): Promise<RunResult | undefined> {
    let last: RunResult | undefined;
    while (this.runs.has(id)) last = await this.runs.get(id)!.promise;
    return last;
  }

  private startRun(id: string, parentSignal?: AbortSignal): Promise<RunResult> {
    const release = this.holdSession(id, true);
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
        if (r?.status === 'idle') {
          this.extractMemories(id).catch(() => undefined);
          this.titleSession(id).catch(() => undefined);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.runs.delete(id);
        try {
          const q = this.queued.get(id);
          if (q?.length) {
            this.queued.delete(id);
            const log = SessionLog.open(id);
            for (const b of q) this.append(log, b);
            this.startRun(id);
          } else this.broadcastSessions();
        } finally {
          release();
        }
      });
    return promise;
  }

  private async buildAgent(log: SessionLog, controller: AbortController): Promise<Agent> {
      const id = log.id;
      const cwd = log.meta()!.cwd;
      await this.ensureProxy();
      const tools = await this.toolsFor(log);
      const hooks: AgentHooks | undefined = this.opts.shellHooks === false ? undefined : this.sessionHooks(log);
      return new Agent({
        log,
        config: this.config,
        resolveModel: (ref) => this.factory(ref),
        tools: () => tools.filter(t =>
          this.plugins.hasTool(t)
          && this.modeAllows(log.currentMode(), t, !!log.meta()?.parent),
        ),
        systemPrompt: (modelRef) => this.systemPrompt(log, modelRef),
        approvalMode: () => log.meta()?.approval ?? this.config.approval,
        routeModel: (ref) => (ref === 'auto' ? this.routeAuto(log) : ref),
        drainSteer: () => {
          if (this.config.steering === 'after-run') return [];
          const q = this.queued.get(id) ?? [];
          this.queued.delete(id);
          return q;
        },
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
        reviewGate: this.config.review.completionGate
          ? signal => log.currentMode() !== 'coding' ? Promise.resolve(true) : this.checkReviewGate(id, signal)
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
    for (const t of [...BUILTIN_TOOLS, ...this.researchTools, ...SERVICE_TOOLS, ...this.browserTools, ...this.connectorTools, ...this.plugins.tools, ...slowSafe, ...this.computerTools(log.id)]) byName.set(t.name, t);
    // Capability gating: drop tools whose backend is unreachable right now.
    const all = [...byName.values()];
    const ok = await Promise.all(all.map((t) => (t.available ? t.available().catch(() => false) : Promise.resolve(true))));
    return all.filter((tool, i) => ok[i] && this.plugins.hasTool(tool));
  }

  private repoMaps = new Map<string, string>();

  // ---------- browser ----------

  readonly browser = new BrowserManager(
    () => this.config.browser,
    ({ sessionId, data, ...frame }) => {
      this.broadcast({ kind: 'browser', sessionId, frame: data, ...frame, takeover: this.browser.isTakenOver(sessionId) });
    },
    new BrowserPermissions(() => this.broadcast({ kind: 'browser-permissions' })),
  );
  private browserTools = createBrowserTools(this.browser);

  // ---------- assistant: memory, routing, briefing, triggers, voice, metrics ----------

  readonly memoryStore = new MemoryStore();
  private connectorTools = dingtalkTools();
  private triggerWatchers = new TriggerWatchers();

  /** Attach relevant long-term memories before a user message (logged, so the model's view is reproducible). */
  private recallMemories(log: SessionLog, text: string): void {
    const m = this.config.memory;
    if (!m || m.enabled === false || !m.recallModes.includes(log.currentMode())) return;
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

  /** ChatGPT-style: after the first finished run, a short model-written title replaces the first-message title. */
  async titleSession(sessionId: string): Promise<string | undefined> {
    if (this.config.titles !== 'model') return undefined;
    const log = SessionLog.open(sessionId);
    const meta = log.meta();
    const current = log.last('session/title');
    if (!meta || meta.parent || current?.source === 'model' || current?.source === 'user' || /^\[/.test(log.summary()?.title ?? '')) return undefined;
    const turns = log
      .all()
      .filter((e) => (e.type === 'user/message' && (!e.source || e.source === 'user')) || (e.type === 'assistant/message' && e.text))
      .slice(0, 4)
      .map((e) => `${e.type === 'user/message' ? 'User' : 'Assistant'}: ${((e as { command?: { input: string } }).command?.input ?? (e as { text: string }).text).slice(0, 600)}`)
      .join('\n');
    if (!turns) return undefined;
    const model = this.backgroundModel(log.currentModel() === 'auto' ? this.routeAuto(log) : log.currentModel());
    const raw = await this.complete('Write a title for this conversation: at most 6 words, in the language the user writes in, no quotes, no trailing period. Answer with the title only.', turns, model);
    const title = raw.split('\n')[0].replace(/^["'“”「『]+|["'“”」』.。]+$/g, '').trim().slice(0, 80);
    if (!title || log.last('session/title')?.source === 'user') return undefined;
    this.append(log, { type: 'session/title', title, source: 'model' });
    this.broadcastSessions();
    return title;
  }

  /** Mine a finished run for durable memories with a background model call; logs memory/extract. */
  async extractMemories(sessionId: string): Promise<{ added: number }> {
    const m = this.config.memory;
    const log = SessionLog.open(sessionId);
    if (m?.enabled === false || !m?.autoExtract || !m.extractModes.includes(log.currentMode()) || log.meta()?.parent) return { added: 0 };
    const ev = log.all();
    const lastExtract = [...ev].reverse().find((e) => e.type === 'memory/extract')?.seq ?? log.meta()?.importedThrough ?? -1;
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
    if (this.config.memory.enabled === false) return { added: 0 };
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
    if (parsed.episode) {
      this.memoryStore.add(`${localDate(new Date())}: ${parsed.episode}`, 'episode', sessionId);
      appendDaily(parsed.episode, localDate(new Date()));
    }
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
  private readonly transcriptions = new TranscriptionRequests();

  cancelTranscription(requestId: string): boolean {
    return this.transcriptions.cancel(requestId);
  }

  async transcribe(audioBase64: string, mime: string, requestId?: string): Promise<string> {
    if (this.config.voice.enabled === false) throw new Error('CAPABILITY_DISABLED: Voice input is disabled.');
    const ref = this.config.voice?.stt ?? 'qwen/qwen3-asr-flash';
    const [pid, ...rest] = ref.split('/');
    const p = this.config.providers[pid];
    if (!p) throw new Error(`Unknown provider in voice.stt: ${ref}`);
    return this.transcriptions.run(requestId, signal => transcribe(Buffer.from(audioBase64, 'base64'), mime, {
      baseUrl: p.baseUrl, apiKey: providerKey(p), model: rest.join('/'), signal,
    }));
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
    for (const dir of ['screenshots', 'figures', 'slides', 'research']) {
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

  browserInfo(sessionId?: string): { available: boolean; description: string; active: boolean; takeover: boolean; profile: ReturnType<BrowserManager['profile']> } {
    return {
      available: this.browser.available(),
      description: this.browser.describe(),
      active: sessionId ? this.browser.hasTab(sessionId) : false,
      takeover: sessionId ? this.browser.isTakenOver(sessionId) : false,
      profile: this.browser.profile(),
    };
  }

  /** Start or stop streaming the session's tab to clients (live view). */
  async browserView(sessionId: string, on: boolean, viewer?: string): Promise<void> {
    if (on && !SessionLog.exists(sessionId)) throw new Error('BROWSER_SESSION_UNAVAILABLE');
    await this.browser.setScreencast(sessionId, on, viewer);
  }

  /** Taking control revokes the current agent lease. Log the transition without the credential. */
  browserTakeover(sessionId: string, on: boolean, frame?: BrowserFrameRef, control?: BrowserControl): BrowserControl | undefined {
    if (!SessionLog.exists(sessionId)) throw new Error('BROWSER_SESSION_UNAVAILABLE');
    const lease = this.browser.setTakeover(sessionId, on, frame, control);
    this.append(SessionLog.open(sessionId), { type: 'browser/takeover', on });
    this.broadcast({ kind: 'browser', sessionId, takeover: on });
    return lease;
  }

  browserInput(sessionId: string, ev: BrowserInput, frame: BrowserFrameRef, control: BrowserControl): Promise<void> {
    if (!SessionLog.exists(sessionId)) throw new Error('BROWSER_SESSION_UNAVAILABLE');
    return this.browser.input(sessionId, ev, frame, control);
  }
  previewBrowserUpload(sessionId: string) {
    if (!SessionLog.exists(sessionId)) throw new Error('BROWSER_SESSION_UNAVAILABLE');
    return this.browser.previewUpload(sessionId);
  }

  approveBrowserUpload(sessionId: string, request: BrowserUploadRequest) {
    if (!SessionLog.exists(sessionId)) throw new Error('BROWSER_SESSION_UNAVAILABLE');
    return this.browser.approveUpload(sessionId, request);
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

  private hookExecutionOptions(cwd: string, mode: SandboxMode, sessionId: string): HookRunOptions {
    const scrub = secretEnvNames(this.config);
    const redact = credentialRedactor(this.credentialValues());
    let sandbox: ExecSandbox;
    try {
      sandbox = createSandbox({
        mode, cfg: this.config.sandbox, sessionId, cwd, secretEnv: scrub, hook: true,
        protectedPaths: [homePath('settings')], proxyPort: () => this.proxy?.port,
      });
    } catch {
      sandbox = {
        kind: 'none', describe: () => 'unavailable', env: base => base,
        shell: () => { throw new Error('Hook sandbox unavailable.'); },
      };
    }
    return { sandbox, scrub, redact };
  }

  private sessionHooks(log: SessionLog) {
    const meta = log.meta()!;
    return createShellHooks(meta.cwd, {
      runOptions: () => this.hookExecutionOptions(meta.cwd, meta.sandbox ?? this.config.sandbox.mode, log.id),
      onRun: (hook, result) => {
        this.append(log, { type: 'hook/run', hookId: hook.id, event: hook.event, state: result.state, code: result.code, durationMs: result.durationMs });
      },
    });
  }

  private hookWorkspace(cwd: string): string {
    if (typeof cwd !== 'string' || !isAbsolute(cwd) || cwd.includes('\0') || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error('HOOK_WORKSPACE_REQUIRED: Choose an existing absolute workspace.');
    }
    return realpathSync(cwd);
  }

  private publicHooks(inspected: HookInspection): HookInspection {
    const redact = credentialRedactor(this.credentialValues());
    const view = (hook: HookDefinition) => ({
      ...hook, source: redact(hook.source), explicitId: hook.explicitId ? redact(hook.explicitId) : undefined,
      command: redact(hook.command), matcher: hook.matcher ? redact(hook.matcher) : undefined,
    });
    return {
      hooks: inspected.hooks.map(view),
      diagnostics: inspected.diagnostics.map(issue => ({
        ...issue, source: redact(issue.source), matcher: issue.matcher ? redact(issue.matcher) : undefined,
      })),
    };
  }

  listHooks(cwd: string): HookInspection {
    return this.publicHooks(inspectHooks(this.hookWorkspace(cwd)));
  }

  reviewHooks(cwd: string, changes: HookTrustChange[]): HookInspection {
    if (this.opts.shellHooks === false) throw new Error('CAPABILITY_DISABLED: Shell hooks are disabled.');
    return this.publicHooks(reviewHookTrust(this.hookWorkspace(cwd), changes));
  }

  async runHookFixture(request: HookFixtureRequest): Promise<HookFixtureResult> {
    if (!request || !HOOK_FIXTURES.includes(request.fixture)
      || (request.execute !== undefined && typeof request.execute !== 'boolean')) throw new Error('HOOK_FIXTURE_INVALID: Invalid hook fixture.');
    const cwd = this.hookWorkspace(request.cwd);
    const selected = inspectHooks(cwd).hooks.find(hook => hook.id === request.id && hook.digest === request.digest);
    if (!selected) throw new Error('HOOK_REVIEW_STALE: Review the latest hook definition.');
    const mode = this.config.sandbox.mode;
    const payload = hookFixturePayload(selected.event, request.fixture, cwd);
    const matches = typeof payload.tool !== 'string' || hookMatches(selected.matcher, payload.tool);
    const redact = credentialRedactor(this.credentialValues());
    const result: HookFixtureResult = {
      hook: this.publicHooks({ hooks: [selected], diagnostics: [] }).hooks[0], sandbox: mode, matches,
      payload: JSON.parse(JSON.stringify(payload, (_key, value) => typeof value === 'string' ? redact(value) : value)),
    };
    if (request.execute !== true) return result;
    if (selected.worktreeSetup) throw new Error('WORKTREE_SETUP_ACTION_REQUIRED: Run setup through its owning worktree.');
    if (this.opts.shellHooks === false) throw new Error('CAPABILITY_DISABLED: Shell hooks are disabled.');
    if (selected.status !== 'trusted' || !matches) throw new Error('HOOK_FIXTURE_DENIED: A reviewed matching hook is required.');
    const id = request.requestId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) || this.hookFixtures.has(id) || this.hookFixtures.size >= 8) {
      throw new Error('HOOK_FIXTURE_INVALID: Invalid or busy fixture execution ID.');
    }
    const controller = new AbortController();
    this.hookFixtures.set(id, controller);
    try {
      await this.ensureProxy();
      if (!inspectHooks(cwd).hooks.some(hook => hook.id === selected.id && hook.digest === selected.digest && hook.status === 'trusted')) {
        throw new Error('HOOK_REVIEW_STALE: Review the latest hook definition.');
      }
      return { ...result, execution: await runHook(selected, payload, cwd, { ...this.hookExecutionOptions(cwd, mode, id), signal: controller.signal }) };
    } finally {
      this.hookFixtures.delete(id);
    }
  }

  cancelHookFixture(id: string): boolean {
    const fixture = this.hookFixtures.get(id);
    fixture?.abort();
    return !!fixture;
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
    return this.systemPromptSections(log, modelRef)
      .map((x) => x.text)
      .join('\n\n');
  }

  /** Paths the conversation has already opened, relative to the project root (for glob rules). */
  private touchedPaths(log: SessionLog): string[] {
    const cwd = log.meta()!.cwd;
    const root = findProjectRoot(cwd);
    const out = new Set<string>();
    const add = (p: string) => {
      const rel = relative(root, resolveIn(cwd, p)).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) out.add(rel);
    };
    for (const e of log.all()) {
      if (e.type === 'user/message') {
        for (const m of e.text.matchAll(/<attached file="([^"]+)"/g)) add(m[1]);
      } else if (e.type === 'assistant/message') {
        for (const c of e.toolCalls) {
          try {
            const args = JSON.parse(c.arguments) as Record<string, unknown>;
            if (typeof args.path === 'string') add(args.path);
            if (Array.isArray(args.files)) for (const f of args.files) if (typeof f === 'string') add(f);
          } catch {
            /* malformed tool arguments are logged as-is */
          }
        }
      }
    }
    return [...out];
  }

  systemPromptSections(log: SessionLog, modelRef: string): { title: string; text: string }[] {
    const meta = log.meta()!;
    const mode = this.modes.get(log.currentMode()) ?? this.modes.get('coding')!;
    const project = loadProjectContext(meta.cwd, this.config.rules);
    const scoped = rulesForFiles(project.fileRules, this.touchedPaths(log));
    return buildSystemPromptSections({
      mode,
      cwd: meta.cwd,
      model: modelRef,
      project,
      skills: this.listSkills(meta.cwd).map((s) => ({ name: s.name, description: s.description })),
      memory: this.config.memory.enabled === false ? undefined : readMemory(),
      user: readUserProfile(),
      personalInstructions: readPersonalInstructions(),
      repoMap: this.repoMapFor(log),
      untrustedNote: this.config.taint.enabled,
      sandbox: this.sandboxFor(log).kind === 'none' ? undefined : `${this.sandboxFor(log).describe()}. Writes outside the workspace fail with "Operation not permitted"${this.config.sandbox.network === 'off' ? '; there is no network access' : this.config.sandbox.network === 'allowlist' ? `; network only to: ${this.config.sandbox.allow.join(', ')}` : ''}. Ask the user if a command genuinely needs more access.`,
      knowledgeProviders: this.knowledgeProviders().map((k) => ({ id: k.id, name: k.name })),
      extraSections: [
        ...(scoped.length
          ? [{ title: 'Rules for files in context', text: scoped.map((r) => `## ${r.source}\n${r.text}`).join('\n\n') }]
          : []),
        ...this.plugins.prompts.map((s) => ({ title: s.title, text: s.text() })),
      ],
    });
  }

  // ---------- background jobs ----------

  /** Log the end of a job and deliver its result to the session (starting or queueing a run). */
  private deliverJob({ job, tail }: JobResult): void {
    if (!SessionLog.exists(job.sessionId)) return;
    const log = SessionLog.open(job.sessionId);
    const state = job.state === 'running' ? 'done' : job.state;
    if (job.execution && log.all().some(event => event.type === 'job/finished' && event.jobId === job.id)) return;
    this.append(log, { type: 'job/finished', jobId: job.id, name: job.name, state, exitCode: job.exitCode }, !!job.execution);
    if (job.execution || state === 'killed' || log.last('worktree/closed')) return;
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

  executionProviderOutput(operationId: string, hostId: string): string {
    return credentialRedactor(this.credentialValues())(this.jobs.executionOutput(operationId, hostId));
  }

  executionDockerReady(): boolean {
    return !!executionDockerEndpoint(this.config.sandbox.docker.image);
  }

  listExecutionSessions() {
    return this.listSessions().filter(summary => !summary.archived).flatMap(summary => {
      const log = SessionLog.open(summary.id);
      const meta = log.meta();
      if (!meta || log.last('worktree/closed')) return [];
      return [{ id: summary.id, title: summary.title, environment: (meta.sandbox ?? this.config.sandbox.mode) === 'docker'
        ? 'container' as const : 'host' as const }];
    });
  }

  async startExecutionJob(input: ExecutionJobRequest, hostId: string) {
    requireExecutionOperation(input?.operationId);
    validateExecutionCommand(input?.sessionId, input?.command);
    if (input.hostId !== hostId || (input.environment !== undefined && input.environment !== 'host' && input.environment !== 'container')) {
      throw new Error('EXECUTION_TARGET_IDENTITY_CHANGED');
    }
    if (!SessionLog.exists(input.sessionId)) throw new Error('EXECUTION_SESSION_UNAVAILABLE');
    const log = SessionLog.open(input.sessionId);
    const meta = log.meta();
    if (!meta || log.last('session/flags')?.archived || log.last('worktree/closed')) throw new Error('EXECUTION_SESSION_UNAVAILABLE');
    const environment = (meta.sandbox ?? this.config.sandbox.mode) === 'docker' ? 'container' : 'host';
    if (input.environment && input.environment !== environment) throw new Error('EXECUTION_TARGET_ENVIRONMENT_MISMATCH');
    const release = this.holdSession(log.id, true);
    try {
      await this.ensureProxy();
      if (SessionLog.open(log.id).last('worktree/closed')) throw new Error('EXECUTION_SESSION_UNAVAILABLE');
      const requestDigest = createHash('sha256').update(JSON.stringify([hostId, log.id, environment, input.command])).digest('hex');
      const dockerEndpoint = environment === 'container' ? executionDockerEndpoint(this.config.sandbox.docker.image) : undefined;
      return this.jobs.startExecution(log.id, input.command, meta.cwd, {
        operationId: input.operationId, hostId, requestDigest, environment, dockerEndpoint,
      }, () => {
        if (environment === 'container') {
          if (!dockerEndpoint) throw new Error('EXECUTION_CONTAINER_UNAVAILABLE');
          return prepareDockerExecution(input.operationId, input.command, meta.cwd, this.config.sandbox, dockerEndpoint, secretEnvNames(this.config));
        }
        const sandbox = this.sandboxFor(log);
        return { shell: sandbox.shell(input.command, meta.cwd), env: sandbox.env(process.env) };
      });
    } finally { release(); }
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

  private worktreeBusy(info: WorktreeInfo, includeDestination = false): boolean {
    const roots = (includeDestination ? [info.path, info.repo] : [info.path]).map(path => realpathSync(path));
    const inside = (path?: string) => !!path && roots.some(root => isInside(root, existsSync(path) ? realpathSync(path) : path));
    const sessions = this.listSessions().filter(session => inside(session.cwd));
    if (hasDataActivity(`worktree-setup:${info.path}`) || sessions.some(session =>
      this.isRunning(session.id) || this.reviews.has(session.id) || hasDataActivity(`session:${session.id}`))) return true;
    const ids = new Set(sessions.map(session => session.id));
    return [...this.jobs.list().filter(job => job.state === 'running'), ...worktreeJobsStillActive()]
      .some(job => ids.has(job.sessionId) || inside(job.cwd));
  }

  private worktreeRecovery(log: SessionLog): boolean {
    const merge = log.last('worktree/merge');
    return merge?.state === 'started' || merge?.state === 'recovery'
      || this.worktreeSetupState(log) === 'interrupted';
  }

  private guardWorktree(id: string, includeDestination = false, recover = false): { log: SessionLog; info: WorktreeInfo } {
    const log = SessionLog.open(id);
    const info = log.meta()?.worktree;
    if (!info) throw new Error('WORKTREE_UNOWNED: No owned worktree was recorded for this session.');
    if (log.last('worktree/closed')) throw new Error('WORKTREE_CLOSED: This worktree is closed.');
    assertWorktreeOwned(info);
    if (this.worktreeBusy(info, includeDestination)) throw new Error('WORKTREE_ACTIVE: Stop activity in the checkout before continuing.');
    if (!recover && this.worktreeRecovery(log)) throw new Error('WORKTREE_RECOVERY_REQUIRED: Inspect the checkout and acknowledge the interrupted operation.');
    return { log, info };
  }

  private worktreeSetupState(log: SessionLog): WorktreeSetupState {
    const setup = log.last('worktree/setup');
    if (!setup) return 'not-started';
    if (setup.state !== 'started') return setup.state;
    return hasDataActivity(`worktree-setup:${log.meta()?.worktree?.path}`) ? 'running' : 'interrupted';
  }

  worktreeInventory(): WorktreeInventoryItem[] {
    const items: WorktreeInventoryItem[] = [];
    const known = new Set<string>();
    for (const session of this.listSessions().filter(item => item.worktree)) {
      const log = SessionLog.open(session.id);
      const info = log.meta()!.worktree!;
      if (!log.last('worktree/closed')) known.add(info.path);
      const item: WorktreeInventoryItem = { id: session.id, path: info.path, repo: info.repo, branch: info.branch,
        base: info.base, setup: this.worktreeSetupState(log), state: 'closed' };
      if (!log.last('worktree/closed')) {
        if (!existsSync(info.path)) item.state = 'missing';
        else {
          try {
            const safety = worktreeSafety(info);
            item.head = safety.head;
            item.identity = safety.identity;
            item.state = this.worktreeBusy(info) ? 'active' : this.worktreeRecovery(log) ? 'recovery' : safety.dirty ? 'dirty' : 'ready';
          } catch { item.state = 'unowned'; }
        }
      }
      items.push(item);
    }
    const root = homePath('worktrees');
    if (existsSync(root)) for (const name of readdirSync(root)) {
      const path = join(root, name);
      if (!known.has(path)) items.push({ id: `unowned-${createHash('sha256').update(path).digest('hex')}`, path, state: 'unowned' });
    }
    return items.sort((a, b) => a.id.localeCompare(b.id));
  }

  previewWorktreeCleanup(ids: string[]): WorktreeCleanupPreview {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length
      || ids.some(id => typeof id !== 'string')) throw new Error('WORKTREE_INVALID_SELECTION');
    const requested = new Set(ids);
    const items = this.worktreeInventory().filter(item => requested.has(item.id));
    if (items.length !== ids.length) throw new Error('WORKTREE_INVALID_SELECTION');
    return { items, revision: createHash('sha256').update(JSON.stringify(items)).digest('hex') };
  }

  cleanupWorktrees(ids: string[], revision: string): WorktreeCleanupResult {
    const result = withStorageLock(() => {
      const preview = this.previewWorktreeCleanup(ids);
      if (preview.revision !== revision) throw new Error('WORKTREE_PREVIEW_STALE: Preview the cleanup again.');
      if (preview.items.some(item => item.state !== 'ready')) throw new Error('WORKTREE_CLEANUP_BLOCKED: Select only ready worktrees.');
      const result: WorktreeCleanupResult = { removed: [], blocked: [] };
      for (const { id } of preview.items) {
        try { result.removed.push({ id, ...this.discardOwnedWorktree(id) }); }
        catch { result.blocked.push(id); }
      }
      return result;
    });
    this.broadcastSessions();
    return result;
  }

  /** Merge the session branch into the main checkout (squash by default), then remove the worktree. */
  mergeWorktree(id: string, opts: { strategy?: 'squash' | 'merge'; keep?: boolean } = {}): { strategy: string; output: string; cleanup: 'removed' | 'retained' } {
    const r = withStorageLock(() => {
      const { log, info } = this.guardWorktree(id, true);
      if (log.last('worktree/merge')?.state === 'applied') throw new Error('WORKTREE_ALREADY_MERGED');
      const strategy = opts.strategy ?? 'squash';
      if (strategy !== 'merge' && strategy !== 'squash') throw new Error('WORKTREE_INVALID_STRATEGY');
      const title = log.summary()?.title ?? id;
      this.append(log, { type: 'worktree/merge', state: 'started', strategy }, true);
      let result: { strategy: string; output: string };
      try {
        result = mergeWorktree(info, { strategy, message: `sun: ${title}\n\nSession ${id} (${info.branch})` });
      } catch (error) {
        this.append(log, { type: 'worktree/merge', state: String(error).includes('WORKTREE_MERGE_RECOVERY') ? 'recovery' : 'failed', strategy }, true);
        throw error;
      }
      this.append(log, { type: 'worktree/merge', state: 'applied', strategy }, true);
      if (opts.keep) return { ...result, cleanup: 'retained' as const };
      try { removeWorktree(info, { keepBranch: true }); }
      catch { return { ...result, cleanup: 'retained' as const }; }
      this.append(log, { type: 'worktree/closed', action: 'merged', detail: `${strategy} into ${info.repo}` }, true);
      return { ...result, cleanup: 'removed' as const };
    });
    this.broadcastSessions();
    return r;
  }

  private discardOwnedWorktree(id: string): { branchKept: boolean } {
    const { log, info } = this.guardWorktree(id);
    const merged = log.last('worktree/merge')?.state === 'applied';
    const result = removeWorktree(info, { keepBranch: merged });
    this.append(log, { type: 'worktree/closed', action: merged ? 'merged' : 'discarded', ...(result.branchKept && { detail: 'Candidate branch retained.' }) }, true);
    return result;
  }

  discardWorktree(id: string): { branchKept: boolean } {
    const result = withStorageLock(() => this.discardOwnedWorktree(id));
    this.broadcastSessions();
    return result;
  }

  async runWorktreeSetup(id: string, hookId: string, digest: string): Promise<WorktreeSetupState> {
    if (this.opts.shellHooks === false) throw new Error('CAPABILITY_DISABLED: Shell hooks are disabled.');
    const controller = new AbortController();
    const { log, info, release } = withStorageLock(() => {
      const { log, info } = this.guardWorktree(id);
      if (log.last('worktree/setup')) throw new Error('WORKTREE_SETUP_ALREADY_DISPATCHED');
      if (!inspectHooks(info.path).hooks.some(hook => hook.id === hookId && hook.digest === digest && hook.worktreeSetup && hook.status === 'trusted')) {
        throw new Error('WORKTREE_SETUP_UNTRUSTED: Review the current setup hook in this worktree.');
      }
      const release = holdDataActivity(`worktree-setup:${info.path}`);
      try { this.append(log, { type: 'worktree/setup', state: 'started', hookId, digest }, true); }
      catch (error) { release(); throw error; }
      this.worktreeSetups.set(id, controller);
      return { log, info, release };
    });
    try {
      await this.ensureProxy();
      assertWorktreeOwned(info);
      const hook = inspectHooks(info.path).hooks.find(item =>
        item.id === hookId && item.digest === digest && item.worktreeSetup && item.status === 'trusted');
      const result = hook && await runHook(hook, { event: 'sessionStart', purpose: 'worktreeSetup', sessionId: id, cwd: info.path },
        info.path, { ...this.hookExecutionOptions(info.path, log.meta()!.sandbox ?? this.config.sandbox.mode, id), signal: controller.signal });
      const state = result && result.code === 0 && result.state === 'completed' ? 'completed' : 'failed';
      this.append(log, { type: 'worktree/setup', state, hookId, digest, ...(result && { code: result.code }) }, true);
      return state;
    } finally {
      this.worktreeSetups.delete(id);
      release();
    }
  }

  acknowledgeWorktreeRecovery(id: string): void {
    withStorageLock(() => {
      const { log } = this.guardWorktree(id, false, true);
      const setup = log.last('worktree/setup');
      if (setup?.state === 'started') this.append(log, { type: 'worktree/setup', state: 'acknowledged', hookId: setup.hookId, digest: setup.digest }, true);
      const merge = log.last('worktree/merge');
      if (merge?.state === 'started' || merge?.state === 'recovery') {
        this.append(log, { type: 'worktree/merge', state: 'reconciled', strategy: merge.strategy }, true);
      }
    });
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

  denyUnattendedApprovals(): void {
    for (const { pending, resolve } of this.approvals.values()) {
      if (!this.hasApprover(pending.displaySessionId)) resolve('deny', 'The approval was denied because no authorized approver remains connected.');
    }
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
      const done = (d: ApprovalDecision, reason?: string) => {
        if (!this.approvals.has(req.callId)) return;
        this.approvals.delete(req.callId);
        this.broadcastApprovals();
        resolve({ decision: d, ...(reason ? { reason } : {}) });
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
      wideResearch: (question, items) => this.wideResearch(log, question, items, signal),
      searchSessions: async (query) => {
        const hits = this.searchSessions(query, 8);
        if (!hits.length) return 'No past conversations matched.';
        return hits.map((h) => `${h.title} (${h.id}, ${h.updatedAt.slice(0, 10)})\n${h.snippet}`).join('\n\n');
      },
      rememberUser: async (fact) => saveUserFact(fact),
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
        const t = addSchedule({ title: spec.title ?? spec.prompt.slice(0, 50), prompt: spec.prompt, at: spec.at, cron: spec.cron, mode: log.currentMode() === 'plan' ? 'coding' : log.currentMode(), cwd, source: log.id });
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

  /**
   * One fresh subagent per item, then a markdown file in research/. Bounded to 8 items (a local harness, not a cloud cluster).
   * Items run one after another so each context stays clean and the provider script stays ordered.
   */
  private async wideResearch(parent: SessionLog, question: string, items: string[], signal: AbortSignal): Promise<string> {
    const list = [...new Set(items.map((s) => s.trim()).filter(Boolean))].slice(0, 8);
    if (list.length < 2) throw new Error('wide_research needs at least 2 distinct items.');
    const notes: string[] = [];
    for (const item of list) {
      notes.push(await this.runSubagent(parent, `Research only this item. Do not cover the others.\nQuestion: ${question}\nItem: ${item}\nReturn a short factual note and name your sources.`, 'agent', signal));
    }
    const title = question.trim().slice(0, 120) || 'Research';
    const slug = title.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'research';
    const dir = join(parent.meta()!.cwd, 'research');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${slug}.md`);
    const md = `# ${title}\n\n${list.map((item, i) => `## ${item}\n\n${notes[i]}`).join('\n\n')}\n`;
    writeFileSync(file, md);
    return `Wrote ${relative(parent.meta()!.cwd, file)} (${list.length} items, each in its own subagent).\n\n${md.slice(0, 12_000)}`;
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
    if (this.opts.loadPlugins === false) return [];
    if (!this.pluginActivation) {
      const plugins = this.opts.config ? this.config.plugins : loadConfig().plugins;
      this.config = { ...this.config, plugins };
      this.pluginActivation = this.plugins.reload().finally(() => {
        this.pluginActivation = undefined;
        this.broadcastPlugins();
      });
    }
    await this.pluginActivation;
    return this.pluginStates;
  }

  async setPluginEnabled(input: unknown, surface: CapabilitySurface = 'cli'): Promise<SettingsWriteResult> {
    const invalid = (reason: string): SettingsWriteResult => ({ ok: false, code: 'INVALID', fields: { plugin: reason } });
    if (this.opts.loadPlugins === false) return invalid('FEATURE_DISABLED');
    if (!input || typeof input !== 'object' || !('name' in input) || typeof input.name !== 'string'
      || !('enabled' in input) || typeof input.enabled !== 'boolean' || !('expectedRevision' in input)) return invalid('INVALID_PLUGIN_REQUEST');
    const { name, enabled, expectedRevision } = input;
    const dir = pluginDirs().find(path => basename(path) === name);
    if (!dir && (enabled || !this.pluginStates.some(plugin => plugin.name === name))) return invalid('PLUGIN_NOT_INSTALLED');
    if (enabled && (this.pluginActivation || this.plugins.hasInFlight(name) && this.config.plugins.disabled.includes(name))) {
      return { ok: false, code: 'BUSY' };
    }
    const update = (disabled: string[]) => enabled ? disabled.filter(id => id !== name) : [...new Set([...disabled, name])];
    const { result } = writeSettings({
      scope: 'host', expectedRevision, changes: {},
    }, () => false, { name, enabled });
    if (!result.ok) return result;
    const wasDisabled = this.config.plugins.disabled.includes(name);
    this.config = { ...this.config, plugins: { ...this.config.plugins, disabled: update(this.config.plugins.disabled) } };
    let audit = result.audit;
    if (!enabled && !this.plugins.disable(name)) audit = 'incomplete';
    this.broadcast({ kind: 'settings', revision: result.snapshot.revision });
    if (dir && enabled && wasDisabled && this.plugins.started) {
      this.pluginActivation = this.plugins.activate(dir).finally(() => { this.pluginActivation = undefined; });
      await this.pluginActivation;
    }
    this.broadcastPlugins();
    return {
      ...result, apply: 'immediate', audit,
      snapshot: { ...result.snapshot, capabilities: this.listCapabilities(surface) },
    };
  }

  knowledgeProviders(): KnowledgeProvider[] {
    const out: KnowledgeProvider[] = [this.hybridKb ?? this.personalKb];
    const c = this.config.kb.company;
    if (c.enabled && c.baseUrl) out.push(new HttpKnowledgeProvider('company', c.name ?? 'Company KB', c.baseUrl, c.tokenEnv ? process.env[c.tokenEnv] : undefined));
    return [...out, ...this.plugins.knowledge];
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
    if (now.getTime() - this.lastStorageSweep >= 3_600_000) {
      try {
        const reconciled = this.storage.reconcile();
        if (this.storage.retain() || reconciled) this.storageChanged();
        this.lastStorageSweep = now.getTime();
      } catch { /* The next tick retries an interrupted or busy sweep. */ }
    }
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
    const missed = missedTasks(tasks, now, missedRun).filter((t) => !due.includes(t));
    for (const t of [...due, ...missed]) {
      updateSchedule(t.id, { lastRun: now.toISOString(), ...(t.at ? { enabled: false } : {}) });
      scheduled.push(await this.runAutomation(t.id, { catchUp: missed.includes(t), at: now }));
    }
    return { resumed, scheduled };
  }

  async dispose(): Promise<void> {
    this.stopComputerUse();
    this.appshots.dispose();
    this.transcriptions.dispose();
    for (const controller of this.hookFixtures.values()) controller.abort();
    for (const { controller } of this.startupHooks.values()) controller.abort();
    for (const controller of this.worktreeSetups.values()) controller.abort();
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
