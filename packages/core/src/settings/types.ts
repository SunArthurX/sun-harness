import type { StoragePreferences, UiPreferences } from './preferences.js';
import type { SunConfig } from '../config.js';

export type SettingScope = 'user' | 'host';
export type SettingsRevision = string;

export interface PublicProviderSettings {
  id: string;
  configured: boolean;
  source: 'file' | 'environment' | 'none';
  noKey: boolean;
  baseUrl: string;
  models: string[];
}

export interface PublicSettings {
  ui: UiPreferences;
  storage: StoragePreferences;
  defaultMode: SunConfig['defaultMode'];
  memory: { enabled: boolean };
  voice: { enabled: boolean; stt: string; ready: boolean };
  defaultModel: string;
  fallbackModels: string[];
  providers: Record<string, PublicProviderSettings>;
  approval: SunConfig['approval'];
  denyInsteadOfPrompting: boolean;
  maxSteps: number;
  autoResume: Pick<SunConfig['autoResume'], 'enabled' | 'intervalMinutes'>;
  sandbox: Pick<SunConfig['sandbox'], 'mode' | 'network' | 'allow' | 'autoApprove'> & { docker: { image: string } };
  kb: {
    roots: string[];
    company: Pick<SunConfig['kb']['company'], 'enabled' | 'baseUrl'>;
    embeddings: Pick<SunConfig['kb']['embeddings'], 'enabled' | 'model'>;
  };
  intel: { hour: number; minute: number; sourceCount: number };
  briefing: Pick<SunConfig['briefing'], 'enabled' | 'hour' | 'minute'>;
  taint: Pick<SunConfig['taint'], 'untrusted'>;
  review: SunConfig['review'];
}

export type CapabilitySurface = 'desktop' | 'web' | 'cli';

export interface CapabilityStatus {
  id: string;
  state: 'available' | 'disabled' | 'unavailable' | 'error';
  reasonCode?: string;
  owner: 'core' | 'extension' | 'native';
  surface: CapabilitySurface[];
  configKeys: string[];
}

export interface SettingsSnapshot {
  protocolVersion: number;
  revision: SettingsRevision;
  /** Desktop preferences have their own revision when the execution host is remote. */
  userRevision?: SettingsRevision;
  hostSettingsUnavailable?: true;
  values: PublicSettings;
  origins: Record<string, { source: 'default' | 'user' | 'environment'; editable: boolean }>;
  capabilities: CapabilityStatus[];
}

export interface SettingsPatch {
  expectedRevision: SettingsRevision;
  scope: SettingScope;
  changes: Record<string, unknown>;
}

export type SettingsWriteResult =
  | {
      ok: true;
      snapshot: SettingsSnapshot;
      apply: 'immediate' | 'next-turn' | 'restart';
      audit: 'recorded' | 'incomplete';
      durability: 'confirmed' | 'uncertain';
    }
  | { ok: false; code: 'CONFLICT' | 'INVALID' | 'BUSY' | 'IO_ERROR'; fields?: Record<string, string> };
