import { useEffect, useState } from 'react';
import type { BrowserAction, BrowserDecision, BrowserPermissionsSnapshot } from '@sun/core';
import { api } from '../api';
import { t, tk } from '../i18n';

const actions = { browse: tk('Browse'), upload: tk('Upload'), download: tk('Download') } as const;
const decisions = { allow: tk('Allow'), deny: tk('Deny'), ask: tk('Ask') } as const;

export function BrowserPermissionsPanel() {
  const [snapshot, setSnapshot] = useState<BrowserPermissionsSnapshot>();
  const [info, setInfo] = useState<Awaited<ReturnType<typeof api.browserInfo>>>();
  const [origin, setOrigin] = useState('');
  const [action, setAction] = useState<BrowserAction>('browse');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      api.browserPermissions().then(next => {
        if (active && current === request) setSnapshot(next);
      }).catch(() => {
        if (active && current === request) setNotice(t('Browser permissions could not be loaded.'));
      });
      api.browserInfo().then(next => { if (active && current === request) setInfo(next); }).catch(() => undefined);
    };
    const unsubscribe = window.sun.onLive(event => {
      if (event.kind === 'browser-permissions') refresh();
    });
    refresh();
    return () => { active = false; unsubscribe(); };
  }, []);

  const save = async (site: string, operation: BrowserAction, decision: BrowserDecision) => {
    if (!snapshot || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const result = await api.updateBrowserPermission({ expectedRevision: snapshot.revision, origin: site.trim(), action: operation, decision });
      if (result.ok) {
        setSnapshot(result.snapshot);
        setNotice(result.audit === 'recorded' ? t('Saved') : t('Saved. The audit entry could not be recorded.'));
      } else if (result.code === 'CONFLICT') {
        setSnapshot(await api.browserPermissions());
        setNotice(t('Browser permissions changed. Review the current rules before trying again.'));
      } else {
        setNotice(result.code === 'INVALID' ? t('Enter an HTTP or HTTPS origin without credentials.') : t('Browser permissions could not be saved.'));
      }
    } catch {
      setNotice(t('Browser permissions could not be saved.'));
    } finally {
      setBusy(false);
    }
  };

  return <>
    <p className="muted small">{t('Browse, upload, and download are reviewed separately for each origin. New origins require review.')}</p>
    <section>
      <h3>{t('Browser profile')}</h3>
      {info && <>
        <p>{info.profile.owner === 'external' ? t('Externally managed browser') : t('Profile managed by Sun Harness')} · {info.profile.mode}
          {info.profile.owner === 'managed' && <> · <code>{info.profile.name}</code></>}</p>
        {info.profile.location && <p className="mono small">{info.profile.location}</p>}
        <p className="muted small">{info.profile.active ? t('Browser is connected') : t('No active browser connection')}</p>
        {!info.available && <p className="muted small">{info.profile.downloadPolicyDelegated === false
          ? t('Using an external browser requires explicitly delegating its download policy.')
          : t('No browser backend is available on this host.')}</p>}
      </>}
    </section>
    <section>
      <h3>{t('Pending browser requests')}</h3>
      {snapshot?.requests.length === 0 && <p className="muted small">{t('No browser requests are awaiting review.')}</p>}
      {snapshot?.requests.map(request => <div className="row" key={JSON.stringify([request.origin, request.action, request.sessionId])}>
        <code>{request.origin}</code>
        <span>{t(actions[request.action])}</span>
        <span className="muted small">{request.sessionId}</span>
        <button disabled={busy} onClick={() => save(request.origin, request.action, 'allow')}>{t('Allow')}</button>
        <button disabled={busy} onClick={() => save(request.origin, request.action, 'deny')}>{t('Deny')}</button>
      </div>)}
    </section>
    <section>
      <h3>{t('Browser origin rules')}</h3>
      {snapshot?.rules.length === 0 && <p className="muted small">{t('No browser origin rules are configured.')}</p>}
      {snapshot?.rules.map(rule => <div className="row" key={JSON.stringify([rule.origin, rule.action])}>
        <code>{rule.origin}</code>
        <span>{t(actions[rule.action])}</span>
        <span>{t(decisions[rule.decision])}</span>
        <button disabled={busy} onClick={() => save(rule.origin, rule.action, 'ask')}>{t('Reset to Ask')}</button>
      </div>)}
      <div className="row">
        <label>{t('Website origin')} <input value={origin} onChange={event => setOrigin(event.target.value)} /></label>
        <label>{t('Browser action')} <select value={action} onChange={event => setAction(event.target.value as BrowserAction)}>
          {Object.entries(actions).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
        </select></label>
        <button disabled={busy || !snapshot || !origin.trim()} onClick={() => save(origin, action, 'allow')}>{t('Allow')}</button>
        <button disabled={busy || !snapshot || !origin.trim()} onClick={() => save(origin, action, 'deny')}>{t('Deny')}</button>
      </div>
    </section>
    {notice && <p role="status">{notice}</p>}
  </>;
}
