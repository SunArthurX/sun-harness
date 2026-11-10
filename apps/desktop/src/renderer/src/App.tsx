import { getLang, locale, onLangChange, resolveLang, setLang, t, tk } from './i18n';
import type { GatewayStatus, LiveEvent, PendingApproval, SessionSummary, SettingsSnapshot } from '@sun/core';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { AppshotDispatch } from './api';
import { api, migrateReadAloud } from './api';
import { defaultUiPreferences } from '@sun/core/settings-preferences';
import { NotificationTracker } from './notifications';
import { matchesShortcut, watchAppearance } from './presentation';
import { settingsFeedback, settingsLoadError } from './settings-feedback';
import { Chat } from './Chat';
import { AutomationsPage, EvolutionPage, IntelPage, KnowledgePage, ExtensionsPage } from './pages';
import { SettingsPage } from './settings/SettingsPage';
import { useNavigation } from './settings/navigation';
import { GENERAL_SECTION } from './settings/sections';
import type { Page } from './settings/routes';

export type { Page } from './settings/routes';

const NAV: { id: Page; label: string; glyph: string }[] = [
  { id: 'chat', label: tk("Sessions"), glyph: '◐' },
  { id: 'automations', label: tk("Automations"), glyph: '⏲' },
  { id: 'knowledge', label: tk("Knowledge"), glyph: '❖' },
  { id: 'extensions', label: tk("Skills · MCP · Plugins"), glyph: '⌬' },
  { id: 'evolution', label: tk("Evolution"), glyph: '↺' },
  { id: 'intel', label: tk("Harness Intel"), glyph: '☄' },
  { id: 'settings', label: tk("Settings"), glyph: '⚙' },
];

export const MODE_META: Record<string, { label: string; blurb: string; glyph: string }> = {
  coding: { label: tk("Coding"), blurb: tk("Read, edit, run and verify code in a repository."), glyph: '⟨/⟩' },
  plan: { label: tk("Plan"), blurb: tk("Explore read-only, propose a plan, then code it once you approve."), glyph: '◇' },
  agent: { label: tk("Agent"), blurb: tk("Plan, research the web, and deliver files — Manus-style."), glyph: '✦' },
  assistant: { label: tk("Assistant"), blurb: tk("A companion with memory, notes and reminders."), glyph: '☼' },
};

/** The translated label of a session mode. */
export const modeLabel = (mode: string) => t(MODE_META[mode]?.label ?? mode);

/** Modes that work inside a project folder (and may use a worktree). */
const isRepoMode = (mode: string) => mode === 'coding' || mode === 'plan';

function groupSessions(sessions: SessionSummary[], showArchived: boolean) {
  const top = sessions.filter((s) => !s.parent && !s.archived);
  const archived = sessions.filter((s) => !s.parent && s.archived);
  const children = new Map<string, SessionSummary[]>();
  for (const s of sessions) if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
  const today = new Date().toISOString().slice(0, 10);
  return {
    children,
    groups: [
      { label: t("Pinned"), items: top.filter((s) => s.pinned) },
      { label: t("Today"), items: top.filter((s) => !s.pinned && s.updatedAt.slice(0, 10) === today) },
      { label: t("Earlier"), items: top.filter((s) => !s.pinned && s.updatedAt.slice(0, 10) !== today) },
      { label: t('Archived ({n})', { n: archived.length }), items: showArchived ? archived : [], archived: true, count: archived.length },
    ].filter((g) => g.items.length || ('count' in g && g.count)),
  };
}

export function StatusDot({ s }: { s: Pick<SessionSummary, 'status' | 'statusReason'> }) {
  return <span className={`dot dot-${s.status}`} title={s.statusReason ? `${t(s.status)}: ${t(s.statusReason)}` : t(s.status)} />;
}

const fallbackUi = defaultUiPreferences();

