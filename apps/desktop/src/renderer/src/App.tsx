import type { PendingApproval, SessionSummary } from '@sun/core';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { Chat } from './Chat';
import { EvolutionPage, IntelPage, KnowledgePage, ExtensionsPage, SettingsPage } from './pages';

export type Page = 'chat' | 'knowledge' | 'extensions' | 'evolution' | 'intel' | 'settings';

const NAV: { id: Page; label: string; glyph: string }[] = [
  { id: 'chat', label: 'Sessions', glyph: '◐' },
  { id: 'knowledge', label: 'Knowledge', glyph: '❖' },
  { id: 'extensions', label: 'Skills · MCP · Plugins', glyph: '⌬' },
  { id: 'evolution', label: 'Evolution', glyph: '↺' },
  { id: 'intel', label: 'Harness Intel', glyph: '☄' },
  { id: 'settings', label: 'Settings', glyph: '⚙' },
];

export const MODE_META: Record<string, { label: string; blurb: string; glyph: string }> = {
  coding: { label: 'Coding', blurb: 'Read, edit, run and verify code in a repository.', glyph: '⟨/⟩' },
  plan: { label: 'Plan', blurb: 'Explore read-only, propose a plan, then code it once you approve.', glyph: '◇' },
  agent: { label: 'Agent', blurb: 'Plan, research the web, and deliver files — Manus-style.', glyph: '✦' },
  assistant: { label: 'Assistant', blurb: 'A companion with memory, notes and reminders.', glyph: '☼' },
};

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
      { label: 'Pinned', items: top.filter((s) => s.pinned) },
      { label: 'Today', items: top.filter((s) => !s.pinned && s.updatedAt.slice(0, 10) === today) },
      { label: 'Earlier', items: top.filter((s) => !s.pinned && s.updatedAt.slice(0, 10) !== today) },
      { label: `Archived (${archived.length})`, items: showArchived ? archived : [], archived: true, count: archived.length },
    ].filter((g) => g.items.length || ('count' in g && g.count)),
  };
}

export function StatusDot({ s }: { s: Pick<SessionSummary, 'status' | 'statusReason'> }) {
  return <span className={`dot dot-${s.status}`} title={s.statusReason ? `${s.status}: ${s.statusReason}` : s.status} />;
}

