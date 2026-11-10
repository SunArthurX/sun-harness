import { DEFAULT_STORAGE, defaultUiPreferences } from '@sun/core/settings-preferences';
import { requireSettingsProtocol, SETTINGS_PROTOCOL_VERSION } from '@sun/core/settings-protocol';
import type {
  ApprovalDecision,
  AppshotEdits,
  AppshotMetadata,
  AppshotPreview,
  PreparedAppshot,
  BrowserControl,
  BrowserFrameRef,
  BrowserInput,
  BrowserManager,
  BrowserPermissionPatch,
  BrowserPermissionResult,
  BrowserPermissionsSnapshot,
  BrowserUploadTarget,
  BrowserUploadRequest,
  BrowserUploadApproval,
  HookFixtureRequest,
  HookFixtureResult,
  HookInspection,
  HookTrustChange,
  IntelRunResult,
  LiveEvent,
  GatewayStatus,
  McpServerState,
  PendingApproval,
  PluginEnableRequest,
  PluginState,
  ReviewStatus,
  Proposal,
  ScheduledTask,
  SessionEvent,
  SessionSummary,
  SessionImportOptions,
  StorageConfirmation,
  StorageInventory,
  StorageOperation,
  StoragePreview,
  Skill,
  CapabilityStatus,
  CredentialFillResult,
  CredentialInput,
  CredentialReference,
  ComputerSettings,
  SettingsPatch,
  SettingsSnapshot,
  SettingsWriteResult,
  KnowledgeHit,
  WorktreeStatus,
  WorktreeInventoryItem,
  WorktreeCleanupPreview,
  WorktreeCleanupResult,
  WorktreeSetupState,
  Job,
  ExecutionEnvironment,
  ExecutionJob,
  ExecutionTarget,
  StartExecutionJob,
  ContextReport,
  Automation,
  FileChange,
} from '@sun/core';

import type { MiniSnapshot } from '../../shared/mini';
import type { CertificatePreview, ConfirmConnection, DesktopConnections } from '../../shared/connections';
import type { PrivateSignInStatus } from '../../shared/credentials';

export type AppshotDispatch = { sessionId: string } & ({ preview: AppshotPreview } | { error: string });

declare global {
  interface Window {
    sun: {
      call(method: string, ...args: unknown[]): Promise<any>;
      onMiniUpdate?(fn: () => void): () => void;
      onMiniOpen?(fn: () => void): () => void;
      onAppshot?(fn: (event: AppshotDispatch) => void): () => void;
      onLive(fn: (e: LiveEvent) => void): () => void;
    };
  }
}

const call = <T>(m: string, ...a: unknown[]) => window.sun.call(m, ...a) as Promise<T>;

function normalizeSettings(snapshot: SettingsSnapshot): SettingsSnapshot {
  requireSettingsProtocol(snapshot?.protocolVersion);
  const defaults = defaultUiPreferences();
  const ui = snapshot.values.ui;
  return {
    ...snapshot,
    values: {
      ...snapshot.values,
      storage: { ...DEFAULT_STORAGE, ...snapshot.values.storage },
      defaultMode: snapshot.values.defaultMode ?? 'coding',
      voice: snapshot.values.voice ?? { enabled: true, stt: '', ready: false },
      memory: snapshot.values.memory ?? { enabled: true },
      ui: {
        ...defaults, ...ui,
        notifications: {
          ...defaults.notifications, ...ui.notifications,
          quietHours: { ...defaults.notifications.quietHours, ...ui.notifications?.quietHours },
        },
        shortcuts: { ...defaults.shortcuts, ...ui.shortcuts },
      },
    },
  };
}

export async function migrateReadAloud(snapshot: SettingsSnapshot): Promise<SettingsSnapshot> {
  try {
    const old = localStorage.getItem('sun.speak');
    if (old !== '0' && old !== '1') return snapshot;
    if (snapshot.origins['ui.readAloud']?.source === 'default' && old === '1') {
      const migrated = await api.updateSettings({
        expectedRevision: snapshot.userRevision ?? snapshot.revision, scope: 'user', changes: { 'ui.readAloud': true },
      });
      if (!migrated.ok) return snapshot;
      snapshot = migrated.snapshot;
    }
    localStorage.removeItem('sun.speak');
  } catch {
    // Retry on reconnect if the preference could not be written.
  }
  return snapshot;
}

