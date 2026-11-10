import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { SessionSummary, SettingsSnapshot } from '@sun/core';
import { USER_PROFILE_MAX } from '@sun/core/settings-preferences';
import { api } from '../api';
import { fmtDate, locale, t } from '../i18n';

export type EditActivity = (dirty: boolean, saving: boolean) => void;

const notes = {
  profile: { read: api.getUserProfile, write: api.setUserProfile, file: 'USER.md' },
  instructions: { read: api.getPersonalInstructions, write: api.setPersonalInstructions, file: 'INSTRUCTIONS.md' },
  memory: { read: () => api.getMemory(true), write: api.setMemory, file: 'MEMORY.md' },
} as const;

export function PersonalNotes({ kind, reportActivity }: { kind: keyof typeof notes; reportActivity: EditActivity }) {
  const note = notes[kind];
  const label = kind === 'profile' ? t('User profile') : kind === 'instructions' ? t('Personal instructions') : t('Core memory notes');
  const limit = kind === 'memory' ? undefined : USER_PROFILE_MAX;
  const [base, setBase] = useState<string>();
  const [text, setText] = useState('');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const busy = useRef(false);
  const dirty = base !== undefined && base !== text;

  useEffect(() => {
    let cancelled = false;
    void note.read().then(value => {
      if (cancelled) return;
      setBase(value);
      setText(value);
    }, () => { if (!cancelled) setFeedback(t('Could not load the notes.')); });
    return () => { cancelled = true; };
  }, [note]);
  useLayoutEffect(() => reportActivity(dirty, saving), [dirty, saving, reportActivity]);
  useLayoutEffect(() => () => reportActivity(false, false), [reportActivity]);

  async function load() {
    if (busy.current) return;
    busy.current = true;
    setSaving(true);
    try {
      const value = await note.read();
      setBase(value);
      setText(value);
      setConflict(false);
      setFeedback('');
    } catch {
      setFeedback(t('Could not load the notes.'));
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  async function save() {
    if (busy.current || base === undefined || !dirty || conflict) return;
    busy.current = true;
    setSaving(true);
    try {
      const written = await note.write(text, base);
      if (written === false) {
        setConflict(true);
        setFeedback(t('The notes changed on the host. Reload them before saving.'));
      } else {
        const value = await note.read();
        setBase(value);
        setText(value);
        setFeedback(t('Saved'));
      }
    } catch {
      setFeedback(t('Could not confirm that the notes were saved.'));
    } finally {
      setSaving(false);
      busy.current = false;
    }
  }

  return (
    <form className="card settings-fields" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="muted small">{t('Source on the execution host · memory/{file}', { file: note.file })}</p>
      <p className="muted small">{kind === 'profile' ? t('Profile facts are included in the session context.')
        : kind === 'instructions' ? t('These standing instructions apply to new turns in every mode.')
        : t('The assistant can add extracted facts to these notes. Core notes are recalled when memory is enabled.')}</p>
      <label htmlFor="settings-notes">{label}</label>
      <textarea id="settings-notes" className="mono" rows={kind === 'memory' ? 10 : 6} maxLength={limit}
        value={text} disabled={base === undefined || saving} onChange={event => { setText(event.target.value); if (!conflict) setFeedback(''); }} />
      {limit && <small className="muted">{t('{count} / {limit} characters', { count: text.length, limit })}</small>}
      <div className="settings-actions">
        <button type="submit" className="btn-primary" disabled={saving || !dirty || conflict}>{t('Save changes')}</button>
        <button type="button" className="btn-ghost" disabled={saving || (!dirty && base !== undefined)}
          onClick={() => void load()}>{t('Reload notes')}</button>
        <span role="status">{saving ? t('Saving settings…') : feedback || (dirty ? t('Unsaved changes') : '')}</span>
      </div>
    </form>
  );
}

type Permission = 'granted' | 'denied' | 'prompt' | 'unavailable' | 'unknown';
function permissionLabel(state: Permission): string {
  switch (state) {
    case 'granted': return t('Allowed');
    case 'denied': return t('Blocked');
    case 'prompt': return t('Permission not requested');
    case 'unavailable': return t('Unavailable');
    case 'unknown': return t('Permission status unknown');
  }
}

function notificationPermission(): Permission {
  if (typeof Notification === 'undefined') return 'unavailable';
  return Notification.permission === 'default' ? 'prompt' : Notification.permission;
}

export function NotificationAccess() {
  const [state, setState] = useState(notificationPermission);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const refresh = () => setState(notificationPermission());
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, []);
  async function ask() {
    setAsking(true);
    setFailed(false);
    try {
      const result = await Notification.requestPermission();
      setState(result === 'default' ? 'prompt' : result);
    } catch {
      setFailed(true);
    } finally {
      setAsking(false);
    }
  }
  return (
    <div className="card settings-fields">
      <h3>{t('Notification permission')}</h3>
      <p className="muted small" role="status">{permissionLabel(state)}</p>
      {state === 'prompt' && <button type="button" className="btn-ghost" disabled={asking} onClick={() => void ask()}>{t('Allow notifications')}</button>}
      {state === 'denied' && <p className="muted small">{t('Allow notifications in your system or browser settings.')}</p>}
      {failed && <p role="alert">{t('Could not request notification permission.')}</p>}
    </div>
  );
}

async function microphonePermission(): Promise<Permission> {
  if (!navigator.mediaDevices?.getUserMedia) return 'unavailable';
  const native = await api.microphonePermission().catch(() => undefined);
  if (native) return native;
  return (await navigator.permissions?.query({ name: 'microphone' as PermissionName }).catch(() => undefined))?.state ?? 'unknown';
}

export function VoiceAccess({ voice }: { voice: SettingsSnapshot['values']['voice'] }) {
  const [permission, setPermission] = useState<Permission>('unknown');
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void microphonePermission().then(state => { if (!cancelled) setPermission(state); }); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { cancelled = true; window.removeEventListener('focus', refresh); };
  }, []);
  return (
    <div className="card settings-fields">
      <h3>{t('Voice readiness')}</h3>
      <p>{!voice.enabled ? t('Voice input is off.') : voice.ready ? t('Transcription provider is configured.') : t('Set up the transcription provider before using voice input.')}</p>
      <p className="muted small">{t('Microphone permission · {status}', { status: permissionLabel(permission) })}</p>
      <p className="muted small">{permission === 'denied' ? t('Microphone permission was denied. You can still type your message.') : t('Start voice input from a chat to request microphone access.')}</p>
    </div>
  );
}

