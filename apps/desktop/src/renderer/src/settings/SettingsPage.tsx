import type { SettingsSnapshot } from '@sun/core';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../api';
import { resolveLang, setLang, t } from '../i18n';
import { BriefingNow, Efficiency, LongTermMemory } from '../pages';
import { settingsFeedback, settingsLoadError } from '../settings-feedback';
import { fieldLabel, initialValue, patchValues, SettingsFields, type Draft, type FieldValue } from './fields';
import { BrowserPermissionsPanel } from './BrowserPermissionsPanel';
import { HooksPanel } from './HooksPanel';
import { ExecutionJobsPanel } from './ExecutionJobsPanel';
import { CredentialsPanel } from './CredentialsPanel';
import { ComputerPanel } from './ComputerPanel';
import { ConnectionsPanel } from './ConnectionsPanel';
import { WorktreesPanel } from './WorktreesPanel';
import { PluginsPanel } from './PluginsPanel';
import { ArchivesPanel, StoragePanel, TransferPanel } from './data-controls';
import { MiniAccess, NotificationAccess, PersonalNotes, UsageEstimates, VoiceAccess } from './personal';
import { fieldDomId, type AppRoute } from './routes';
import { FIELD_LABELS, GROUPS, searchSettings, visibleSections, type SettingsMatch, type SettingsSection } from './sections';

type Route = Extract<AppRoute, { page: 'settings' }>;
type Activity = (dirty: boolean, saving: boolean) => void;

function focusField(field: Route['field'], heading: HTMLHeadingElement | null) {
  const target = field ? document.getElementById(fieldDomId(field)) : null;
  if (target && !target.matches(':disabled')) target.focus();
  else heading?.focus();
}

