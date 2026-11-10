import type { PublicSettings, ReviewRuleSource, ReviewSeverity, SettingsSnapshot } from '@sun/core';
import { DEFAULT_MODE_IDS, DEFAULT_SHORTCUTS } from '@sun/core/settings-preferences';
import { modeLabel } from '../App';
import type { ReactNode } from 'react';
import { t, tk } from '../i18n';
import { reviewSeverities, severityLabels } from '../Review';
import { FIELD_LABELS, type FieldId, type SectionId } from './sections';
import { fieldDomId } from './routes';

export type FieldValue = string | boolean | string[];
export type Draft = Record<string, FieldValue>;

const csv = (key: string) => key === 'sandbox.allow' || key === 'kb.roots' || /^providers\..+\.models$/.test(key);
const numeric = new Set(['storage.trashDays', 'storage.autoCleanupDays', 'ui.textScale', 'maxSteps', 'autoResume.intervalMinutes', 'briefing.hour', 'briefing.minute', 'intel.hour', 'intel.minute', 'review.diffBytes']);
const reviewRules: Record<ReviewRuleSource, string> = {
  none: tk('No rules'), global: tk('Global rules'), project: tk('Project rules'), all: tk('Global and project rules'),
};
const providerKey = (id: string, field: 'baseUrl' | 'models') => `providers.${id.replaceAll('%', '%25').replaceAll('.', '%2E')}.${field}`;