export const api = {
  appInfo: () => call<{ home: string; localHome?: string; version: string; platform: string; defaultCwd: string; mode: string; gateway?: string; connection?: GatewayStatus; settingsRecovery?: 'INVALID_CONFIG' | 'NEWER_CONFIG'; settingsProtocolVersion?: number }>('appInfo'),
  connectionStatus: () => call<GatewayStatus | undefined>('connectionStatus'),
  listDesktopConnections: () => call<DesktopConnections>('listDesktopConnections'),
  listDesktopCredentials: () => call<{ available: boolean; entries: CredentialReference[] }>('listDesktopCredentials', SETTINGS_PROTOCOL_VERSION),
  saveDesktopCredential: (input: CredentialInput, prior?: CredentialReference) =>
    call<CredentialReference>('saveDesktopCredential', SETTINGS_PROTOCOL_VERSION, input, prior),
  deleteDesktopCredential: (entry: CredentialReference) => call<void>('deleteDesktopCredential', SETTINGS_PROTOCOL_VERSION, entry.id, entry.revision),
  openDesktopCredentialSignIn: (entry: CredentialReference, url: string) =>
    call<void>('openDesktopCredentialSignIn', SETTINGS_PROTOCOL_VERSION, entry.id, entry.revision, url),
  privateSignInStatus: () => call<PrivateSignInStatus>('privateSignInStatus', SETTINGS_PROTOCOL_VERSION),
  fillPrivateSignIn: () => call<CredentialFillResult>('fillPrivateSignIn', SETTINGS_PROTOCOL_VERSION),
  closePrivateSignIn: () => call<void>('closePrivateSignIn', SETTINGS_PROTOCOL_VERSION),
  previewDesktopConnection: (url: string) => call<CertificatePreview>('previewDesktopConnection', url),
  confirmDesktopConnection: (input: ConfirmConnection) => call<void>('confirmDesktopConnection', input),
  selectDesktopConnection: (name: string | null) => call<void>('selectDesktopConnection', name),
  removeDesktopConnection: (name: string) => call<boolean>('removeDesktopConnection', name),
  listSessions: () => call<SessionSummary[]>('listSessions'),
  getEvents: (id: string) => call<SessionEvent[]>('getEvents', id),
  createSession: (input: { cwd?: string; mode?: string; model?: string; worktree?: boolean; worktreeBase?: string }) => call<SessionSummary>('createSession', input),
  executionTargets: () => call<ExecutionTarget[]>('executionTargets', SETTINGS_PROTOCOL_VERSION),
  executionTargetSessions: (id: string) =>
    call<{ id: string; title: string; environment: ExecutionEnvironment }[]>('executionTargetSessions', SETTINGS_PROTOCOL_VERSION, id),
  listExecutionJobs: () => call<ExecutionJob[]>('listExecutionJobs', SETTINGS_PROTOCOL_VERSION),
  startExecutionJob: (input: StartExecutionJob) => call<ExecutionJob>('startExecutionJob', SETTINGS_PROTOCOL_VERSION, input),
  refreshExecutionJob: (id: string) => call<ExecutionJob>('refreshExecutionJob', SETTINGS_PROTOCOL_VERSION, id),
  cancelExecutionJob: (id: string) => call<ExecutionJob>('cancelExecutionJob', SETTINGS_PROTOCOL_VERSION, id),
  executionJobOutput: (id: string) => call<string>('executionJobOutput', SETTINGS_PROTOCOL_VERSION, id),
  listJobs: (sessionId?: string) => call<Job[]>('listJobs', sessionId),
  jobOutput: (jobId: string) => call<string>('jobOutput', jobId),
  killJob: (jobId: string) => call<boolean>('killJob', jobId),
  worktreeStatus: (id: string) => call<WorktreeStatus>('worktreeStatus', id),
  worktreeDiff: (id: string) => call<string>('worktreeDiff', id),
  worktreeInventory: () => call<WorktreeInventoryItem[]>('worktreeInventory'),
  previewWorktreeCleanup: (ids: string[]) => call<WorktreeCleanupPreview>('previewWorktreeCleanup', ids),
  cleanupWorktrees: (ids: string[], revision: string) => call<WorktreeCleanupResult>('cleanupWorktrees', ids, revision),
  runWorktreeSetup: (id: string, hookId: string, digest: string) => call<WorktreeSetupState>('runWorktreeSetup', id, hookId, digest),
  acknowledgeWorktreeRecovery: (id: string) => call<void>('acknowledgeWorktreeRecovery', id),
  mergeWorktree: (id: string, strategy?: 'squash' | 'merge') => call<{ strategy: string; output: string; cleanup: 'removed' | 'retained' }>('mergeWorktree', id, strategy),
  discardWorktree: (id: string) => call<{ branchKept: boolean }>('discardWorktree', id),
  listCheckpoints: (id: string) => call<{ id: string; files: string[]; undone: boolean; ts: string }[]>('listCheckpoints', id),
  browserInfo: (id?: string) => call<{ available: boolean; description: string; active: boolean; takeover: boolean; profile: ReturnType<BrowserManager['profile']> }>('browserInfo', id),
  browserView: (id: string, on: boolean, viewer: string) => call<void>('browserView', id, on, viewer),
  browserTakeover: (id: string, on: boolean, frame?: BrowserFrameRef, control?: BrowserControl) =>
    call<BrowserControl | undefined>('browserTakeover', id, on, frame, control),
  browserInput: (id: string, ev: BrowserInput, frame: BrowserFrameRef, control: BrowserControl) =>
    call<void>('browserInput', id, ev, frame, control),
  previewBrowserUpload: (id: string) => call<BrowserUploadTarget>('previewBrowserUpload', id, SETTINGS_PROTOCOL_VERSION),
  approveBrowserUpload: (id: string, request: BrowserUploadRequest) => call<BrowserUploadApproval>('approveBrowserUpload', id, request, SETTINGS_PROTOCOL_VERSION),
  browserPermissions: () => call<BrowserPermissionsSnapshot>('browserPermissions', SETTINGS_PROTOCOL_VERSION),
  updateBrowserPermission: (request: BrowserPermissionPatch) => call<BrowserPermissionResult>('updateBrowserPermission', request, SETTINGS_PROTOCOL_VERSION),
  deliverables: (id: string) => call<{ path: string; abs: string; created: boolean; size: number; mtime: string }[]>('deliverables', id),
  metrics: (days?: number) => call<any[]>('metrics', days),
  runBriefing: () => call<{ date: string; path: string; sessionId: string; text: string }>('runBriefing'),
  readBriefing: (date: string) => call<string | undefined>('readBriefing', date),
  listMemories: () => call<{ id: string; text: string; kind: string; created: string; uses: number }[]>('listMemories'),
  removeMemory: (id: string) => call<boolean>('removeMemory', id),
  transcribe: (audioBase64: string, mime: string, id?: string) => call<string>('transcribe', audioBase64, mime, id),
  cancelTranscription: (id: string) => call<boolean>('cancelTranscription', id),
  askMicrophone: () => call<boolean>('askMicrophone'),
  microphonePermission: () => call<'granted' | 'denied' | 'prompt' | 'unknown' | undefined>('microphonePermission'),
  showMini: () => call<void>('showMini'),
  getMiniSnapshot: () => call<MiniSnapshot>('getMiniSnapshot'),
  stopMiniRun: (id: string) => call<boolean>('stopMiniRun', id),
  openMiniSession: (id: string) => call<boolean>('openMiniSession', id),
  takeMiniSession: () => call<string | undefined>('takeMiniSession'),
  desktopShortcutStatus: () => call<{ active: string; state: 'active' | 'unavailable' | 'unbound' }>('desktopShortcutStatus'),
  trackAppshotSession: (sessionId: string) => call<void>('trackAppshotSession', sessionId),
  captureAppshot: (sessionId: string) => call<AppshotPreview>('captureAppshot', SETTINGS_PROTOCOL_VERSION, sessionId),
  inspectComputerUse: () => call<ComputerSettings>('inspectComputerUse', SETTINGS_PROTOCOL_VERSION),
  grantComputerUse: (revision: string, appId: string, granted: boolean) =>
    call<void>('grantComputerUse', SETTINGS_PROTOCOL_VERSION, revision, appId, granted),
  beginComputerUse: (sessionId: string, appId: string) => call<void>('beginComputerUse', SETTINGS_PROTOCOL_VERSION, sessionId, appId),
  stopComputerUse: () => call<void>('stopComputerUse', SETTINGS_PROTOCOL_VERSION),
  computerOwner: () => call<ComputerSettings['owner']>('computerOwner', SETTINGS_PROTOCOL_VERSION),
  openComputerPermission: () => call<void>('openComputerPermission'),
  prepareAppshot: (sessionId: string, id: string, edits: AppshotEdits) => call<PreparedAppshot>('prepareAppshot', SETTINGS_PROTOCOL_VERSION, sessionId, id, edits),
  cancelAppshot: (sessionId: string, id: string) => call<void>('cancelAppshot', SETTINGS_PROTOCOL_VERSION, sessionId, id),
  sendAppshotMessage: (sessionId: string, text: string, images: { data: string; mime: string }[], id: string) =>
    call<void>('sendAppshotMessage', SETTINGS_PROTOCOL_VERSION, sessionId, text, images, id),
  sendMessage: (id: string, text: string, images?: { data: string; mime: string }[]) => call<void>('sendMessage', id, text, images),
  listCommands: (cwd?: string) => call<{ name: string; description: string; argumentHint?: string; scope: string }[]>('listCommands', cwd),
  completePaths: (cwd: string, query: string) => call<string[]>('completePaths', cwd, query),
  cost: (id: string) => call<{ usd: number; unpriced: string[]; byModel: { model: string; input: number; cached: number; output: number; usd?: number }[] }>('cost', id),
  compact: (id: string) => call<boolean>('compact', id),
  fork: (id: string, beforeSeq: number, restoreFiles?: boolean) => call<{ session: SessionSummary; text: string }>('fork', id, beforeSeq, restoreFiles),
  exportSession: (id: string, format: 'markdown' | 'html' | 'jsonl') => call<string>('exportSession', id, format),
  importSession: (jsonl: string, options: SessionImportOptions = {}) => call<SessionSummary>('importSession', jsonl, options),
  importSessionBundle: (bytes: Uint8Array, options: SessionImportOptions = {}) => call<SessionSummary>('importSessionBundle', bytes, options),
  exportSessionBundle: (id: string) => call<Uint8Array<ArrayBuffer>>('exportSessionBundle', id),
  storageInventory: (includeProfiles: boolean) => call<StorageInventory>('storageInventory', includeProfiles),
  previewStorage: (ids: string[], includeProfiles: boolean) => call<StoragePreview>('previewStorage', ids, includeProfiles),
  moveStorage: (input: StorageConfirmation) => call<StorageOperation>('moveStorage', input),
  storageOperations: () => call<StorageOperation[]>('storageOperations'),
  searchSessions: (q: string) => call<{ id: string; title: string; mode: string; updatedAt: string; snippet: string }[]>('searchSessions', q),
  resolveProposal: (id: string, proposalId: string, action: 'create' | 'run' | 'both', edits?: { title?: string; prompt?: string; schedule?: string }) => call<{ automation?: Automation }>('resolveProposal', id, proposalId, action, edits),
  previewSchedule: (text: string) => call<{ cron?: string; at?: string; description: string; next: string[] } | null>('previewSchedule', text),
  listAutomations: () => call<Automation[]>('listAutomations'),
  createAutomation: (input: { title?: string; prompt: string; schedule: string; mode?: string; model?: string; cwd?: string; chats?: string[]; catchUp?: boolean }) => call<Automation>('createAutomation', input),
  updateAutomation: (id: string, patch: { title?: string; prompt?: string; schedule?: string; enabled?: boolean; mode?: string; model?: string; chats?: string[]; catchUp?: boolean; cwd?: string }) => call<Automation>('updateAutomation', id, patch),
  deleteAutomation: (id: string) => call<void>('deleteAutomation', id),
  runAutomation: (id: string) => call<string>('runAutomation', id),
  sessionChanges: (id: string, fromSeq?: number, toSeq?: number) => call<FileChange[]>('sessionChanges', id, fromSeq, toSeq),
  reviewSession: (id: string) => call<string>('reviewSession', id),
  reviewStatus: (id: string) => call<ReviewStatus>('reviewStatus', id),
  revertFile: (id: string, path: string, fromSeq?: number) => call<FileChange>('revertFile', id, path, fromSeq),
  readSessionFile: (id: string, path: string) => call<{ path: string; content: string; size: number; truncated: boolean; binary: boolean }>('readSessionFile', id, path),
  listWorkspace: (id: string, rel?: string) => call<{ name: string; dir: boolean }[]>('listWorkspace', id, rel),
  contextUsage: (id: string) => call<ContextReport>('contextUsage', id),
  contextReportHtml: (id: string) => call<string>('contextReportHtml', id),
  setSessionFlags: (id: string, flags: { pinned?: boolean; archived?: boolean }) => call<SessionSummary>('setSessionFlags', id, flags),
  readAttachment: (path: string, expected?: AppshotMetadata) => call<{ data: string; mime: string }>('readAttachment', path, expected),
  sandboxInfo: (id?: string) => call<{ mode: string; kind: string; description: string; network: string; blocked: string[] }>('sandboxInfo', id),
  undo: (id: string, steps?: number) => call<{ undone: string[]; restored: string[] }>('undo', id, steps),
  deleteSession: (id: string) => call<void>('deleteSession', id),
  renameSession: (id: string, title: string) => call<void>('renameSession', id, title),
  send: (id: string, text: string) => call<void>('send', id, text),
  resume: (id: string, model?: string) => call<void>('resume', id, model),
  abort: (id: string) => call<void>('abort', id),
  approve: (callId: string, d: ApprovalDecision, promptId?: string) => call<boolean>('approve', callId, d, promptId),
  pendingApprovals: () => call<PendingApproval[]>('pendingApprovals'),
  switchModel: (id: string, model: string) => call<void>('switchModel', id, model),
  switchMode: (id: string, mode: string) => call<void>('switchMode', id, mode),
  listModels: () => call<{ ref: string; provider: string; ready: boolean }[]>('listModels'),
  listModes: () => call<{ id: string; label: string; description: string }[]>('listModes'),
  getSettings: async () => normalizeSettings(await call<SettingsSnapshot>('getSettings', SETTINGS_PROTOCOL_VERSION)),
  listCapabilities: () => call<CapabilityStatus[]>('listCapabilities', SETTINGS_PROTOCOL_VERSION),
  updateSettings: async (patch: SettingsPatch): Promise<SettingsWriteResult> => {
    const result = await call<SettingsWriteResult>('updateSettings', patch, SETTINGS_PROTOCOL_VERSION);
    return result.ok ? { ...result, snapshot: normalizeSettings(result.snapshot) } : result;
  },
  listHooks: (cwd: string) => call<HookInspection>('listHooks', cwd, SETTINGS_PROTOCOL_VERSION),
  reviewHooks: (cwd: string, changes: HookTrustChange[]) => call<HookInspection>('reviewHooks', cwd, changes, SETTINGS_PROTOCOL_VERSION),
  runHookFixture: (input: HookFixtureRequest) => call<HookFixtureResult>('runHookFixture', input, SETTINGS_PROTOCOL_VERSION),
  cancelHookFixture: (id: string) => call<boolean>('cancelHookFixture', id, SETTINGS_PROTOCOL_VERSION),
  listSkills: (cwd: string) => call<Skill[]>('listSkills', cwd),
  listMcp: (cwd: string) => call<McpServerState[]>('listMcp', cwd),
  reloadMcp: (cwd: string) => call<McpServerState[]>('reloadMcp', cwd),
  listPlugins: () => call<PluginState[]>('listPlugins'),
  reloadPlugins: () => call<PluginState[]>('reloadPlugins'),
  setPluginEnabled: (request: PluginEnableRequest) => call<SettingsWriteResult>('setPluginEnabled', request, SETTINGS_PROTOCOL_VERSION),
  kbStats: () =>
    call<{ personal: { documents: number; chunks: number; embedded: number; model?: string; lastError?: string }; roots: string[]; providers: { id: string; name: string }[] }>('kbStats'),
  kbIndex: () => call<{ embedded: number; enabled: boolean }>('kbIndex'),
  kbSearch: (q: string) => call<(KnowledgeHit & { provider: string })[]>('kbSearch', q),
  kbAdd: (title: string, text: string) => call<string>('kbAdd', title, text),
  getMemory: (full = false) => call<string>('getMemory', full),
  getUserProfile: () => call<string>('getUserProfile'),
  setUserProfile: (text: string, expected?: string) => call<boolean | undefined>('setUserProfile', text, ...(expected === undefined ? [] : [expected])),
  getPersonalInstructions: () => call<string>('getPersonalInstructions'),
  setPersonalInstructions: (text: string, expected: string) => call<boolean>('setPersonalInstructions', text, expected),
  setMemory: (text: string, expected?: string) => call<boolean | undefined>('setMemory', text, ...(expected === undefined ? [] : [expected])),
  listProposals: () => call<Proposal[]>('listProposals'),
  acceptProposal: (id: string) => call<{ appliedTo: string }>('acceptProposal', id),
  rejectProposal: (id: string) => call<Proposal>('rejectProposal', id),
  reflect: (id: string) => call<Proposal[]>('reflect', id),
  listIntelReports: () => call<{ date: string; path: string; html: string; pending: boolean }[]>('listIntelReports'),
  readIntelReport: (date: string) => call<string>('readIntelReport', date),
  runIntel: (force?: boolean) => call<IntelRunResult>('runIntel', force),
  analyzeIntel: (date: string) => call<IntelRunResult>('analyzeIntel', date),
  listSchedules: () => call<ScheduledTask[]>('listSchedules'),
  removeSchedule: (id: string) => call<void>('removeSchedule', id),
  pickFolder: () => call<string | undefined>('pickFolder'),
  openPath: (p: string) => call<string>('openPath', p),
  openExternal: (u: string) => call<void>('openExternal', u),
};