function SectionPanel({ route, section, snapshot, onSnapshot, reportActivity, onOpenSession, workspace, stale }: {
  route: Route;
  section: SettingsSection;
  snapshot: SettingsSnapshot;
  onSnapshot(snapshot: SettingsSnapshot): void;
  reportActivity: Activity;
  onOpenSession(id: string): void;
  workspace?: string;
  stale: boolean;
}) {
  const [draft, setDraft] = useState<Draft>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<'reload' | 'review'>();
  const busy = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const dirty = Object.keys(draft).length > 0;
  const scope = 'scope' in section ? section.scope : undefined;
  const revision = scope === 'user' ? snapshot.userRevision ?? snapshot.revision : snapshot.revision;
  const draftRevision = useRef<string | undefined>(undefined);
  const locked = stale && (scope !== 'user' || !snapshot.userRevision) && section.id !== 'connections' && section.id !== 'passwords';
  const [notesActivity, setNotesActivity] = useState({ dirty: false, saving: false });
  const reportNotes = useCallback((dirty: boolean, saving: boolean) => setNotesActivity({ dirty, saving }), []);

  useLayoutEffect(() => reportActivity(dirty || notesActivity.dirty, saving || notesActivity.saving),
    [dirty, saving, notesActivity, reportActivity]);
  useLayoutEffect(() => () => reportActivity(false, false), [reportActivity]);
  useEffect(() => focusField(route.field, heading.current), [route.field]);

  function edit(key: string, value: FieldValue) {
    if (!dirty) draftRevision.current = revision;
    setDraft(previous => {
      const next = { ...previous };
      if (JSON.stringify(value) === JSON.stringify(initialValue(snapshot.values, key))) delete next[key];
      else next[key] = value;
      return next;
    });
    setErrors(previous => {
      const next = { ...previous };
      delete next[key];
      return next;
    });
    if (!conflict) setFeedback('');
  }

  function discard() {
    draftRevision.current = undefined;
    setDraft({});
    setErrors({});
    setFeedback('');
    setConflict(undefined);
  }

  async function reload() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const latest = await api.getSettings();
      draftRevision.current = scope === 'user' ? latest.userRevision ?? latest.revision : latest.revision;
      onSnapshot(latest);
      setErrors({});
      setConflict('review');
      setFeedback(t('Review the latest values, then apply your edits.'));
    } catch (error) {
      setFeedback(settingsLoadError(error));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  async function save() {
    if (busy.current || !dirty || !scope || locked || conflict === 'reload') return;
    busy.current = true;
    setSaving(true);
    setFeedback('');
    try {
      const result = await api.updateSettings({ expectedRevision: draftRevision.current ?? revision, scope, changes: patchValues(draft) });
      if (result.ok) {
        discard();
        onSnapshot(result.snapshot);
        if (scope === 'user') setLang(resolveLang(result.snapshot.values.ui.language));
      } else {
        setErrors(result.fields ?? {});
        if (result.code === 'CONFLICT') setConflict('reload');
      }
      setFeedback(settingsFeedback(result));
    } catch {
      setConflict('reload');
      setFeedback(t('The save could not be confirmed. Reload settings before trying again.'));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  function renderValue(key: string, value: FieldValue) {
    if (key.endsWith('.baseUrl')) {
      try {
        const endpoint = new URL(String(value));
        if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !['https:', 'http:'].includes(endpoint.protocol)) {
          return t('Endpoint edit');
        }
      } catch {
        return t('Endpoint edit');
      }
    }
    return Array.isArray(value) ? value.join(', ') : String(value);
  }

  return (
    <section className="settings-panel" data-settings-panel={section.id}>
      <header>
        <h2 ref={heading} tabIndex={-1}>{t(section.label)}</h2>
        {scope && <p className="muted small">{scope === 'user'
          ? snapshot.userRevision ? t('On this computer · applies immediately') : t('User preference · applies immediately')
          : section.id === 'intel' ? t('Execution host · reinstall the managed schedule to apply')
          : t('Execution host · applies before the next run')}</p>}
      </header>
      <fieldset className="connection-fieldset" disabled={locked}>
      {section.id === 'execution-targets' && <ExecutionJobsPanel reportActivity={reportNotes} />}
      {section.id === 'connections' && <ConnectionsPanel reportActivity={reportNotes} />}
      {section.id === 'browser' && <BrowserPermissionsPanel />}
      {section.id === 'passwords' && <CredentialsPanel reportActivity={reportNotes} />}
      {section.id === 'computer-use' && <ComputerPanel onOpenSession={onOpenSession} />}
      {section.id === 'worktrees' && <WorktreesPanel />}
      {section.id === 'hooks' && <HooksPanel workspace={workspace} reportActivity={reportNotes} />}
      {section.id === 'plugins' && <PluginsPanel />}
      {section.id === 'archives' && <ArchivesPanel onOpen={onOpenSession} />}
      {section.id === 'data-controls' && <TransferPanel onOpen={onOpenSession} reportActivity={reportNotes} />}
      {section.id === 'usage' && <><UsageEstimates /><div className="settings-metrics"><Efficiency /></div></>}
      {section.id === 'profile' && <PersonalNotes kind="profile" reportActivity={reportNotes} />}
      {section.id === 'instructions' && <PersonalNotes kind="instructions" reportActivity={reportNotes} />}
      {scope && (
        <form noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset className="card settings-fields" disabled={saving || conflict === 'reload'}>
            <SettingsFields section={section.id} snapshot={snapshot} draft={draft} errors={errors} edit={edit} />
          </fieldset>
          {section.id === 'briefing' && <BriefingNow />}
          {conflict === 'review' && dirty && (
            <div className="card settings-conflict">
              <h3>{t('Review conflicting settings')}</h3>
              {Object.entries(draft).map(([key, value]) => (
                <div key={key}>
                  <strong>{fieldLabel(key)}</strong>
                  <p>{t('Current value')} <code>{renderValue(key, initialValue(snapshot.values, key))}</code></p>
                  <p>{t('Your edit')} <code>{renderValue(key, value)}</code></p>
                </div>
              ))}
            </div>
          )}
          <div className="settings-actions">
            {conflict === 'reload'
              ? <button type="button" className="btn-primary" disabled={saving} onClick={() => void reload()}>{t('Reload settings')}</button>
              : <button type="submit" className="btn-primary" disabled={saving || !dirty}>{conflict === 'review' ? t('Apply my edits') : t('Save changes')}</button>}
            <button type="button" className="btn-ghost" onClick={discard} disabled={saving || !dirty}>{t('Discard edit')}</button>
            <span role="status">{saving ? t('Saving settings…') : feedback || (dirty ? t('Unsaved changes') : '')}</span>
          </div>
        </form>
      )}
      {section.id === 'storage' && <StoragePanel reportActivity={reportNotes} />}
      {section.id === 'notifications' && <NotificationAccess />}
      {section.id === 'voice' && <VoiceAccess voice={snapshot.values.voice} />}
      {section.id === 'mini' && <MiniAccess enabled={snapshot.values.ui.mini} revision={snapshot.userRevision ?? snapshot.revision} />}
      {section.id === 'memory' && (
        <>
          <PersonalNotes kind="memory" reportActivity={reportNotes} />
          <section className="card">
            <p className="muted small">{t('Long-term memories are extracted by the assistant and stored on the execution host.')}</p>
            <LongTermMemory />
          </section>
        </>
      )}
      </fieldset>
    </section>
  );
}

function SettingsNavigation({ sections, route, onRoute }: {
  sections: SettingsSection[];
  route: Route;
  onRoute(route: AppRoute): boolean;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLUListElement>(null);
  const searching = !!query.trim();
  const matches = searching ? searchSettings(query, sections) : [];

  function open(match: SettingsMatch) {
    const section = sections.find(item => item.id === match.section);
    if (!section) return;
    const next: AppRoute = 'link' in section
      ? { page: section.link }
      : { page: 'settings', section: section.id, ...(match.field ? { field: match.field } : {}) };
    if (!onRoute(next)) return;
    setQuery('');
    if (next.page === 'settings' && next.section === route.section && next.field === route.field) {
      const heading = document.querySelector<HTMLHeadingElement>('[data-settings-panel] h2');
      focusField(next.field, heading);
    }
  }

  function keys(event: KeyboardEvent) {
    const buttons = [...(results.current?.querySelectorAll('button') ?? [])];
    if (event.key === 'Escape' && searching) {
      event.preventDefault();
      setQuery('');
      search.current?.focus();
    } else if (event.key === 'Enter' && event.target === search.current && matches.length) {
      event.preventDefault();
      open(matches[0]);
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.findIndex(button => button === event.target);
      if (event.key === 'ArrowDown') buttons[Math.min(index + 1, buttons.length - 1)]?.focus();
      else if (index > 0) buttons[index - 1]?.focus();
      else search.current?.focus();
    }
  }

  return (
    <nav className="settings-nav" aria-label={t('Settings sections')} onKeyDown={keys}>
      <label className="settings-search" htmlFor="settings-search">{t('Search settings')}</label>
      <input id="settings-search" type="search" ref={search} value={query} aria-controls={searching ? 'settings-results' : undefined}
        placeholder={t('Search settings')} onChange={event => setQuery(event.target.value)} />
      {searching ? (
        <ul id="settings-results" ref={results} className="settings-links" aria-label={t('Search results')}>
          {matches.length ? matches.map(match => {
            const section = sections.find(item => item.id === match.section)!;
            return (
              <li key={`${match.section}:${match.field ?? ''}`}>
                <button type="button" onClick={() => open(match)} data-settings-section={section.id} data-settings-field={match.field}>
                  <span>{t(section.label)}</span>
                  {match.field && <small>{t(FIELD_LABELS[match.field])}</small>}
                </button>
              </li>
            );
          }) : <li role="status">{t('No matching settings.')}</li>}
        </ul>
      ) : GROUPS.map(group => {
        const items = sections.filter(section => section.group === group.id);
        return items.length > 0 && (
          <div className="settings-group" key={group.id}>
            <h3>{t(group.label)}</h3>
            <ul className="settings-links">
              {items.map(section => (
                <li key={section.id}>
                  <button type="button" data-settings-section={section.id} aria-current={route.section === section.id ? 'page' : undefined}
                    onClick={() => open({ section: section.id })}>{t(section.label)}</button>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

export function SettingsPage({ route, onRoute, reportActivity, onSettings, onOpenSession, workspace, stale, refresh }: {
  route: Route;
  onRoute(route: AppRoute): boolean;
  reportActivity: Activity;
  onOpenSession(id: string): void;
  workspace?: string;
  onSettings(snapshot: SettingsSnapshot): void;
  stale: boolean;
  refresh: number;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot>();
  const [loadError, setLoadError] = useState<unknown>();
  const [home, setHome] = useState<string>();
  async function load() {
    setLoadError(undefined);
    try {
      setSnapshot(await api.getSettings());
    } catch (error) {
      setLoadError(error);
    }
  }

  useEffect(() => {
    void load();
    void api.appInfo().then(info => setHome(info.home), () => undefined);
  }, [refresh]);

  const sections = snapshot ? visibleSections(snapshot.capabilities).filter(section => !snapshot.hostSettingsUnavailable
    || section.id === 'connections' || section.id === 'passwords' || 'scope' in section && section.scope === 'user') : [];
  const selected = sections.find(section => section.id === route.section && !('link' in section));

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t('Settings')}</h1>
          <p className="muted intro">{t('Stored in {path}. API keys are read from environment variables (your login shell is imported at launch).', { path: `${home ?? '~/.sun'}/config.json` })}</p>
        </div>
      </header>
      {snapshot ? (
        <div className="settings-layout">
          <SettingsNavigation sections={sections} route={route} onRoute={onRoute} />
          {selected ? (
            <SectionPanel key={selected.id} route={route} section={selected} snapshot={snapshot} onSnapshot={next => { setSnapshot(next); onSettings(next); }} reportActivity={reportActivity} onOpenSession={onOpenSession} workspace={workspace} stale={stale} />
          ) : <p role="status">{t('This settings section is unavailable on the current host.')}</p>}
        </div>
      ) : <div role="status">
        <p>{loadError ? settingsLoadError(loadError) : t('Loading settings…')}</p>
        {!!loadError && <button type="button" onClick={() => void load()}>{t('Reload settings')}</button>}
      </div>}
    </div>
  );
}
