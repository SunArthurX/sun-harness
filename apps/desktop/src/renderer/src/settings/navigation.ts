import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n';
import { parseRoute, routeHash, type AppRoute } from './routes';

function entry(): number | undefined {
  const value = history.state?.sunRouteIndex;
  return Number.isSafeInteger(value) ? value : undefined;
}

function setEntry(index: number, route: AppRoute, push = false) {
  const state = { sunRouteIndex: index };
  if (push) history.pushState(state, '', routeHash(route));
  else history.replaceState(state, '', routeHash(route));
}

export function useNavigation(startPage: 'chat' | 'settings' = 'chat') {
  const [route, setRoute] = useState(() => parseRoute(location.hash || `#${startPage}`));
  const current = useRef(route);
  const index = useRef(entry() ?? 0);
  const restoring = useRef(false);
  const settingsActivity = useRef({ dirty: false, saving: false });

  const canLeave = useCallback((next: AppRoute) => {
    const previous = current.current;
    if (previous.page !== 'settings' || (next.page === 'settings' && next.section === previous.section)) return true;
    if (settingsActivity.current.saving) return false;
    return !settingsActivity.current.dirty || window.confirm(t('Discard unsaved settings changes? Choose Cancel to stay.'));
  }, []);

  const accept = useCallback((next: AppRoute) => {
    if (current.current.page === 'settings' && (next.page !== 'settings' || next.section !== current.current.section)) {
      settingsActivity.current = { dirty: false, saving: false };
    }
    current.current = next;
    setRoute(next);
  }, []);

  const navigate = useCallback((next: AppRoute) => {
    if (routeHash(current.current) === routeHash(next)) return true;
    if (!canLeave(next)) return false;
    setEntry(++index.current, next, true);
    accept(next);
    return true;
  }, [accept, canLeave]);

  useEffect(() => {
    setEntry(index.current, current.current);
    const onPop = () => {
      if (restoring.current) {
        restoring.current = false;
        return;
      }
      const next = parseRoute(location.hash);
      const nextIndex = entry();
      if (!canLeave(next)) {
        if (nextIndex !== undefined && nextIndex !== index.current) {
          restoring.current = true;
          history.go(index.current - nextIndex);
        } else setEntry(index.current, current.current);
        return;
      }
      index.current = nextIndex ?? index.current + 1;
      setEntry(index.current, next);
      accept(next);
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!settingsActivity.current.dirty) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [accept, canLeave]);

  const reportSettingsActivity = useCallback((dirty: boolean, saving: boolean) => {
    settingsActivity.current = { dirty, saving };
  }, []);

  return { route, navigate, reportSettingsActivity };
}
