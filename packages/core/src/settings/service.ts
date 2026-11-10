import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configFile, isProviderReady, resolveConfig, type SunConfig } from '../config.js';
import { homePath } from '../paths.js';
import { editableEndpoint, getValue, providerSettingKey, record, settingChecks, setValue, validateModelEdits, validatedEdits } from './schema.js';
import { SETTINGS_PROTOCOL_VERSION } from './protocol.js';
import { readSettingsFile, transactSettingsFile, type SettingsFile } from './store.js';
import type { PublicProviderSettings, SettingsPatch, SettingsSnapshot, SettingsWriteResult } from './types.js';

function snapshot(file: SettingsFile, config: SunConfig): SettingsSnapshot {
  const origins: SettingsSnapshot['origins'] = {};
  for (const key of Object.keys(settingChecks)) {
    origins[key] = {
      source: getValue(file.document, key.split('.')) === undefined ? 'default' : 'user',
      editable: true,
    };
  }
  const providers = Object.fromEntries(Object.entries(config.providers).map(([id, provider]) => {
    const source = provider.apiKey ? 'file' : provider.apiKeyEnv ? 'environment' : 'none';
    const publicProvider: PublicProviderSettings = {
      id, source, configured: isProviderReady(provider), noKey: !!provider.noKey,
      baseUrl: editableEndpoint(provider.baseUrl) ? provider.baseUrl : '',
      models: [...provider.models],
    };
    const supportedId = !['__proto__', 'constructor', 'prototype'].includes(id);
    for (const key of ['baseUrl', 'models'] as const) {
      origins[providerSettingKey(id, key)] = {
        source: getValue(file.document, ['providers', id, key]) === undefined ? 'default' : 'user',
        editable: supportedId && (key !== 'baseUrl' || !!publicProvider.baseUrl),
      };
    }
    origins[`providers.${id}.credentials`] = { source: source === 'file' ? 'user' : source === 'environment' ? 'environment' : 'default', editable: false };
    return [id, publicProvider];
  }));
  const { ui, autoResume, sandbox, kb, intel, briefing, taint } = config;
  const quiet = ui.notifications.quietHours;
  const speechProviderId = config.voice.stt.split('/')[0];
  const speechProvider = Object.hasOwn(config.providers, speechProviderId) ? config.providers[speechProviderId] : undefined;
  const companyUrl = editableEndpoint(kb.company.baseUrl) ? kb.company.baseUrl : '';
  origins['kb.company.baseUrl'].editable = !kb.company.baseUrl || !!companyUrl;
  return {
    protocolVersion: SETTINGS_PROTOCOL_VERSION,
    revision: file.revision,
    origins,
    capabilities: [],
    values: {
      ui: {
        language: ui.language, theme: ui.theme, textScale: ui.textScale, reducedMotion: ui.reducedMotion,
        startPage: ui.startPage, readAloud: ui.readAloud, mini: ui.mini, appshots: ui.appshots,
        notifications: {
          completion: ui.notifications.completion, pause: ui.notifications.pause,
          failure: ui.notifications.failure, approval: ui.notifications.approval,
          quietHours: { enabled: quiet.enabled, timeZone: quiet.timeZone, start: quiet.start, end: quiet.end },
        },
        shortcuts: { palette: ui.shortcuts.palette, newChat: ui.shortcuts.newChat, mini: ui.shortcuts.mini, appshot: ui.shortcuts.appshot },
      },
      storage: { trashDays: config.storage.trashDays, autoCleanupDays: config.storage.autoCleanupDays },
      defaultMode: config.defaultMode,
      memory: { enabled: config.memory.enabled !== false },
      voice: { enabled: config.voice.enabled !== false, stt: config.voice.stt, ready: !!speechProvider && isProviderReady(speechProvider) },
      providers,
      defaultModel: config.defaultModel,
      fallbackModels: [...config.fallbackModels],
      approval: config.approval,
      denyInsteadOfPrompting: config.denyInsteadOfPrompting,
      maxSteps: config.maxSteps,
      autoResume: { enabled: autoResume.enabled, intervalMinutes: autoResume.intervalMinutes },
      sandbox: {
        mode: sandbox.mode, network: sandbox.network, allow: [...sandbox.allow],
        autoApprove: sandbox.autoApprove, docker: { image: sandbox.docker.image },
      },
      kb: {
        roots: [...kb.roots],
        company: { enabled: kb.company.enabled, baseUrl: companyUrl },
        embeddings: { enabled: kb.embeddings.enabled, model: kb.embeddings.model },
      },
      intel: { hour: intel.hour, minute: intel.minute, sourceCount: intel.sources.length },
      briefing: { enabled: briefing.enabled, hour: briefing.hour, minute: briefing.minute },
      taint: { untrusted: [...taint.untrusted] },
      review: { ...config.review },
    },
  };
}