type Cost = Awaited<ReturnType<typeof api.cost>>;
const usd = (amount: number) => `$${amount.toFixed(amount < 0.01 ? 4 : 2)}`;

export function UsageEstimates() {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [selected, setSelected] = useState('');
  const [cost, setCost] = useState<Cost>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [estimateFailed, setEstimateFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const id = sessions?.some(session => session.id === selected) ? selected : sessions?.[0]?.id;
  useEffect(() => {
    let cancelled = false;
    void api.listSessions().then(list => {
      if (!cancelled) { setSessions(list); setLoadFailed(false); }
    }, () => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [refresh]);
  useEffect(() => {
    setCost(undefined);
    setEstimateFailed(false);
    if (!id) return;
    let cancelled = false;
    void api.cost(id).then(report => {
      if (!cancelled) setCost(report);
    }, () => { if (!cancelled) setEstimateFailed(true); });
    return () => { cancelled = true; };
  }, [id, refresh]);
  const hasPrice = cost?.byModel.some(row => row.usd !== undefined);
  return (
    <section className="card settings-fields">
      <h3>{t('Session usage estimate')}</h3>
      <p className="muted small">{t('Estimates use saved token counts and the host pricing table. Copied history is included in the selected session.')}</p>
      {loadFailed ? <p role="alert">{t('Could not load sessions.')}</p>
        : sessions?.length === 0 ? <p>{t('No sessions yet.')}</p>
        : !sessions ? <p role="status">{t('Loading…')}</p> : (
          <>
            <label htmlFor="usage-session">{t('Session')}</label>
            <select id="usage-session" value={id} onChange={event => setSelected(event.target.value)}>
              {sessions.map(session => <option key={session.id} value={session.id}>{session.title} · {fmtDate(session.updatedAt)}</option>)}
            </select>
          </>
        )}
      <button className="btn-ghost" type="button" onClick={() => setRefresh(value => value + 1)}>{t('Refresh')}</button>
      {estimateFailed && <p role="alert">{t('Could not load the usage estimate.')}</p>}
      {id && !cost && !estimateFailed && <p role="status">{t('Loading…')}</p>}
      {cost && (cost.byModel.length ? (
        <>
          <p role="status">{hasPrice ? (cost.unpriced.length
            ? t('Priced subtotal estimate · {amount}', { amount: usd(cost.usd) })
            : t('Estimated total · {amount}', { amount: usd(cost.usd) })) : t('No pricing is configured for the models in this session.')}</p>
          <div className="settings-metrics">
            <table className="metrics">
              <thead><tr><th>{t('Model')}</th><th>{t('Input tokens')}</th><th>{t('Cached tokens')}</th><th>{t('Output tokens')}</th><th>{t('Estimated cost')}</th></tr></thead>
              <tbody>{cost.byModel.map(row => (
                <tr key={row.model}><td>{row.model}</td><td>{row.input.toLocaleString(locale())}</td><td>{row.cached.toLocaleString(locale())}</td>
                  <td>{row.output.toLocaleString(locale())}</td><td>{row.usd === undefined ? t('Unknown price') : usd(row.usd)}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      ) : <p>{t('No token usage was recorded for this session.')}</p>)}
    </section>
  );
}

export function MiniAccess({ enabled, revision }: { enabled: boolean; revision: string }) {
  const [binding, setBinding] = useState<Awaited<ReturnType<typeof api.desktopShortcutStatus>>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void api.desktopShortcutStatus().then(status => { if (!cancelled) setBinding(status); }, () => { if (!cancelled) setBinding(undefined); });
    return () => { cancelled = true; };
  }, [revision]);
  return (
    <div className="card settings-fields">
      <p className="muted small">{t('Mini shows the most recent active run and can stop it.')}</p>
      {binding && <p className="muted small" role="status">{binding.state === 'active' ? t('Global shortcut · {shortcut}', { shortcut: binding.active })
        : binding.state === 'unavailable' ? t('The global shortcut is unavailable.') : t('No global shortcut is active.')}</p>}
      <button type="button" className="btn-ghost" disabled={!enabled}
        onClick={() => { setFailed(false); void api.showMini().catch(() => setFailed(true)); }}>{t('Show Mini')}</button>
      {failed && <p role="alert">{t('Could not show Mini.')}</p>}
    </div>
  );
}
