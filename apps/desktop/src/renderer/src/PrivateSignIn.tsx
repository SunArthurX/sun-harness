import { useState } from 'react';
import type { PrivateSignInStatus } from '../../shared/credentials';
import { api } from './api';
import { t } from './i18n';

export function PrivateSignIn({ status }: { status: PrivateSignInStatus }) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const fill = async () => {
    setBusy(true);
    try {
      const result = await api.fillPrivateSignIn();
      setNotice(result === 'filled' ? t('Password filled. Submit the form on the website.')
        : t('No eligible password field. Open the password step or sign in manually.'));
    } catch { setNotice(t('The saved password is unavailable. Close this window or sign in manually.')); }
    finally { setBusy(false); }
  };

  return <main className="private-sign-in-controls">
    <strong>{t('Private sign-in')} · {status.label} · {status.origin}</strong>
    <p className="muted small">{t('This window stays outside agent and gateway views. Closing it clears this browser session.')}</p>
    <div className="row">
      <button className="btn-primary" type="button" disabled={busy} onClick={() => { void fill(); }}>{t('Fill saved password')}</button>
      <button type="button" onClick={() => { void api.closePrivateSignIn(); }}>{t('Close')}</button>
    </div>
    {notice && <p role="status">{notice}</p>}
  </main>;
}
