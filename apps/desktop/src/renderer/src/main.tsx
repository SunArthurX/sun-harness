import './web-bridge';
import '@fontsource/instrument-serif/400.css';
import '@fontsource-variable/hanken-grotesk';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { createRoot } from 'react-dom/client';
import { Mini } from './Mini';
import { PrivateSignIn } from './PrivateSignIn';
import { App } from './App';
import { api, migrateReadAloud } from './api';
import { resolveLang, setLang, t } from './i18n';

async function start() {
  const root = createRoot(document.getElementById('root')!);
  if (location.hash === '#private-sign-in' && window.sun.onMiniUpdate) {
    const status = await api.privateSignInStatus().catch(() => undefined);
    if (status) {
      setLang(resolveLang(status.language));
      root.render(<PrivateSignIn status={status} />);
    }
    return;
  }
  if (location.hash === '#mini' && window.sun.onMiniUpdate) {
    root.render(<Mini />);
    return;
  }
  const info = await api.appInfo().catch(() => undefined);
  if (info?.settingsRecovery) {
    setLang(resolveLang('system'));
    root.render(
      <main className="page">
        <h1>{t('Configuration recovery')}</h1>
        <p role="alert">{info.settingsRecovery === 'NEWER_CONFIG'
          ? t('This configuration requires a newer version of sun-harness.')
          : t('The configuration is invalid. Correct it and reopen sun-harness.')}</p>
        <code>{info.home}/config.json</code>
      </main>,
    );
    return;
  }
  const snapshot = await api.getSettings().then(migrateReadAloud, () => undefined);
  setLang(resolveLang(snapshot?.values.ui.language));
  root.render(<App initialSettings={snapshot} />);
}

void start();
