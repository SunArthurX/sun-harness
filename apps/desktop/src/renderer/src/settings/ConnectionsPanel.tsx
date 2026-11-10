import { useEffect, useState } from 'react';
import type { CertificatePreview, DesktopConnections } from '../../../shared/connections';
import { api } from '../api';
import { t } from '../i18n';

function feedback(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/PIN_CHANGED|fingerprint changed|self.signed certificate|certificate has expired/i.test(message)) {
    return t('The gateway certificate does not match the trusted fingerprint.');
  }
  if (message.includes('GATEWAY_HOST_CHANGED')) return t('The gateway installation identity changed.');
  if (message.includes('SETTINGS_PROTOCOL_MISMATCH')) return t('The app and settings host use different protocol versions. Update both and reconnect.');
  if (/token|CREDENTIAL/.test(message)) return t('The gateway rejected the credential.');
  return t('Could not connect. Check the HTTPS endpoint and preview its certificate again.');
}

export function ConnectionsPanel({ reportActivity }: { reportActivity(dirty: boolean, saving: boolean): void }) {
  const [connections, setConnections] = useState<DesktopConnections>();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [token, setToken] = useState('');
  const [preview, setPreview] = useState<CertificatePreview>();
  const [trusted, setTrusted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    const update = () => void api.listDesktopConnections().then(setConnections, () => undefined);
    update();
    return window.sun.onLive(event => { if (event.kind === 'connection') update(); });
  }, []);

  async function act(action: () => Promise<unknown>, reload = false) {
    setBusy(true);
    reportActivity(false, true);
    setMessage('');
    try {
      await action();
      if (reload) window.location.reload();
      else setConnections(await api.listDesktopConnections());
    } catch (error) {
      setMessage(feedback(error));
    } finally {
      setBusy(false);
      reportActivity(false, false);
    }
  }

  return (
    <>
      <section className="card settings-fields">
        <h3>{t('Execution host')}</h3>
        <p className="small">{connections?.selected ?? t('This computer')}</p>
        {connections?.status?.label && <p className="muted small">{connections.status.label}</p>}
        {connections?.status?.hostId && <code className="small">{connections.status.hostId}</code>}
        {connections?.selected && <button type="button" className="btn-ghost" disabled={busy}
          onClick={() => void act(() => api.selectDesktopConnection(null), true)}>{t('Use this computer')}</button>}
        {connections?.profiles.map(profile => (
          <div className="item" key={profile.name}>
            <strong>{profile.name}</strong>
            <p className="muted small">{profile.url}</p>
            <div className="row">
              <button type="button" className="btn-ghost" disabled={busy || connections.selected === profile.name && connections.status?.state === 'ready'}
                onClick={() => void act(() => api.selectDesktopConnection(profile.name), true)}>{t('Connect to {name}', { name: profile.name })}</button>
              <button type="button" className="btn-ghost" disabled={busy || connections.selected === profile.name}
                onClick={() => void act(() => api.removeDesktopConnection(profile.name))}>{t('Forget connection')}</button>
            </div>
          </div>
        ))}
      </section>
      <section className="card settings-fields">
        <h3>{t('Connect to a gateway')}</h3>
        <label>{t('HTTPS gateway address')}
          <input type="url" value={url} disabled={busy} onChange={event => { setUrl(event.target.value); setPreview(undefined); setTrusted(false); setToken(''); }} />
        </label>
        <button type="button" className="btn-ghost" disabled={!url.trim() || busy}
          onClick={() => void act(async () => {
            setPreview(undefined);
            setTrusted(false);
            setToken('');
            setPreview(await api.previewDesktopConnection(url.trim()));
          })}>{t('Preview certificate')}</button>
        {preview && <>
          <p className="muted small">{t('Compare this fingerprint with the one shown on the execution host.')}</p>
          <code className="connection-fingerprint">{preview.fingerprint}</code>
          <label><input type="checkbox" checked={trusted} disabled={busy} onChange={event => setTrusted(event.target.checked)} /> {t('I verified this fingerprint')}</label>
          <label>{t('Connection name')}<input value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
          <label>{t('Device token')}<input type="password" autoComplete="off" value={token} disabled={!trusted || busy} onChange={event => setToken(event.target.value)} /></label>
          <button type="button" className="btn-primary" disabled={!trusted || !token.trim() || !name.trim() || busy}
            onClick={() => {
              const input = { id: preview.id, fingerprint: preview.fingerprint, name: name.trim(), token: token.trim() };
              setToken('');
              void act(() => api.confirmDesktopConnection(input), true);
            }}>{t('Trust and connect')}</button>
        </>}
      </section>
      {message && <p role="status">{message}</p>}
    </>
  );
}