export function initialValue(values: PublicSettings, key: string): FieldValue {
  let value: unknown;
  const provider = Object.entries(values.providers).find(([id]) => key === providerKey(id, 'baseUrl') || key === providerKey(id, 'models'));
  if (provider) value = key.endsWith('.models') ? provider[1].models : provider[1].baseUrl;
  else value = key.split('.').reduce<unknown>((parent, part) =>
    parent && typeof parent === 'object' && Object.hasOwn(parent, part) ? (parent as Record<string, unknown>)[part] : undefined, values);
  if (csv(key) && Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value;
  return String(value ?? '');
}

export function patchValues(draft: Draft): Record<string, unknown> {
  return Object.fromEntries(Object.entries(draft).map(([key, value]) => {
    if (numeric.has(key)) return [key, String(value).trim() ? Number(value) : null];
    if (csv(key)) return [key, String(value).split(',').map(item => item.trim()).filter(Boolean)];
    return [key, value];
  }));
}

export function fieldLabel(key: string): string {
  if (Object.hasOwn(FIELD_LABELS, key)) return t(FIELD_LABELS[key as FieldId]);
  if (key.startsWith('providers.')) return t(FIELD_LABELS[key.endsWith('.models') ? 'providerModels' : 'providerEndpoint']);
  return key;
}

interface Props {
  section: SectionId;
  snapshot: SettingsSnapshot;
  draft: Draft;
  errors: Record<string, string>;
  edit(key: string, value: FieldValue): void;
}

export function SettingsFields({ section, snapshot, draft, errors, edit }: Props) {
  const cfg = snapshot.values;
  const value = (key: string) => draft[key] ?? initialValue(cfg, key);
  const controlProps = (key: string, focusId = key) => ({
    id: fieldDomId(focusId),
    disabled: !snapshot.origins[key]?.editable,
    'aria-invalid': !!errors[key],
    'aria-describedby': `${fieldDomId(focusId)}-hint`,
  });

  function row(key: string, control: ReactNode, focusId = key) {
    const origin = snapshot.origins[key];
    return (
      <div className="settings-field" key={key}>
        <label htmlFor={fieldDomId(focusId)}>{fieldLabel(key)}</label>
        {control}
        <small className={errors[key] ? 'err-text' : 'muted'} id={`${fieldDomId(focusId)}-hint`}>
          {errors[key] ? t('This setting has an invalid value.')
            : !origin?.editable ? t('Edit this endpoint in the local configuration file.')
            : origin.source === 'default' ? t('From defaults')
            : origin.source === 'environment' ? t('From the environment') : t('From configuration')}
        </small>
      </div>
    );
  }

  function text(key: string, opts: { focus?: string; min?: number; max?: number; step?: number; type?: 'time'; placeholder?: string } = {}) {
    return row(key, (
      <input {...controlProps(key, opts.focus)} type={opts.type ?? (numeric.has(key) ? 'number' : 'text')}
        value={String(value(key))} min={opts.min} max={opts.max} step={opts.step} placeholder={opts.placeholder}
        onChange={event => edit(key, event.target.value)} />
    ), opts.focus);
  }

  function toggle(key: string) {
    return row(key, <input {...controlProps(key)} type="checkbox" checked={value(key) === true} onChange={event => edit(key, event.target.checked)} />);
  }

  function select(key: string, choices: readonly string[], label: (choice: string) => string = choice => choice) {
    return row(key, (
      <select {...controlProps(key)} value={String(value(key))} onChange={event => edit(key, event.target.value)}>
        {choices.map(choice => <option key={choice} value={choice}>{label(choice)}</option>)}
      </select>
    ));
  }

  switch (section) {
    case 'language':
      return <>
        {select('ui.language', ['system', 'en', 'zh-CN'], choice => choice === 'system' ? t('System') : choice === 'en' ? 'English' : '简体中文')}
        <p className="muted small">{t('System follows the language of your OS or browser.')}</p>
      </>;
    case 'general': {
      const ready = Object.values(cfg.providers).filter(p => p.configured).flatMap(p => p.models.map(model => `${p.id}/${model}`));
      const fallback = value('fallbackModels') as string[];
      return <>
        {select('defaultMode', DEFAULT_MODE_IDS, modeLabel)}
        {select('defaultModel', [...new Set([cfg.defaultModel, ...ready])])}
        <fieldset className="settings-fields settings-field" id={fieldDomId('fallbackModels')} tabIndex={-1} aria-invalid={!!errors.fallbackModels}>
          <legend>{t(FIELD_LABELS.fallbackModels)}</legend>
          <div className="chips">
            {[...new Set([...ready, ...fallback])].map(model => {
              const selected = fallback.includes(model);
              return (
                <button type="button" className={`chip ${selected ? 'on' : ''}`} key={model} aria-pressed={selected}
                  onClick={() => edit('fallbackModels', selected ? fallback.filter(item => item !== model) : [...fallback, model])}>
                  {selected ? `${fallback.indexOf(model) + 1}. ` : ''}{model}
                </button>
              );
            })}
          </div>
          {errors.fallbackModels && <small className="err-text">{t('This setting has an invalid value.')}</small>}
        </fieldset>
        {toggle('autoResume.enabled')}
        {text('autoResume.intervalMinutes', { min: 1 })}
        {select('approval', ['suggest', 'auto-edit', 'full-auto'])}
        <p className="muted small">{t('suggest: ask before any write or command · auto-edit: workspace edits are free, commands and network ask · full-auto: never ask')}</p>
        {toggle('denyInsteadOfPrompting')}
        {text('maxSteps', { min: 1 })}
      </>;
    }
    case 'storage':
      return <>
        {text('storage.trashDays', { min: 1, max: 365 })}
        {text('storage.autoCleanupDays', { min: 0, max: 3650 })}
        <p className="muted small">{t('Set automatic cleanup to 0 to turn it off. When enabled, it moves old inactive archived chats and unreferenced attachments to trash.')}</p>
      </>;
    case 'review': {
      const ready = Object.values(cfg.providers).filter(provider => provider.configured)
        .flatMap(provider => provider.models.map(model => `${provider.id}/${model}`));
      return <>
        {select('review.model', [...new Set(['', cfg.review.model, ...ready])], model => model || t('Use the session model'))}
        {select('review.minimumSeverity', reviewSeverities, severity => t(severityLabels[severity as ReviewSeverity]))}
        {select('review.rules', Object.keys(reviewRules), source => t(reviewRules[source as ReviewRuleSource]))}
        {text('review.diffBytes', { min: 512, max: 96 * 1024 })}
        {toggle('review.completionGate')}
        <p className="muted small">{t('A review with findings or omitted changes pauses coding runs when this gate is enabled.')}</p>
      </>;
    }
    case 'appearance':
      return <>
        {select('ui.theme', ['system', 'light', 'dark'], choice => choice === 'system' ? t('System') : choice === 'light' ? t('Light') : t('Dark'))}
        {text('ui.textScale', { min: 0.8, max: 1.5, step: 0.05 })}
        {select('ui.reducedMotion', ['system', 'reduce', 'full'], choice => choice === 'system' ? t('System') : choice === 'reduce' ? t('Reduced motion') : t('Full motion'))}
        {select('ui.startPage', ['chat', 'settings'], choice => choice === 'chat' ? t('Sessions') : t('Settings'))}
      </>;
    case 'notifications':
      return <>
        {toggle('ui.notifications.completion')}
        {toggle('ui.notifications.pause')}
        {toggle('ui.notifications.failure')}
        {toggle('ui.notifications.approval')}
        {toggle('ui.notifications.quietHours.enabled')}
        {text('ui.notifications.quietHours.timeZone', { placeholder: t('Asia/Shanghai') })}
        {text('ui.notifications.quietHours.start', { type: 'time' })}
        {text('ui.notifications.quietHours.end', { type: 'time' })}
        <p className="muted small">{t('Approvals stay visible in the app during quiet hours.')}</p>
      </>;
    case 'memory':
      return <>
        {toggle('memory.enabled')}
        <p className="muted small">{t('Turning memory off stops recall and extraction on the next turn. Your saved notes and memories stay on the execution host.')}</p>
      </>;
    case 'voice':
      return <>
        {toggle('voice.enabled')}
        {text('voice.stt')}
      </>;
    case 'read-aloud':
      return <>{toggle('ui.readAloud')}</>;
    case 'shortcuts':
      return <>
        {text('ui.shortcuts.palette')}
        {text('ui.shortcuts.newChat')}
        <p className="muted small">{t('Use Primary for Command on macOS and Ctrl elsewhere. Clear a shortcut to disable it.')}</p>
        <button type="button" className="btn-ghost" onClick={() => {
          edit('ui.shortcuts.palette', DEFAULT_SHORTCUTS.palette);
          edit('ui.shortcuts.newChat', DEFAULT_SHORTCUTS.newChat);
        }}>{t('Restore default shortcuts')}</button>
      </>;
    case 'appshots':
      return <>
        <p className="muted small">{t('Appshots capture one foreground window and open a private review before attaching it to the chat.')}</p>
        {toggle('ui.appshots')}
        {text('ui.shortcuts.appshot')}
        <button type="button" className="btn-ghost" onClick={() => edit('ui.shortcuts.appshot', DEFAULT_SHORTCUTS.appshot)}>{t('Restore default shortcut')}</button>
        <p className="muted small">{t('Open a chat before using the global shortcut. Capture from the other app while its window is in front.')}</p>
      </>;
    case 'mini':
      return <>
        {toggle('ui.mini')}
        {text('ui.shortcuts.mini')}
        <button type="button" className="btn-ghost" onClick={() => edit('ui.shortcuts.mini', DEFAULT_SHORTCUTS.mini)}>{t('Restore default shortcut')}</button>
      </>;
    case 'sandbox':
      return <>
        {select('sandbox.mode', ['auto', 'seatbelt', 'bwrap', 'docker', 'off'])}
        {select('sandbox.network', ['on', 'allowlist', 'off'], mode => t('network {mode}', { mode }))}
        {text('sandbox.allow')}
        {toggle('sandbox.autoApprove')}
        <p className="muted small">{t("auto: macOS seatbelt or Linux bubblewrap when available · docker: one container per session ({image}) · commands can write only the workspace and package caches; credentials and the harness's tokens are hidden", { image: cfg.sandbox.docker.image })}</p>
      </>;
    case 'providers':
      return Object.values(cfg.providers).map((provider, index) => (
        <section className="settings-provider" key={provider.id}>
          <h3>{provider.id}</h3>
          <p className="muted small">
            <span className={`dot ${provider.configured ? 'dot-idle' : 'dot-off'}`} aria-hidden="true" />
            {provider.noKey ? t('no key') : provider.source === 'environment' ? t('Environment credential')
              : provider.source === 'file' ? t('Stored credential') : t('No credential configured')}
          </p>
          {text(providerKey(provider.id, 'baseUrl'), { focus: index === 0 ? 'providerEndpoint' : undefined })}
          {text(providerKey(provider.id, 'models'), { focus: index === 0 ? 'providerModels' : undefined })}
        </section>
      ));
    case 'knowledge':
      return <>
        {text('kb.roots')}
        {toggle('kb.embeddings.enabled')}
        {text('kb.embeddings.model', { placeholder: t('qwen/text-embedding-v4') })}
        {toggle('kb.company.enabled')}
        {text('kb.company.baseUrl', { placeholder: t('https://kb.company.internal/api') })}
      </>;
    case 'briefing':
      return <>
        {toggle('briefing.enabled')}
        <div className="settings-time">
          {text('briefing.hour', { min: 0, max: 23 })}
          {text('briefing.minute', { min: 0, max: 59 })}
        </div>
      </>;
    case 'intel':
      return <>
        <div className="settings-time">
          {text('intel.hour', { min: 0, max: 23 })}
          {text('intel.minute', { min: 0, max: 59 })}
        </div>
        <p className="muted small">{t('{n} sources · run `sun intel install-schedule` after changing', { n: cfg.intel.sourceCount })}</p>
      </>;
    default:
      return null;
  }
}