export function App() {
  const [page, setPage] = useState<Page>('chat');
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [newMode, setNewMode] = useState<string | null>(null);
  const [hostMode, setHostMode] = useState<{ mode: string; gateway?: string }>();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<{ id: string; title: string; mode: string; snippet: string }[]>([]);
  const [palette, setPalette] = useState(false);
  const statuses = useRef(new Map<string, string>());
  const refresh = useCallback(async () => setSessions(await api.listSessions()), []);

  /** OS notification when a session finishes, pauses, fails, or needs approval while the window is in the background. */
  const notify = useCallback((list: SessionSummary[]) => {
    for (const s of list) {
      const prev = statuses.current.get(s.id);
      statuses.current.set(s.id, s.status);
      if (!prev || prev === s.status || document.hasFocus() || s.parent) continue;
      const what = s.status === 'awaiting_approval' ? 'needs your approval' : s.status === 'idle' && prev === 'running' ? 'finished' : s.status === 'paused' ? `paused (${s.statusReason ?? ''})` : s.status === 'error' ? 'failed' : '';
      if (!what || typeof Notification === 'undefined' || Notification.permission !== 'granted') continue;
      const n = new Notification(`sun-harness · ${what}`, { body: s.title, silent: s.status === 'idle' });
      n.onclick = () => {
        window.focus();
        setPage('chat');
        setNewMode(null);
        setCurrent(s.id);
      };
    }
  }, []);

  useEffect(() => {
    refresh().then(() => undefined);
    api.pendingApprovals().then(setApprovals);
    api.appInfo().then(setHostMode);
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') void Notification.requestPermission();
    return window.sun.onLive((e) => {
      if (e.kind === 'sessions') {
        setSessions(e.sessions);
        notify(e.sessions);
      } else if (e.kind === 'approvals') setApprovals(e.approvals);
    });
  }, [refresh, notify]);

  useEffect(() => {
    if (query.trim().length < 2) return setHits([]);
    const t = setTimeout(() => api.searchSessions(query).then(setHits, () => setHits([])), 200);
    return () => clearTimeout(t);
  }, [query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((v) => !v);
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setPage('chat');
        setNewMode('coding');
      } else if (e.key === 'Escape') setPalette(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const [showArchived, setShowArchived] = useState(false);
  const { groups, children } = useMemo(() => groupSessions(sessions, showArchived), [sessions, showArchived]);
  const currentSummary = sessions.find((s) => s.id === current);
  const attention = sessions.filter((s) => s.status === 'paused' || s.status === 'awaiting_approval').length + approvals.length;

  const startSession = async (mode: string, cwd?: string, worktree?: boolean) => {
    const s = await api.createSession({ mode, cwd, worktree });
    setNewMode(null);
    setCurrent(s.id);
    setPage('chat');
    refresh();
  };

  return (
    <div className="shell">
      <nav className="rail">
        <div className="sun-mark" title="sun-harness">
          <span />
        </div>
        {NAV.map((n) => (
          <button key={n.id} className={`rail-btn ${page === n.id ? 'on' : ''}`} onClick={() => setPage(n.id)} title={n.label}>
            <span className="glyph">{n.glyph}</span>
            {n.id === 'chat' && attention > 0 && <span className="badge">{attention}</span>}
          </button>
        ))}
      </nav>

      {page === 'chat' && (
        <aside className="sidebar">
          <div className="sidebar-head">
            <h1>
              sun<em>harness</em>
            </h1>
            <button className="btn-new" onClick={() => setNewMode('coding')}>
              + New
            </button>
          </div>
          <input className="session-search" placeholder="Search sessions…  (⌘K for everything)" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="session-list">
            {query.trim().length >= 2 && (
              <div>
                <div className="group-label">Matches</div>
                {hits.map((h) => (
                  <button key={h.id} className={`session ${current === h.id ? 'on' : ''}`} onClick={() => (setCurrent(h.id), setNewMode(null))}>
                    <span className="session-title">
                      {h.title}
                      <span className="muted small hit-snippet">{h.snippet}</span>
                    </span>
                    <span className={`mode-tag m-${h.mode}`}>{MODE_META[h.mode]?.label ?? h.mode}</span>
                  </button>
                ))}
                {!hits.length && <p className="muted pad small">No matches.</p>}
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
                          <span className={`ctx-mini ${s.contextTokens / s.contextWindow > 0.8 ? 'hot' : ''}`} title={`context: ${s.contextTokens.toLocaleString('en')} of ${s.contextWindow.toLocaleString('en')} tokens at the last request`}>
                            {Math.round((s.contextTokens / s.contextWindow) * 100)}%
                          </span>
                        ) : null}
                        {s.worktree && !s.worktree.closed && <span className="mode-tag wt" title={s.worktree.branch}>⑂</span>}
                        <span className={`mode-tag m-${s.mode}`}>{MODE_META[s.mode]?.label ?? s.mode}</span>
                      </button>
                      <span className="session-actions">
                        <button title={s.pinned ? 'Unpin' : 'Pin to the top'} onClick={() => void api.setSessionFlags(s.id, { pinned: !s.pinned })}>
                          {s.pinned ? '◉' : '○'}
                        </button>
                        <button title={s.archived ? 'Unarchive' : 'Archive'} onClick={() => void api.setSessionFlags(s.id, { archived: !s.archived })}>
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
            {!sessions.length && <p className="muted pad">No sessions yet.</p>}
          </div>
          {hostMode && hostMode.mode !== 'local' && (
            <div className="host-mode" title={hostMode.gateway ?? location.origin}>
              <span className="dot dot-idle" /> {hostMode.mode === 'web' ? 'web · gateway' : 'via gateway'}
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
          onImported={(id) => (refresh(), setPage('chat'), setNewMode(null), setCurrent(id), setPalette(false))}
        />
      )}
      <main className="main">
        {page === 'chat' &&
          (current && currentSummary && newMode === null ? (
            <Chat key={current} summary={currentSummary} approvals={approvals} onOpen={setCurrent} onDeleted={() => setCurrent(undefined)} />
          ) : (
            <Welcome initialMode={newMode ?? 'coding'} onStart={startSession} />
          ))}
        {page === 'knowledge' && <KnowledgePage />}
        {page === 'extensions' && <ExtensionsPage cwd={currentSummary?.cwd} />}
        {page === 'evolution' && <EvolutionPage currentSession={current} />}
        {page === 'intel' && <IntelPage />}
        {page === 'settings' && <SettingsPage />}
      </main>
    </div>
  );
}

function Welcome({ initialMode, onStart }: { initialMode: string; onStart: (mode: string, cwd?: string, worktree?: boolean) => void | Promise<void> }) {
  const [mode, setMode] = useState(initialMode);
  const [cwd, setCwd] = useState<string | undefined>();
  const [worktree, setWorktree] = useState(false);
  const [error, setError] = useState('');
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Late night' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  return (
    <div className="welcome">
      <div className="horizon" />
      <p className="eyebrow">{greet}</p>
      <h2 className="hero">
        What shall we <em>build</em> today?
      </h2>
      <div className="mode-cards">
        {Object.entries(MODE_META).map(([id, m], i) => (
          <button key={id} className={`mode-card ${mode === id ? 'on' : ''}`} style={{ animationDelay: `${i * 70}ms` }} onClick={() => setMode(id)}>
            <span className="mode-glyph">{m.glyph}</span>
            <strong>{m.label}</strong>
            <span>{m.blurb}</span>
          </button>
        ))}
      </div>
      <div className="welcome-actions">
        <button className="chip" onClick={async () => setCwd((await api.pickFolder()) ?? cwd)}>
          {cwd ? `📁 ${cwd}` : isRepoMode(mode) ? 'Choose a project folder…' : 'Workspace: ~/.sun/workspace (change…)'}
        </button>
        {isRepoMode(mode) && (
          <label className="chip toggle" title="Work on a new branch in a separate checkout; merge or discard when done.">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Isolated git worktree
          </label>
        )}
        <button
          className="btn-primary"
          onClick={async () => {
            setError('');
            try {
              await onStart(mode, cwd, isRepoMode(mode) && worktree);
            } catch (e) {
              setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
            }
          }}
          disabled={isRepoMode(mode) && !cwd}
        >
          Start {MODE_META[mode].label} session →
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
  onImported,
}: {
  sessions: SessionSummary[];
  onClose: () => void;
  onPage: (p: Page) => void;
  onSession: (id: string) => void;
  onNew: (mode: string) => void;
  onImported: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const file = useRef<HTMLInputElement>(null);
  const items: PaletteItem[] = [
    ...Object.entries(MODE_META).map(([id, m]) => ({ label: `New ${m.label} session`, hint: m.blurb, run: () => onNew(id) })),
    ...NAV.map((n) => ({ label: `Go to ${n.label}`, run: () => onPage(n.id) })),
    { label: 'Import session (JSONL)…', hint: 'from sun export --format jsonl', run: () => file.current?.click() },
    { label: 'Run daily briefing now', run: () => void api.runBriefing().then((r) => onSession(r.sessionId)) },
    ...sessions.filter((s) => !s.parent).slice(0, 200).map((s) => ({ label: s.title, hint: `${MODE_META[s.mode]?.label ?? s.mode} · ${s.updatedAt.slice(0, 10)}`, run: () => onSession(s.id) })),
  ];
  const ql = q.toLowerCase();
  const shown = items.filter((i) => !ql || i.label.toLowerCase().includes(ql) || i.hint?.toLowerCase().includes(ql)).slice(0, 14);
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          autoFocus
          placeholder="Type a command or a session name…"
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
        <input
          ref={file}
          type="file"
          accept=".jsonl,application/json"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) onImported((await api.importSession(await f.text())).id);
          }}
        />
      </div>
    </div>
  );
}
