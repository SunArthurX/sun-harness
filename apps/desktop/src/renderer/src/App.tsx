import type { PendingApproval, SessionSummary } from '@sun/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
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
  agent: { label: 'Agent', blurb: 'Plan, research the web, and deliver files — Manus-style.', glyph: '✦' },
  assistant: { label: 'Assistant', blurb: 'A companion with memory, notes and reminders.', glyph: '☼' },
};

function groupSessions(sessions: SessionSummary[]) {
  const top = sessions.filter((s) => !s.parent);
  const children = new Map<string, SessionSummary[]>();
  for (const s of sessions) if (s.parent) children.set(s.parent, [...(children.get(s.parent) ?? []), s]);
  const today = new Date().toISOString().slice(0, 10);
  return {
    children,
    groups: [
      { label: 'Today', items: top.filter((s) => s.updatedAt.slice(0, 10) === today) },
      { label: 'Earlier', items: top.filter((s) => s.updatedAt.slice(0, 10) !== today) },
    ].filter((g) => g.items.length),
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

  const refresh = useCallback(async () => setSessions(await api.listSessions()), []);

  useEffect(() => {
    refresh();
    api.pendingApprovals().then(setApprovals);
    api.appInfo().then(setHostMode);
    return window.sun.onLive((e) => {
      if (e.kind === 'sessions') setSessions(e.sessions);
      else if (e.kind === 'approvals') setApprovals(e.approvals);
    });
  }, [refresh]);

  const { groups, children } = useMemo(() => groupSessions(sessions), [sessions]);
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
          <div className="session-list">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="group-label">{g.label}</div>
                {g.items.map((s) => (
                  <div key={s.id}>
                    <button className={`session ${current === s.id ? 'on' : ''}`} onClick={() => (setCurrent(s.id), setNewMode(null))}>
                      <StatusDot s={s} />
                      <span className="session-title">{s.title}</span>
                      {s.worktree && !s.worktree.closed && <span className="mode-tag wt" title={s.worktree.branch}>⑂</span>}
                      <span className={`mode-tag m-${s.mode}`}>{MODE_META[s.mode]?.label ?? s.mode}</span>
                    </button>
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
          {cwd ? `📁 ${cwd}` : mode === 'coding' ? 'Choose a project folder…' : 'Workspace: ~/.sun/workspace (change…)'}
        </button>
        {mode === 'coding' && (
          <label className="chip toggle" title="Work on a new branch in a separate checkout; merge or discard when done.">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Isolated git worktree
          </label>
        )}
        <button
          className="btn-primary"
          onClick={async () => {
            setError('');
            try {
              await onStart(mode, cwd, mode === 'coding' && worktree);
            } catch (e) {
              setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
            }
          }}
          disabled={mode === 'coding' && !cwd}
        >
          Start {MODE_META[mode].label} session →
        </button>
      </div>
      {error && <p className="welcome-error">{error}</p>}
    </div>
  );
}
