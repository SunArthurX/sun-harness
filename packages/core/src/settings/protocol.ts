/** Shared by the core RPC table and renderer. Keep this module browser-safe. */
import type { CapabilityStatus } from './types.js';

export const SETTINGS_PROTOCOL_VERSION = 1;
export const BUNDLE_MAX_BYTES = 100 * 1024 * 1024;
export const BUNDLE_MAX_COMPRESSED_BYTES = 101 * 1024 * 1024;
export const SETTINGS_PROTOCOL_MISMATCH = 'SETTINGS_PROTOCOL_MISMATCH';

export interface GatewayConnection {
  hostId: string;
  gatewayId: string;
  label: string;
  protocolVersion: number;
  serverTime: number;
  capabilities: CapabilityStatus[];
}

export type GatewayLiveState = 'ready' | 'stale' | 'unauthorized' | 'identity-changed';
export interface GatewayStatus {
  state: GatewayLiveState;
  hostId?: string;
  label?: string;
  url?: string;
}

const gatewayReads = new Set([
  'appInfo', 'getSettings', 'listCapabilities', 'listSessions', 'getEvents', 'isRunning', 'pendingApprovals',
  'listModels', 'readyModels', 'listModes', 'listCommands', 'completePaths', 'searchSessions', 'getMemory',
  'getUserProfile', 'getPersonalInstructions', 'listMemories', 'listProposals', 'listIntelReports',
  'readIntelReport', 'readBriefing', 'listSchedules', 'listAutomations', 'previewSchedule', 'listJobs', 'jobOutput',
  'listCheckpoints', 'worktreeStatus', 'worktreeDiff', 'worktreeInventory', 'previewWorktreeCleanup', 'sessionChanges', 'readSessionFile', 'listWorkspace',
  'contextUsage', 'contextReportHtml', 'metrics', 'cost', 'storageInventory', 'previewStorage', 'storageOperations',
  'deliverables', 'sandboxInfo', 'browserInfo', 'browserPermissions', 'previewBrowserUpload', 'exportSession', 'exportSessionBundle', 'readAttachment',
  'listSkills', 'listHooks', 'listPlugins', 'reviewStatus', 'executionTargets', 'executionTargetSessions',
  'listExecutionJobs', 'executionJobOutput', 'executionProviderSessions', 'inspectExecutionProviderJob', 'executionProviderOutput',
]);

export function isGatewayRead(method: string): boolean {
  return gatewayReads.has(method);
}

const retryableGatewayMethods = new Set(['createSession', 'send', 'sendMessage', 'runAutomation']);

export function usesGatewayRequestId(method: string): boolean {
  return retryableGatewayMethods.has(method);
}

export function requireSettingsProtocol(version: unknown): void {
  if (version !== SETTINGS_PROTOCOL_VERSION) {
    throw new Error(`${SETTINGS_PROTOCOL_MISMATCH}: Settings protocol mismatch. Update the client and host to compatible versions.`);
  }
}
