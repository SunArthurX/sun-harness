import type {
  ApprovalDecision,
  IntelRunResult,
  LiveEvent,
  McpServerState,
  PendingApproval,
  PluginState,
  Proposal,
  ScheduledTask,
  SessionEvent,
  SessionSummary,
  Skill,
  SunConfig,
  KnowledgeHit,
  WorktreeStatus,
  Job,
} from '@sun/core';

declare global {
  interface Window {
    sun: {
      call(method: string, ...args: unknown[]): Promise<any>;
      onLive(fn: (e: LiveEvent) => void): () => void;
    };
  }
}

const call = <T>(m: string, ...a: unknown[]) => window.sun.call(m, ...a) as Promise<T>;

export const api = {
  appInfo: () => call<{ home: string; version: string; platform: string; defaultCwd: string; mode: string; gateway?: string }>('appInfo'),
  listSessions: () => call<SessionSummary[]>('listSessions'),
  getEvents: (id: string) => call<SessionEvent[]>('getEvents', id),
  createSession: (input: { cwd?: string; mode?: string; model?: string; worktree?: boolean }) => call<SessionSummary>('createSession', input),
  listJobs: (sessionId?: string) => call<Job[]>('listJobs', sessionId),
  jobOutput: (jobId: string) => call<string>('jobOutput', jobId),
  killJob: (jobId: string) => call<boolean>('killJob', jobId),
  worktreeStatus: (id: string) => call<WorktreeStatus>('worktreeStatus', id),
  worktreeDiff: (id: string) => call<string>('worktreeDiff', id),
  mergeWorktree: (id: string, strategy?: 'squash' | 'merge') => call<{ strategy: string; output: string }>('mergeWorktree', id, strategy),
  discardWorktree: (id: string) => call<void>('discardWorktree', id),
  deleteSession: (id: string) => call<void>('deleteSession', id),
  renameSession: (id: string, title: string) => call<void>('renameSession', id, title),
  send: (id: string, text: string) => call<void>('send', id, text),
  resume: (id: string, model?: string) => call<void>('resume', id, model),
  abort: (id: string) => call<void>('abort', id),
  approve: (callId: string, d: ApprovalDecision) => call<void>('approve', callId, d),
  pendingApprovals: () => call<PendingApproval[]>('pendingApprovals'),
  switchModel: (id: string, model: string) => call<void>('switchModel', id, model),
  switchMode: (id: string, mode: string) => call<void>('switchMode', id, mode),
  listModels: () => call<{ ref: string; provider: string; ready: boolean }[]>('listModels'),
  listModes: () => call<{ id: string; label: string; description: string }[]>('listModes'),
  getConfig: () => call<SunConfig>('getConfig'),
  updateConfig: (patch: Partial<SunConfig>) => call<SunConfig>('updateConfig', patch),
  listSkills: (cwd: string) => call<Skill[]>('listSkills', cwd),
  listMcp: (cwd: string) => call<McpServerState[]>('listMcp', cwd),
  reloadMcp: (cwd: string) => call<McpServerState[]>('reloadMcp', cwd),
  listPlugins: () => call<PluginState[]>('listPlugins'),
  reloadPlugins: () => call<PluginState[]>('reloadPlugins'),
  kbStats: () => call<{ personal: { documents: number; chunks: number }; roots: string[]; providers: { id: string; name: string }[] }>('kbStats'),
  kbSearch: (q: string) => call<(KnowledgeHit & { provider: string })[]>('kbSearch', q),
  kbAdd: (title: string, text: string) => call<string>('kbAdd', title, text),
  getMemory: () => call<string>('getMemory'),
  setMemory: (t: string) => call<void>('setMemory', t),
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