export function App({ initialSettings }: { initialSettings?: SettingsSnapshot }) {
  const [settings, setSettings] = useState(initialSettings);
  const settingsRef = useRef(initialSettings);
  const settingsRefresh = useRef(0);
  const ui = settings?.values.ui ?? fallbackUi;
  const defaultMode = settings?.values.defaultMode ?? 'coding';
  const { route, navigate, reportSettingsActivity } = useNavigation(ui.startPage);
  const applySettings = useCallback((snapshot: SettingsSnapshot) => {
    settingsRef.current = snapshot;
    setSettings(snapshot);
    setLang(resolveLang(snapshot.values.ui.language));
  }, []);
  useLayoutEffect(() => watchAppearance(ui), [ui.theme, ui.textScale, ui.reducedMotion]);
  const page = route.page;
  const setPage = useCallback((next: Page) => navigate(next === 'settings'
    ? { page: 'settings', section: GENERAL_SECTION } : { page: next }), [navigate]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [shortcutAppshot, setShortcutAppshot] = useState<AppshotDispatch>();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [newMode, setNewMode] = useState<string | null>(null);
  const [hostMode, setHostMode] = useState<{ mode: string; gateway?: string }>();
  const [connection, setConnection] = useState<GatewayStatus>();
  const [hostRefresh, setHostRefresh] = useState(0);
  const stale = !!connection && connection.state !== 'ready';

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ id: string; title: string; mode: string; snippet: string }[]>([]);
  const [palette, setPalette] = useState(false);
  const notifications = useRef(new NotificationTracker());
  const [lang, setLangState] = useState(getLang());
  const [langError, setLangError] = useState('');
  const [langSaving, setLangSaving] = useState(false);
  const saveUserSetting = async (key: 'ui.language' | 'ui.readAloud', value: string | boolean) => {
    setLangSaving(true);
    setLangError('');
    try {
      const { revision, userRevision } = await api.getSettings();
      const result = await api.updateSettings({ expectedRevision: userRevision ?? revision, scope: 'user', changes: { [key]: value } });
      if (result.ok) applySettings(result.snapshot);
      if (!result.ok || result.audit === 'incomplete' || result.durability === 'uncertain') setLangError(settingsFeedback(result));
    } catch (error) {
      setLangError(settingsLoadError(error));
    } finally {
      setLangSaving(false);
    }
  };
  useEffect(() => onLangChange(setLangState), []);
  const receiveSessions = useCallback((list: SessionSummary[]) => {
    notifications.current.seed(list);
    setSessions(list);
  }, []);
  const refresh = useCallback(async () => receiveSessions(await api.listSessions()), [receiveSessions]);

  const notify = useCallback((e: Extract<LiveEvent, { kind: 'event' }>) => {
    if (e.event.type !== 'run/status') return;
    const tracker = notifications.current;
    const kind = tracker.accept(e.sessionId, e.event.seq, e.event.status, (settingsRef.current?.values.ui ?? fallbackUi).notifications, new Date());
    const session = tracker.session(e.sessionId);
    if (!kind || !session || document.hasFocus() || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const what = kind === 'approval' ? t('needs your approval') : kind === 'completion' ? t('finished')
      : kind === 'pause' ? t('paused ({reason})', { reason: t(e.event.reason ?? '') }) : t('failed');
    const alert = new Notification(`sun-harness · ${what}`, { body: session.title, silent: kind === 'completion', tag: `sun-${e.sessionId}-${e.event.seq}` });
    alert.onclick = () => {
      window.focus();
      if (!setPage('chat')) return;
      setNewMode(null);
      setCurrent(e.sessionId);
    };
  }, [setPage]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    void api.pendingApprovals().then(setApprovals, () => undefined);
    let sawConnection = false;
    const unsubscribe = window.sun.onLive(e => {
      if (e.kind === 'sessions') receiveSessions(e.sessions);
      else if (e.kind === 'approvals') setApprovals(e.approvals);
      else if (e.kind === 'event') notify(e);
      else if (e.kind === 'connection') {
        sawConnection = true;
        setConnection(e.status);
        const ticket = ++settingsRefresh.current;
        if (e.status.state === 'ready') {
          setHostRefresh(n => n + 1);
          void api.getSettings().then(migrateReadAloud).then(snapshot => {
            if (ticket === settingsRefresh.current) applySettings(snapshot);
          }, () => undefined);
        }
      } else if (e.kind === 'settings' && e.revision !== (e.scope === 'user' ? settingsRef.current?.userRevision : settingsRef.current?.revision)) {
        const ticket = ++settingsRefresh.current;
        void api.getSettings().then(snapshot => {
          if (ticket === settingsRefresh.current) applySettings(snapshot);
        }, () => undefined);
      }
    });
    void api.appInfo().then(info => {
      setHostMode(info);
      if (!sawConnection) setConnection(info.connection);
    }, () => undefined);
    return unsubscribe;
  }, [applySettings, notify, receiveSessions, refresh]);

  useEffect(() => {
    if (!window.sun.onMiniOpen) return;
    const open = () => {
      void api.takeMiniSession().then(id => {
        if (!id || !setPage('chat')) return;
        setPalette(false);
        setNewMode(null);
        setCurrent(id);
      }, () => undefined);
    };
    const unsubscribe = window.sun.onMiniOpen(open);
    open();
    return unsubscribe;
  }, [setPage]);

  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.searchSessions(query).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const platform = /^Mac/i.test(navigator.platform) ? 'mac' : 'other';
      if (matchesShortcut(e, ui.shortcuts.palette, platform)) {
        e.preventDefault();
        setPalette(v => !v);
      } else if (matchesShortcut(e, ui.shortcuts.newChat, platform)) {
        e.preventDefault();
        if (!stale && setPage('chat')) setNewMode(defaultMode);
      } else if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [defaultMode, setPage, stale, ui.shortcuts]);

  const [showArchived, setShowArchived] = useState(false);
  const { groups, children } = useMemo(() => groupSessions(sessions, showArchived), [sessions, showArchived, lang]);
  const currentSummary = sessions.find((s) => s.id === current);
  useEffect(() => {
    if (page === 'chat' && currentSummary && window.sun.onAppshot) {
      void api.trackAppshotSession(currentSummary.id).catch(() => undefined);
    }
  }, [page, currentSummary?.id, hostRefresh]);

  useEffect(() => window.sun.onAppshot?.(event => {
    if (!setPage('chat')) {
      if ('preview' in event) void api.cancelAppshot(event.sessionId, event.preview.id).catch(() => undefined);
      return;
    }
    setNewMode(null);
    setCurrent(event.sessionId);
    setShortcutAppshot(event);
  }), [setPage]);

  const clearShortcutAppshot = useCallback(() => setShortcutAppshot(undefined), []);
  const attention = sessions.filter((s) => s.status === 'paused' || s.status === 'awaiting_approval').length + approvals.length;

  const startSession = async (mode: string, cwd?: string, worktree?: boolean, worktreeBase?: string) => {
    const s = await api.createSession({ mode, cwd, worktree, worktreeBase });
    setNewMode(null);
    setCurrent(s.id);
    setPage('chat');
    refresh();
  };

  return (
    <div className="shell">
      <nav className="rail">
        <div className="sun-mark" title={t("sun-harness")}>
          <span />
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${page === n.id ? 'on' : ''}`} data-nav={n.id} onClick={() => setPage(n.id)} title={t(n.label)}>
            <span className="glyph">{n.glyph}</span>
            {n.id === 'chat' && attention > 0 && <span className="badge">{attention}</span>}
          </button>
        ))}
        <button
          className="rail-btn rail-lang"
          title={t('Language')}
          disabled={langSaving || stale && !settings?.userRevision}
          onClick={() => void saveUserSetting('ui.language', lang === 'zh-CN' ? 'en' : 'zh-CN')}
        >
          <span className="glyph">{lang === 'zh-CN' ? '中' : 'EN'}</span>
        </button>
        {langError && <span className="rail-settings-status" role="status">{langError}</span>}
      </nav>

      {page === 'chat' && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <h1>
              sun<em>harness</em>
            </h1>
            <button className="btn-new" disabled={stale} onClick={() => setNewMode(defaultMode)}>
              {t("+ New")}
            </button>
          </div>
          <input className="session-search" placeholder={t("Search sessions…  (⌘K for everything)")} value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="session-list">
            {query.trim().length >= 2 && (
              <div>
                <div className="group-label">{t("Matches")}</div>
                {hits.map((h) => (
                  <button key={h.id} className={`session ${current === h.id ? 'on' : ''}`} onClick={() => (setCurrent(h.id), setNewMode(null))}>
                    <span className="session-title">
                      {h.title}
                      <span className="muted small hit-snippet">{h.snippet}</span>
                    </span>
                    <span className={`mode-tag m-${h.mode}`}>{modeLabel(h.mode)}</span>
                  </button>
                ))}
                {!hits.length && <p className="muted pad small">{t("No matches.")}</p>}
              </div>
            )}
            {query.trim().length < 2 && groups.map((g) => (
              <div key={g.label}>
                <div className="group-label">
                  {'archived' in g ? (
                    <button className="linklike" onClick={() => setShowArchived(!showArchived)}>
                      {showArchived ? '▾' : '▸'} {g.label}
                    </button>
                  ) : (
                    g.label
                  )}
                </div>
                {g.items.map((s) => (
                  <div key={s.id}>
                    <div className={`session-row ${current === s.id ? 'on' : ''}`}>
                      <button className={`session ${current === s.id ? 'on' : ''}`} onClick={() => (setCurrent(s.id), setNewMode(null))}>
                        <StatusDot s={s} />
                        <span className="session-title">{s.title}</span>
                        {s.contextTokens && s.contextWindow ? (
                          <span className={`ctx-mini ${s.contextTokens / s.contextWindow > 0.8 ? 'hot' : ''}`} title={t('context: {used} of {window} tokens at the last request', { used: s.contextTokens.toLocaleString(locale()), window: s.contextWindow.toLocaleString(locale()) })}>
                            {Math.round((s.contextTokens / s.contextWindow) * 100)}%
                          </span>
                        ) : null}
                        {s.worktree && !s.worktree.closed && <span className="mode-tag wt" title={s.worktree.branch}>⑂</span>}
                        <span className={`mode-tag m-${s.mode}`}>{modeLabel(s.mode)}</span>
                      </button>
                      <span className="session-actions">
                        <button disabled={stale} title={s.pinned ? t("Unpin") : t("Pin to the top")} onClick={() => void api.setSessionFlags(s.id, { pinned: !s.pinned })}>
                          {s.pinned ? '◉' : '○'}
                        </button>
                        <button disabled={stale} title={s.archived ? t("Unarchive") : t("Archive")} onClick={() => void api.setSessionFlags(s.id, { archived: !s.archived })}>
                          {s.archived ? '↥' : '↧'}
                        </button>
                      </span>
                    </div>
                    {(children.get(s.id) ?? []).map((c) => (
                      <button key={c.id} className={`session child ${current === c.id ? 'on' : ''}`} onClick={() => setCurrent(c.id)}>
                        <StatusDot s={c} />
                        <span className="session-title">{c.title.replace(/^\[sub\]\s*/, '↳ ')}</span>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
            {!sessions.length && <p className="muted pad">{t("No sessions yet.")}</p>}
          </div>
          {hostMode && hostMode.mode !== 'local' && (
            <div className="host-mode" title={hostMode.gateway ?? location.origin}>
              <span className="dot dot-idle" /> {connection?.label ?? (hostMode.mode === 'web' ? t("web · gateway") : t("via gateway"))}
            </div>
          )}
        </aside>
      )}

      {palette && (
        <Palette
          sessions={sessions}
          onClose={() => setPalette(false)}
          onPage={(p) => (setPage(p), setPalette(false))}
          onSession={(id) => (setPage('chat'), setNewMode(null), setCurrent(id), setPalette(false))}
          onNew={(mode) => (setPage('chat'), setNewMode(mode), setPalette(false))}
          onImport={() => { if (navigate({ page: 'settings', section: 'data-controls' })) setPalette(false); }}
        />
      )}
      <main className="main" key={page === 'settings' ? 'settings' : lang}>
        {connection && (stale || hostMode?.mode === 'remote') && (
          <div className="connection-banner" role="status" data-connection={connection.state}>
            {connection.state === 'ready' ? t('Execution host · {host}', { host: connection.label ?? connection.url ?? '' })
              : connection.state === 'unauthorized' ? t('Gateway access expired or was revoked. Reconnect to continue.')
              : connection.state === 'identity-changed' ? t('The gateway installation identity changed.')
              : t('Gateway connection interrupted. Host actions are paused until the connection refreshes.')}
          </div>
        )}
        {page !== 'settings' && <fieldset className="connection-fieldset connection-workspace" disabled={stale}>
        {page === 'chat' &&
          (current && currentSummary && newMode === null ? (
            <Chat key={current} summary={currentSummary} approvals={approvals} refresh={hostRefresh} voiceEnabled={settings?.values.voice.enabled !== false} readAloud={ui.readAloud}
              shortcutAppshot={shortcutAppshot?.sessionId === current ? shortcutAppshot : undefined}
              onShortcutAppshot={clearShortcutAppshot}
              appshotCapability={settings?.capabilities.find(item => item.id === 'native.appshots')}
              computerAvailable={settings?.capabilities.some(item => item.id === 'native.computer-use' && item.state === 'available')}
              reviewSeverity={settings?.values.review?.minimumSeverity ?? 'low'}
              onReadAloud={enabled => void saveUserSetting('ui.readAloud', enabled)} onOpen={setCurrent} onManageStorage={() => navigate({ page: 'settings', section: 'storage' })} />
          ) : (
            <Welcome key={newMode ?? defaultMode} initialMode={newMode ?? defaultMode} onStart={startSession} remote={hostMode?.mode === 'remote'} />
          ))}
        {page === 'knowledge' && <KnowledgePage onMemory={() => navigate({ page: 'settings', section: 'memory' })} />}
        {page === 'extensions' && <ExtensionsPage cwd={currentSummary?.cwd} />}
        {page === 'evolution' && <EvolutionPage currentSession={current} />}
        {page === 'intel' && <IntelPage />}
        {page === 'automations' && <AutomationsPage onOpenSession={(id) => (setPage('chat'), setNewMode(null), setCurrent(id))} />}
        </fieldset>}
        {route.page === 'settings' && <SettingsPage route={route} onRoute={navigate} reportActivity={reportSettingsActivity} onSettings={applySettings} workspace={currentSummary?.cwd} stale={stale} refresh={hostRefresh}
          onOpenSession={id => {
            if (setPage('chat')) {
              setNewMode(null);
              setCurrent(id);
              void refresh().catch(() => undefined);
            }
          }} />}
      </main>
    </div>
  );
}

function Welcome({ initialMode, onStart, remote }: { initialMode: string; onStart: (mode: string, cwd?: string, worktree?: boolean, worktreeBase?: string) => void | Promise<void>; remote?: boolean }) {
  const [mode, setMode] = useState(initialMode);
  const [cwd, setCwd] = useState<string | undefined>();
  const [worktree, setWorktree] = useState(false);
  const [worktreeBase, setWorktreeBase] = useState('');
  const [error, setError] = useState('');
  const hour = new Date().getHours();
  const greet = hour < 5 ? t('Late night') : hour < 12 ? t('Good morning') : hour < 18 ? t('Good afternoon') : t('Good evening');
  return (
    <div className="welcome">
      <div className="horizon" />
      <p className="eyebrow">{greet}</p>
      <h2 className="hero">
        {t("What shall we")} <em>{t("build")}</em> {t("today?")}
      </h2>
      <div className="mode-cards">
        {Object.entries(MODE_META).map(([id, m], i) => (
          <button key={id} className={`mode-card ${mode === id ? 'on' : ''}`} style={{ animationDelay: `${i * 70}ms` }} onClick={() => setMode(id)}>
            <span className="mode-glyph">{m.glyph}</span>
            <strong>{t(m.label)}</strong>
            <span>{t(m.blurb)}</span>
          </button>
        ))}
      </div>
      <div className="welcome-actions">
        {remote ? <label>{t('Workspace on the execution host')} <input value={cwd ?? ''} onChange={event => setCwd(event.target.value || undefined)} /></label>
        : <button className="chip" onClick={async () => setCwd((await api.pickFolder()) ?? cwd)}>
          {cwd ? `📁 ${cwd}` : isRepoMode(mode) ? t("Choose a project folder…") : t("Workspace: ~/.sun/workspace (change…)")}
        </button>}
        {isRepoMode(mode) && (
          <label className="chip toggle" title={t("Work on a new branch in a separate checkout; merge or discard when done.")}>
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> {t("Isolated git worktree")}
          </label>
        )}
        {isRepoMode(mode) && worktree && <label>{t('Worktree base')} <input value={worktreeBase} placeholder={t('Current Git HEAD')}
          onChange={event => setWorktreeBase(event.target.value)} /></label>}
        <button
          className="btn-primary"
          onClick={async () => {
            setError('');
            try {
              await onStart(mode, cwd, isRepoMode(mode) && worktree, worktreeBase.trim() || undefined);
            } catch (e) {
              setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
            }
          }}
          disabled={isRepoMode(mode) && !cwd}
        >
          {t('Start {mode} session →', { mode: modeLabel(mode) })}
        </button>
      </div>
      {error && <p className="welcome-error">{error}</p>}
    </div>
  );
}

type PaletteItem = { label: string; hint?: string; run: () => void };

/** ⌘K: jump to any session or screen, start a session, import a transcript. */
function Palette({
  sessions,
  onClose,
  onPage,
  onSession,
  onNew,
  onImport,
}: {
  sessions: SessionSummary[];
  onClose: () => void;
  onPage: (p: Page) => void;
  onSession: (id: string) => void;
  onNew: (mode: string) => void;
  onImport: () => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const items: PaletteItem[] = [
    ...Object.entries(MODE_META).map(([id, m]) => ({ label: t('New {mode} session', { mode: t(m.label) }), hint: t(m.blurb), run: () => onNew(id) })),
    ...NAV.map((n) => ({ label: t('Go to {page}', { page: t(n.label) }), run: () => onPage(n.id) })),
    { label: t('Import session'), run: onImport },
    { label: t("Run daily briefing now"), run: () => void api.runBriefing().then((r) => onSession(r.sessionId)) },
    ...sessions.filter((s) => !s.parent).slice(0, 200).map((s) => ({ label: s.title, hint: `${modeLabel(s.mode)} · ${s.updatedAt.slice(0, 10)}`, run: () => onSession(s.id) })),
  ];
  const ql = q.toLowerCase();
  const shown = items.filter((i) => !ql || i.label.toLowerCase().includes(ql) || i.hint?.toLowerCase().includes(ql)).slice(0, 14);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder={t("Type a command or a session name…")}
          value={q}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') (e.preventDefault(), setSel((v) => Math.min(v + 1, shown.length - 1)));
            else if (e.key === 'ArrowUp') (e.preventDefault(), setSel((v) => Math.max(v - 1, 0)));
            else if (e.key === 'Enter' && shown[sel]) shown[sel].run();
          }}
        />
        <div className="palette-list">
          {shown.map((i, k) => (
            <button key={`${i.label}-${k}`} className={k === sel ? 'on' : ''} onMouseEnter={() => setSel(k)} onClick={i.run}>
              <span>{i.label}</span>
              {i.hint && <span className="muted small">{i.hint}</span>}
            </button>
          ))}
        </div>

      </div>
    </div>
  );
}
