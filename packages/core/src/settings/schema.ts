import { DEFAULT_MODE_IDS, isClockTime, isShortcut, isTimeZone, shortcutIssues } from './preferences.js';
import type { SunConfig } from '../config.js';
import type { SettingsPatch } from './types.js';
import { REVIEW_RULE_SOURCES, REVIEW_SEVERITIES } from '../review.js';

export class SettingsConfigError extends Error {
  constructor(public readonly code: 'INVALID_CONFIG' | 'NEWER_CONFIG', message: string, public readonly fields?: Record<string, string>) {
    super(message);
  }
}

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));

const bool = (value: unknown) => typeof value === 'boolean';
const text = (value: unknown) => typeof value === 'string' && value.length <= 4096;
const nonempty = (value: unknown) => text(value) && (value as string).trim().length > 0;
const strings = (value: unknown) => Array.isArray(value) && value.length <= 4096 && value.every(nonempty);
const integer = (min: number, max: number) => (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const oneOf = (...choices: string[]) => (value: unknown) => typeof value === 'string' && choices.includes(value);

export const settingChecks = {
  'ui.language': oneOf('system', 'en', 'zh-CN'),
  'ui.theme': oneOf('system', 'light', 'dark'),
  'ui.textScale': (value: unknown) => typeof value === 'number' && value >= 0.8 && value <= 1.5,
  'ui.reducedMotion': oneOf('system', 'reduce', 'full'),
  'ui.startPage': oneOf('chat', 'settings'),
  'ui.readAloud': bool,
  'ui.mini': bool,
  'ui.appshots': bool,
  'ui.notifications.completion': bool,
  'ui.notifications.pause': bool,
  'ui.notifications.failure': bool,
  'ui.notifications.approval': bool,
  'ui.notifications.quietHours.enabled': bool,
  'ui.notifications.quietHours.timeZone': isTimeZone,
  'ui.notifications.quietHours.start': isClockTime,
  'ui.notifications.quietHours.end': isClockTime,
  'ui.shortcuts.palette': isShortcut,
  'ui.shortcuts.newChat': isShortcut,
  'ui.shortcuts.mini': isShortcut,
  'ui.shortcuts.appshot': isShortcut,
  'storage.trashDays': integer(1, 365),
  'storage.autoCleanupDays': integer(0, 3650),
  defaultMode: oneOf(...DEFAULT_MODE_IDS),
  'memory.enabled': bool,
  'voice.enabled': bool,
  'voice.stt': nonempty,
  defaultModel: text,
  fallbackModels: strings,
  approval: oneOf('suggest', 'auto-edit', 'full-auto'),
  denyInsteadOfPrompting: bool,
  maxSteps: integer(1, Number.MAX_SAFE_INTEGER),
  'autoResume.enabled': bool,
  'autoResume.intervalMinutes': integer(1, Number.MAX_SAFE_INTEGER),
  'sandbox.mode': oneOf('off', 'auto', 'seatbelt', 'bwrap', 'docker'),
  'sandbox.network': oneOf('on', 'allowlist', 'off'),
  'sandbox.allow': strings,
  'sandbox.autoApprove': bool,
  'kb.roots': strings,
  'kb.company.enabled': bool,
  'kb.company.baseUrl': text,
  'kb.embeddings.enabled': bool,
  'kb.embeddings.model': text,
  'intel.hour': integer(0, 23),
  'intel.minute': integer(0, 59),
  'briefing.enabled': bool,
  'briefing.hour': integer(0, 23),
  'briefing.minute': integer(0, 59),
  'taint.untrusted': strings,
  'review.model': text,
  'review.minimumSeverity': oneOf(...REVIEW_SEVERITIES),
  'review.rules': oneOf(...REVIEW_RULE_SOURCES),
  'review.diffBytes': integer(512, 96 * 1024),
  'review.completionGate': bool,
};

export function getValue(document: unknown, path: readonly string[]): unknown {
  let value = document;
  for (const part of path) {
    if (!record(value) || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

export function setValue(document: Record<string, unknown>, [key, ...path]: readonly string[], value: unknown): Record<string, unknown> {
  if (!path.length) return { ...document, [key]: value };
  const child = Object.hasOwn(document, key) ? document[key] : undefined;
  return { ...document, [key]: setValue(record(child) ? child : {}, path, value) };
}

export function validateConfigVersion(document: Record<string, unknown>): void {
  const version = document.settingsSchemaVersion;
  if (version === undefined || version === 1) return;
  if (typeof version === 'number' && Number.isSafeInteger(version) && version > 1) {
    throw new SettingsConfigError('NEWER_CONFIG', 'Configuration requires a newer version of sun-harness.');
  }
  throw new SettingsConfigError('INVALID_CONFIG', 'Invalid configuration schema version.');
}

/** Check settings consumed by this interface before launching the runtime or committing an edit. */
export function validateEffectiveSettings(config: SunConfig): void {
  for (const [key, valid] of Object.entries(settingChecks)) {
    if (!valid(getValue(config, key.split('.')))) {
      throw new SettingsConfigError('INVALID_CONFIG', `Invalid configuration field: ${key}.`);
    }
  }
  const bindings = shortcutIssues(config.ui.shortcuts);
  if (Object.keys(bindings).length) throw new SettingsConfigError('INVALID_CONFIG', 'Configuration contains invalid shortcut bindings.', bindings);
  const additional = [
    ['sandbox.docker.image', nonempty], ['intel.sources', Array.isArray], ['plugins.disabled', strings],
  ] as const;
  for (const [key, valid] of additional) {
    if (!valid(getValue(config, key.split('.')))) {
      throw new SettingsConfigError('INVALID_CONFIG', `Invalid configuration field: ${key}.`);
    }
  }
  for (const provider of Object.values(config.providers)) {
    if (!record(provider) || !nonempty(provider.baseUrl) || !strings(provider.models) || !oneOf('openai', 'anthropic')(provider.type)
      || (provider.apiKey !== undefined && !text(provider.apiKey))
      || (provider.apiKeyEnv !== undefined && !text(provider.apiKeyEnv))) {
      throw new SettingsConfigError('INVALID_CONFIG', 'Invalid provider configuration.');
    }
  }
}

export function editableEndpoint(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}

export function providerSettingKey(id: string, field: 'baseUrl' | 'models'): string {
  return `providers.${id.replaceAll('%', '%25').replaceAll('.', '%2E')}.${field}`;
}

type Edit = { key: string; path: readonly string[]; value: unknown };

export function validatedEdits(input: unknown, config: SunConfig, managePlugin = false): { patch: SettingsPatch; edits: Edit[] } | { fields: Record<string, string> } {
  if (!record(input) || typeof input.expectedRevision !== 'string' || !/^(missing|[0-9a-f]{64})$/.test(input.expectedRevision)
    || (input.scope !== 'user' && input.scope !== 'host') || !record(input.changes)) {
    return { fields: { request: 'INVALID_PATCH' } };
  }
  const entries = Object.entries(input.changes);
  if (!entries.length || entries.length > 128) return { fields: { request: 'INVALID_PATCH' } };

  const providerPaths = new Map(Object.keys(config.providers).filter(id => !['__proto__', 'constructor', 'prototype'].includes(id))
    .flatMap(id => (['baseUrl', 'models'] as const).map(field => [providerSettingKey(id, field), ['providers', id, field]] as const)));
  const fields: Record<string, string> = {};
  const edits: Edit[] = [];
  for (const [key, value] of entries) {
    const provider = providerPaths.get(key);
    const check = key === 'plugins.disabled' && managePlugin ? strings
      : Object.hasOwn(settingChecks, key) ? settingChecks[key as keyof typeof settingChecks] : undefined;
    if (!provider && !check) {
      fields.request = 'UNKNOWN_SETTING';
      continue;
    }
    if ((key.startsWith('ui.') ? 'user' : 'host') !== input.scope) {
      fields[key] = 'WRONG_SCOPE';
      continue;
    }
    const path = provider ?? key.split('.');
    const endpoint = (provider && path[2] === 'baseUrl') || key === 'kb.company.baseUrl';
    if (endpoint) {
      const current = getValue(config, path);
      if (typeof current === 'string' && current && !editableEndpoint(current)) {
        fields[key] = 'LOCAL_EDIT_REQUIRED';
        continue;
      }
    }
    const valid = key === 'defaultModel' ? nonempty(value) : endpoint
      ? (key === 'kb.company.baseUrl' && value === '') || (text(value) && editableEndpoint(value as string))
      : provider ? strings(value) : check!(value);
    if (!valid) fields[key] = 'INVALID_VALUE';
    else edits.push({ key, path, value });
  }
  return Object.keys(fields).length ? { fields } : { patch: input as unknown as SettingsPatch, edits };
}

export function validateModelEdits(before: SunConfig, after: SunConfig, keys: string[]): Record<string, string> {
  const hasModel = (ref: string) => Object.entries(after.providers).some(([id, provider]) => provider.models.some(model => ref === `${id}/${model}`));
  const fields: Record<string, string> = {};
  if (keys.includes('defaultModel') && after.defaultModel !== 'auto' && !hasModel(after.defaultModel)) fields.defaultModel = 'UNKNOWN_MODEL';
  if (keys.includes('fallbackModels') && after.fallbackModels.some(ref => !hasModel(ref))) fields.fallbackModels = 'UNKNOWN_MODEL';
  if (keys.includes('review.model') && after.review.model && !hasModel(after.review.model)) fields['review.model'] = 'UNKNOWN_MODEL';
  if (keys.includes('voice.stt')) {
    const separator = after.voice.stt.indexOf('/');
    const provider = after.voice.stt.slice(0, separator);
    if (separator < 1 || !after.voice.stt.slice(separator + 1).trim() || !Object.hasOwn(after.providers, provider)) {
      fields['voice.stt'] = 'UNKNOWN_MODEL';
    }
  }
  for (const [id, provider] of Object.entries(before.providers)) {
    const key = providerSettingKey(id, 'models');
    if (keys.includes(key) && provider.models.some(model => {
      const ref = `${id}/${model}`;
      return (after.defaultModel === ref || after.fallbackModels.includes(ref) || after.review.model === ref) && !hasModel(ref);
    })) fields[key] = 'MODEL_IN_USE';
  }
  return fields;
}
