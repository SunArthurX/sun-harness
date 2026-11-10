import { useEffect, useState } from 'react';
import type { ComputerSettings, SessionSummary } from '@sun/core';
import { api } from '../api';
import { t } from '../i18n';

export function ComputerPanel({ onOpenSession }: { onOpenSession(id: string): void }) {
  const [settings, setSettings] = useState<ComputerSettings>();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [appId, setAppId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const refresh = async () => {
    const [snapshot, list] = await Promise.all([api.inspectComputerUse(), api.listSessions()]);
    setSettings(snapshot);
    setSessions(list.filter(session => !session.parent && !session.archived && !session.worktree?.closed));
  };
  useEffect(() => { void refresh().catch(() => setNotice(t('Computer Use could not be inspected.'))); }, []);
  useEffect(() => {
    const timer = setInterval(() => {
      void api.computerOwner().then(owner => setSettings(previous => previous && { ...previous, owner }), () => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  async function run(operation: () => Promise<void>, failure: string) {
    setBusy(true);
    setNotice('');
    try { await operation(); }
    catch { setNotice(failure); }
    finally { setBusy(false); }
  }

  const update = (id: string, granted: boolean) => {
    if (!settings) return;
    void run(async () => {
      await api.grantComputerUse(settings.revision, id, granted);
      await refresh();
    }, t('App access could not be changed. Refresh and try again.'));
  };
  const granted = settings?.grants.includes(appId);
  return <>
    <p className="small muted">{t('Allow a running app, then give one chat temporary control of its foreground window.')}</p>
    <div className="row">
      <button type="button" disabled={busy} onClick={() => { void run(refresh, t('Computer Use could not be inspected.')); }}>{t('Refresh')}</button>
      {settings && !settings.authorized && <button type="button" onClick={() => {
        void run(api.openComputerPermission, t('Accessibility settings could not be opened.'));
      }}>{t('Open Accessibility settings')}</button>}
    </div>
    {settings && !settings.authorized && <p>{t('Allow this Sun Harness build in macOS Accessibility, then refresh.')}</p>}
    {settings && <>
      <div className="card credential-fields">
        <label>{t('Running application')}
          <select aria-label={t('Running application')} value={appId} onChange={event => setAppId(event.target.value)}>
            <option value="">{t('Choose an application')}</option>
            {settings.apps.map(app => <option key={app.id} value={app.id}>{app.label} · {app.id}</option>)}
          </select>
        </label>
        {appId && !granted && <div><button type="button" disabled={busy} onClick={() => update(appId, true)}>{t('Allow selected app')}</button></div>}
        <label>{t('Control session')}
          <select aria-label={t('Control session')} value={sessionId} onChange={event => setSessionId(event.target.value)}>
            <option value="">{t('Choose a session')}</option>
            {sessions.map(session => <option key={session.id} value={session.id}>{session.title}</option>)}
          </select>
        </label>
        <p className="small muted">{t('Return to the assigned app after sending a prompt or approving a computer action.')}</p>
        <div><button type="button" className="btn-primary" disabled={busy || !settings.authorized || !granted || !sessionId || !!settings.owner}
          onClick={() => { void run(async () => {
            await api.beginComputerUse(sessionId, appId);
            onOpenSession(sessionId);
          }, t('Computer control could not start. Check the app grant and current owner.')); }}>{t('Start computer control')}</button></div>
      </div>
      {settings.owner && <div className="row">
        <p>{t('Computer control assigned to {app}.', { app: settings.owner.appId })}</p>
        <button type="button" onClick={() => {
          void run(async () => { await api.stopComputerUse(); await refresh(); }, t('Computer control could not be stopped.'));
        }}>{t('Take over computer control')}</button>
      </div>}
      <h3>{t('Allowed applications')}</h3>
      {settings.grants.map(id => <div className="row" key={id}>
        <span>{id}</span>
        <button type="button" disabled={busy} onClick={() => update(id, false)}>{t('Revoke app access')}</button>
      </div>)}
    </>}
    {notice && <p role="status">{notice}</p>}
  </>;
}
