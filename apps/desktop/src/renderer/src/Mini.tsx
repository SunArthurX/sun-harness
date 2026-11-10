import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MiniSnapshot } from '../../shared/mini';
import { api } from './api';
import { resolveLang, setLang, t } from './i18n';
import { watchAppearance } from './presentation';

export function Mini() {
  const [snapshot, setSnapshot] = useState<MiniSnapshot>();
  const [failure, setFailure] = useState<'load' | 'stop' | 'open'>();
  const [pending, setPending] = useState<string>();
  const loadTicket = useRef(0);
  const appearance = snapshot?.appearance;
  useLayoutEffect(() => appearance && watchAppearance(appearance), [appearance?.theme, appearance?.textScale, appearance?.reducedMotion]);

  async function load() {
    const ticket = ++loadTicket.current;
    try {
      const next = await api.getMiniSnapshot();
      if (ticket !== loadTicket.current) return;
      setLang(resolveLang(next.appearance.language));
      setSnapshot(next);
      setFailure(prior => prior === 'load' ? undefined : prior);
    } catch {
      if (ticket === loadTicket.current) setFailure('load');
    }
  }

  useEffect(() => {
    const unsubscribe = window.sun.onMiniUpdate?.(() => void load());
    const refresh = () => { void load(); };
    window.addEventListener('focus', refresh);
    refresh();
    return () => { loadTicket.current++; unsubscribe?.(); window.removeEventListener('focus', refresh); };
  }, []);

  const session = snapshot?.session;
  useEffect(() => setPending(undefined), [session?.id]);

  async function act(action: 'stop' | 'open') {
    if (!session || pending) return;
    setPending(session.id);
    setFailure(undefined);
    try {
      const applied = await (action === 'stop' ? api.stopMiniRun(session.id) : api.openMiniSession(session.id));
      if (!applied) setFailure(action);
      await load();
    } catch {
      setFailure(action);
    } finally {
      setPending(undefined);
    }
  }

  return (
    <main className="mini-panel">
      <h1>{t('Mini')}</h1>
      <p role="status">{failure === 'load' ? t('Could not load the active run.')
        : session ? t(session.status) : snapshot ? t('No active run') : t('Loading…')}</p>
      {session && (
        <>
          <p className="mini-session-title" title={session.title}>{session.title}</p>
          <div className="row">
            <button type="button" className="btn-primary" disabled={!!pending} onClick={() => void act('open')}>{t('Open chat')}</button>
            <button type="button" className="btn-ghost" disabled={!!pending} onClick={() => void act('stop')}>{t('Stop run')}</button>
          </div>
        </>
      )}
      {failure === 'stop' && <p role="alert">{t('Could not stop this run.')}</p>}
      {failure === 'open' && <p role="alert">{t('Could not open this chat.')}</p>}
    </main>
  );
}