export function getSettings(): SettingsSnapshot {
  const file = readSettingsFile(configFile());
  return snapshot(file, resolveConfig(file.document));
}

export function appendSettingsAudit(event: Record<string, unknown>): void {
  const file = homePath('settings', 'audit.jsonl');
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fd = openSync(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, time: new Date().toISOString(), ...event }) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function writeSettings(
  input: unknown,
  isBusy: (patch: SettingsPatch) => boolean,
  plugin?: { name: string; enabled: boolean },
): { result: SettingsWriteResult; config?: SunConfig; changedKeys?: string[] } {
  if (!record(input) || typeof input.expectedRevision !== 'string' || !/^(missing|[0-9a-f]{64})$/.test(input.expectedRevision)
    || !record(input.changes) || (input.scope !== 'host' && input.scope !== 'user')) {
    return { result: { ok: false, code: 'INVALID', fields: { request: 'INVALID_PATCH' } } };
  }
  if (input.scope === 'host' && isBusy(input as unknown as SettingsPatch)) return { result: { ok: false, code: 'BUSY' } };
  let auditEvent: Record<string, unknown> | undefined;
  let changedKeys: string[] = [];
  let config: SunConfig | undefined;
  const tx = transactSettingsFile(configFile(), input.expectedRevision, ({ document, revision }) => {
    const current = resolveConfig(document);
    const validation = validatedEdits(plugin ? {
      ...input,
      changes: { 'plugins.disabled': plugin.enabled
        ? current.plugins.disabled.filter(name => name !== plugin.name)
        : [...new Set([...current.plugins.disabled, plugin.name])] },
    } : input, current, !!plugin);
    if ('fields' in validation) return validation;
    const { patch, edits } = validation;
    changedKeys = edits.map(edit => edit.key).sort();
    const next = edits.reduce((doc, edit) => setValue(doc, edit.path, edit.value), document);
    config = resolveConfig(next);
    const fields = validateModelEdits(current, config, changedKeys);
    if (Object.keys(fields).length) return { fields };
    const event = { id: randomUUID(), scope: patch.scope, keys: changedKeys, before: revision };
    appendSettingsAudit({ ...event, outcome: 'prepared' });
    auditEvent = event;
    return { document: next };
  });
  let audit: 'recorded' | 'incomplete' = 'recorded';
  if (auditEvent) {
    try {
      appendSettingsAudit({ ...auditEvent, outcome: tx.ok ? 'committed' : tx.code, ...(tx.ok ? { after: tx.file.revision } : {}) });
    } catch {
      audit = 'incomplete';
    }
  }
  if (!tx.ok) return { result: tx };
  const apply = input.scope === 'user' ? 'immediate' : changedKeys.some(key => key.startsWith('intel.')) ? 'restart' : 'next-turn';
  return { result: { ok: true, snapshot: snapshot(tx.file, config!), apply, audit, durability: tx.durability }, config, changedKeys };
}
