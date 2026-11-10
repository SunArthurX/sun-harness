import { describeSchedule, fmtDate, t, tk } from './i18n';
import { modeLabel } from './App';
import type { Automation, KnowledgeHit, McpServerState, Proposal, ScheduledTask, Skill } from '@sun/core';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { Markdown } from './markdown';
import { PluginsPanel } from './settings/PluginsPanel';

function PageShell({ eyebrow, title, intro, children, actions }: { eyebrow: string; title: ReactNode; intro?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="eyebrow">{eyebrow}</p>
          <h2 className="page-title">{title}</h2>
          {intro && <p className="muted intro">{intro}</p>}
        </div>
        <div className="page-actions">{actions}</div>
      </header>
      <div className="page-body">{children}</div>
    </div>
  );
}

function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): [T | undefined, () => void, string | undefined] {
  const [v, setV] = useState<T>();
  const [err, setErr] = useState<string>();
  const [n, setN] = useState(0);
  useEffect(() => {
    fn().then(setV, (e) => setErr(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return [v, () => setN((x) => x + 1), err];
}

// ---------------- Knowledge ----------------

export function KnowledgePage({ onMemory }: { onMemory(): void }) {
  const [stats, reload] = useAsync(() => api.kbStats());
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<(KnowledgeHit & { provider: string })[]>();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  return (
    <PageShell
      eyebrow={t("Context")}
      title={
        <>
          {t('Knowledge')} <em>{t('& memory')}</em>
        </>
      }
      intro={t("Search your knowledge providers and manage recalled facts. Add Markdown folders in Settings.")}
    >
      <div className="grid2">
        <section className="card">
          <h3>{t("Search")}</h3>
          <div className="row">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={async (e) => e.key === 'Enter' && setHits(await api.kbSearch(q))} placeholder={t("Search your notes…")} />
            <button className="btn-primary" onClick={async () => setHits(await api.kbSearch(q))}>
              {t("Search")}
            </button>
          </div>
          {stats && (
            <p className="muted small">
              {t('{documents} documents · {chunks} chunks', { documents: stats.personal.documents, chunks: stats.personal.chunks })}
              {stats.personal.model ? ` · ${t('{n} embedded ({model})', { n: stats.personal.embedded, model: stats.personal.model })}` : ` · ${t('keyword search (BM25)')}`} · {t('providers:')} {stats.providers.map((p) => p.name).join(', ')}
              {stats.personal.lastError && <span className="err-text"> · {t('embeddings unavailable, using BM25:')} {stats.personal.lastError}</span>}
              <br />
              {t('roots:')} <span className="mono">{stats.roots.join(', ')}</span>
            </p>
          )}
          <div className="hits">
            {hits?.map((h, i) => (
              <div key={i} className="hit">
                <div className="hit-head">
                  <strong>{h.title}</strong>
                  <span className="muted small mono">
                    {h.provider} · {h.score}
                  </span>
                </div>
                <p>{h.text.slice(0, 360)}</p>
                <button className="link small mono" onClick={() => api.openPath(h.source)}>
                  {h.source}
                </button>
              </div>
            ))}
            {hits && !hits.length && <p className="muted">{t("No results.")}</p>}
          </div>
        </section>
        <section className="card">
          <h3>{t("Add a note")}</h3>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t("Title")} />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder={t("Markdown…")} />
          <button
            className="btn-primary"
            disabled={!title || !text}
            onClick={async () => {
              const f = await api.kbAdd(title, text);
              setSaved(f);
              setTitle('');
              setText('');
              reload();
            }}
          >
            {t("Save to personal KB")}
          </button>
          {saved && <p className="muted small mono">{t('Saved {what}', { what: saved })}</p>}
          <LongTermMemory />
          <button type="button" className="btn-ghost" onClick={onMemory}>{t('Open memory settings')}</button>
        </section>
      </div>
    </PageShell>
  );
}

/** Long-term memories: recalled by relevance, extracted automatically after assistant conversations. */
export function LongTermMemory() {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.listMemories>>>([]);
  const [q, setQ] = useState('');
  const load = () => api.listMemories().then((l) => setItems([...l].reverse()), () => setItems([]));
  useEffect(() => {
    load();
  }, []);
  const shown = items.filter((m) => !q || m.text.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <h3 className="mt">
        {t("Long-term memory")} <span className="muted">({items.length})</span>
      </h3>
      <input placeholder={t("Filter…")} value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="memory-list">
        {shown.slice(0, 200).map((m) => (
          <div key={m.id} className="memory-row">
            <span className="tag">{t(m.kind)}</span>
            <span className="memory-text">{m.text}</span>
            <span className="muted small">{m.created.slice(0, 10)}</span>
            <button className="btn-ghost small" title={t("Forget")} onClick={() => api.removeMemory(m.id).then(load)}>
              ✕
            </button>
          </div>
        ))}
        {!shown.length && <p className="muted small">{t("Nothing yet. The assistant saves durable facts and preferences as you talk.")}</p>}
      </div>
    </>
  );
}

// ---------------- Extensions ----------------

const MCP_EXAMPLE = '{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }';

export function ExtensionsPage({ cwd }: { cwd?: string }) {
  const [dir, setDir] = useState<string | undefined>(cwd);
  const [info] = useAsync(() => api.appInfo());
  const target = dir ?? info?.defaultCwd ?? '';
  const [skills] = useAsync(() => (target ? api.listSkills(target) : Promise.resolve([] as Skill[])), [target]);
  const [mcp, setMcp] = useState<McpServerState[]>();
  const [schedules, reloadSchedules] = useAsync(() => api.listSchedules());
  useEffect(() => {
    if (target) api.listMcp(target).then(setMcp, () => undefined);
  }, [target]);
  return (
    <PageShell
      eyebrow={t("Capabilities")}
      title={
        <>
          {t('Skills, MCP')} <em>{t('& plugins')}</em>
        </>
      }
      intro={t("Everything the agent can do beyond the built-in tools. Skills load on demand; MCP servers come from ~/.sun/mcp.json, .mcp.json and .sun/mcp.json; plugins live in ~/.sun/plugins.")}
      actions={
        info?.mode === 'remote' ? <form onSubmit={event => {
          event.preventDefault();
          const path = new FormData(event.currentTarget).get('cwd');
          setDir(typeof path === 'string' && path.trim() ? path.trim() : undefined);
        }}>
          <label>{t('Workspace on the execution host')} <input name="cwd" defaultValue={dir} /></label>
          <button type="submit" className="chip">{t('Refresh')}</button>
        </form> : <button className="chip mono" onClick={async () => setDir((await api.pickFolder()) ?? dir)}>
          {target.replace(/^\/Users\/[^/]+/, '~') || t("choose workspace")}
        </button>
      }
    >
      <div className="grid2">
        <section className="card">
          <h3>{t("Skills")} {skills && <span className="muted">({skills.length})</span>}</h3>
          <div className="list">
            {skills?.map((s) => (
              <div key={s.name} className="item">
                <div>
                  <strong>{s.name}</strong> <span className={`scope s-${s.scope}`}>{t(s.scope)}</span>
                </div>
                <p className="muted small">{s.description}</p>
              </div>
            ))}
          </div>
        </section>
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h3>{t("MCP servers")}</h3>
              <button className="btn-ghost small" onClick={async () => setMcp(await api.reloadMcp(target))}>
                {t("Reconnect")}
              </button>
            </div>
            {mcp?.length === 0 && <p className="muted small">{t('No servers configured. Add one to ~/.sun/mcp.json:')} <code>{MCP_EXAMPLE}</code></p>}
            {mcp?.map((s) => (
              <div key={s.name} className="item">
                <div>
                  <span className={`dot dot-${s.status === 'ready' ? 'idle' : s.status === 'error' ? 'error' : 'paused'}`} /> <strong>{s.name}</strong>{' '}
                  <span className="muted small">{t(s.status)}</span>
                </div>
                <p className="muted small mono">{s.error ?? s.tools.join(', ')}</p>
              </div>
            ))}
          </section>
          <PluginsPanel />
          <section className="card">
            <h3>{t("Schedules")}</h3>
            <p className="muted small">{t("Scheduled prompts are now Automations: open ⏲ in the left rail (or say “every weekday at 9 …” in any chat).")}</p>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

export function BriefingNow() {
  const [state, setState] = useState('');
  return (
    <div className="row">
      <button
        className="btn-ghost small"
        disabled={state === 'running'}
        onClick={() => {
          setState('running');
          api.runBriefing().then(
            (r) => setState(t('Saved {what}', { what: r.path })),
            (e) => setState(String(e.message ?? e)),
          );
        }}
      >
        {state === 'running' ? t("Preparing…") : t("Run briefing now")}
      </button>
      {state && state !== 'running' && <span className="muted small mono">{state}</span>}
    </div>
  );
}

/** Conversation efficiency over the last 7 days (from session logs). */
export function Efficiency() {
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => {
    api.metrics(7).then(setRows, () => setRows([]));
  }, []);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  return (
    <section className="card">
      <h3>{t("Efficiency · last 7 days")}</h3>
      {!rows.length && <p className="muted small">{t("No sessions yet.")}</p>}
      {rows.length > 0 && (
        <table className="metrics">
          <thead>
            <tr>
              <th>{t("Mode")}</th>
              <th title={t("user turns")}>{t("Turns")}</th>
              <th title={t("median time to the first reply")}>{t("First reply")}</th>
              <th title={t("approval prompts per turn")}>{t("Asks/turn")}</th>
              <th title={t("final answers that were questions")}>{t("Clarify")}</th>
              <th title={t("tool calls that failed")}>{t("Tool err")}</th>
              <th title={t("input served from the prompt cache")}>{t("Cached")}</th>
              <th title={t("memories recalled / extracted")}>{t("Memory")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.mode}>
                <td>{modeLabel(r.mode)}</td>
                <td>{r.userTurns}</td>
                <td>{(r.medianFirstResponseMs / 1000).toFixed(1)} s</td>
                <td>{r.approvalsPerTurn.toFixed(2)}</td>
                <td>{pct(r.clarifyRate)}</td>
                <td>{pct(r.toolErrorRate)}</td>
                <td>{pct(r.cacheHitRate)}</td>
                <td>
                  {r.memoryRecalls} / {r.memoriesExtracted}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

// ---------------- Evolution ----------------

export function EvolutionPage({ currentSession }: { currentSession?: string }) {
  const [props, reload] = useAsync(() => api.listProposals());
  const [busy, setBusy] = useState('');
  const pending = props?.filter((p) => p.status === 'pending') ?? [];
  const done = props?.filter((p) => p.status !== 'pending') ?? [];
  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await f();
    } catch (e) {
      alert(String((e as Error).message ?? e));
    }
    setBusy('');
    reload();
  };
  const P = ({ p }: { p: Proposal }) => (
    <div className={`proposal p-${p.type}`}>
      <div className="row-between">
        <div>
          <span className={`ptype`}>{t(p.type)}</span> <strong>{p.title}</strong>
        </div>
        <span className="muted small mono">
          {p.source.kind} {p.source.ref}
        </span>
      </div>
      <Markdown text={p.content} className="small" />
      {p.rationale && <p className="muted small">{t("Why:")} {p.rationale}</p>}
      {p.status === 'pending' ? (
        <div className="row">
          <button className="btn-primary small" onClick={() => run('accept', () => api.acceptProposal(p.id))}>
            {t("Accept")}
          </button>
          <button className="btn-ghost small" onClick={() => run('reject', () => api.rejectProposal(p.id))}>
            {t("Reject")}
          </button>
        </div>
      ) : (
        <p className="muted small">{t(p.status)}</p>
      )}
    </div>
  );
  return (
    <PageShell
      eyebrow={t("Self-improvement")}
      title={
        <>
          {t("The harness")} <em>{t("evolves")}</em>
        </>
      }
      intro={t("Reflection turns finished sessions into proposals: memories, reusable skills, global rules, or feature ideas. Intel adds ideas from other harnesses. Nothing changes until you accept.")}
      actions={
        <button className="btn-primary" disabled={!currentSession || !!busy} onClick={() => run('reflect', () => api.reflect(currentSession!))}>
          {busy === 'reflect' ? t("Reflecting…") : t("Reflect on current session")}
        </button>
      }
    >
      <h3>{t('Pending ({n})', { n: pending.length })}</h3>
      <div className="proposals">{pending.map((p) => <P key={p.id} p={p} />)}</div>
      {!pending.length && <p className="muted">{t("No pending proposals.")}</p>}
      {done.length > 0 && (
        <>
          <h3 className="mt">{t("History")}</h3>
          <div className="proposals faded">{done.slice(0, 30).map((p) => <P key={p.id} p={p} />)}</div>
        </>
      )}
    </PageShell>
  );
}

// ---------------- Intel ----------------

export function IntelPage() {
  const [reports, reload] = useAsync(() => api.listIntelReports());
  const [date, setDate] = useState<string>();
  const [md, setMd] = useState('');
  const [busy, setBusy] = useState('');
  const sel = date ?? reports?.[0]?.date;
  useEffect(() => {
    if (sel) api.readIntelReport(sel).then(setMd);
  }, [sel, reports]);
  const go = async (label: string, f: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await f();
    } catch (e) {
      alert(String((e as Error).message ?? e));
    }
    setBusy('');
    reload();
  };
  const current = reports?.find((r) => r.date === sel);
  return (
    <PageShell
      eyebrow={t("Field watch")}
      title={
        <>
          {t("Harness")} <em>{t("intel")}</em>
        </>
      }
      intro={t("A daily briefing on what other harnesses shipped — what changed, the mechanism underneath, and what sun-harness could adopt. Runs daily via launchd and catches up when the app opens.")}
      actions={
        <>
          {current?.pending && (
            <button className="btn-ghost" disabled={!!busy} onClick={() => go('analyze', () => api.analyzeIntel(current.date))}>
              {busy === 'analyze' ? t("Analyzing…") : t("Analyze pending")}
            </button>
          )}
          <button className="btn-primary" disabled={!!busy} onClick={() => go('run', () => api.runIntel(false))}>
            {busy === 'run' ? t("Fetching & analyzing…") : t("Run now")}
          </button>
        </>
      }
    >
      <div className="intel">
        <div className="intel-dates">
          {reports?.map((r) => (
            <button key={r.date} className={`date ${sel === r.date ? 'on' : ''}`} onClick={() => setDate(r.date)}>
              {r.date}
              {r.pending && <span className="dot dot-paused" />}
            </button>
          ))}
          {reports?.length === 0 && <p className="muted small">{t("No reports yet.")}</p>}
        </div>
        <article className="report card">
          {md ? <Markdown text={md} /> : <p className="muted">{t("Run intel to get the first briefing.")}</p>}
          {current && (
            <button className="link small mono" onClick={() => api.openPath(current.html)}>
              {t("open HTML report")}
            </button>
          )}
        </article>
      </div>
    </PageShell>
  );
}

// ---------------- Settings ----------------

// ---------------- Automations ----------------

const STATUS_DOT: Record<string, string> = { idle: 'dot-idle', running: 'dot-running', paused: 'dot-paused', error: 'dot-error', aborted: 'dot-paused' };

/** Cursor Automations / ChatGPT Tasks-style list with a natural-language editor. */
export function AutomationsPage({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  const [list, reload] = useAsync(() => api.listAutomations());
  const [editing, setEditing] = useState<string | 'new' | undefined>();
  const [history, setHistory] = useState<string>();
  const [msg, setMsg] = useState('');
  useEffect(
    () =>
      window.sun.onLive((e) => {
        if (e.kind === 'automation') reload();
      }),
    [],
  );
  const say = (text: string) => {
    setMsg(text);
    setTimeout(() => setMsg(''), 4000);
  };
  return (
    <PageShell
      eyebrow={t("Automations")}
      title={<>{t("Things that run")} <em>{t("on their own")}</em></>}
      intro={t("Prompts that run on a schedule in their own session, while the gateway or this app is running. Missed runs (laptop asleep) catch up once. Say “every weekday at 9 summarize my unread mail” in any chat, or create one here.")}
      actions={
        <button className="btn-primary" onClick={() => setEditing('new')}>
          {t("+ New automation")}
        </button>
      }
    >
      {msg && <p className="notice small">{msg}</p>}
      {editing === 'new' && <AutomationForm onDone={(m) => (setEditing(undefined), reload(), m && say(m))} />}
      {list?.length === 0 && editing !== 'new' && <p className="muted">{t("No automations yet.")}</p>}
      <div className="automations">
        {list?.map((a) => (
          <section key={a.id} className={`card automation ${a.enabled ? '' : 'off'}`}>
            {editing === a.id ? (
              <AutomationForm initial={a} onDone={(m) => (setEditing(undefined), reload(), m && say(m))} />
            ) : (
              <>
                <div className="row-between">
                  <div>
                    <strong>{a.title}</strong>
                    <p className="muted small">
                      {describeSchedule(a)} · {modeLabel(a.mode)}
                      {a.model ? ` · ${a.model}` : ''}
                      {a.nextRun ? ` · ${t('next {time}', { time: fmtDate(a.nextRun) })}` : a.enabled ? '' : ` · ${t('paused')}`}
                    </p>
                  </div>
                  <label className="row small" title={a.enabled ? t("Pause") : t("Resume")}>
                    <input type="checkbox" checked={a.enabled} onChange={(e) => void api.updateAutomation(a.id, { enabled: e.target.checked }).then(reload)} />
                    {a.enabled ? t("On") : t("Off")}
                  </label>
                </div>
                <p className="small automation-prompt">{a.prompt}</p>
                <div className="row">
                  <button className="btn-ghost small" onClick={() => void api.runAutomation(a.id).then((sid) => (say(t('Started.')), reload(), onOpenSession(sid)))}>
                    {t("▶ Run now")}
                  </button>
                  <button className="btn-ghost small" onClick={() => setEditing(a.id)}>
                    {t("Edit")}
                  </button>
                  <button className="btn-ghost small" onClick={() => setHistory(history === a.id ? undefined : a.id)}>
                    {t('History ({n})', { n: a.runs?.length ?? 0 })}
                  </button>
                  <button className="btn-danger small" onClick={() => confirm(t('Delete “{title}”?', { title: a.title })) && void api.deleteAutomation(a.id).then(reload)}>
                    {t("Delete")}
                  </button>
                  {a.lastStatus && <span className="muted small">{t('last run:')} {t(a.lastStatus)}</span>}
                </div>
                {history === a.id && (
                  <div className="runs">
                    {(a.runs ?? []).map((r) => (
                      <button key={r.sessionId} className="run-row" onClick={() => onOpenSession(r.sessionId)}>
                        <span className={`dot ${STATUS_DOT[r.status ?? 'idle'] ?? 'dot-off'}`} />
                        <span className="small">{fmtDate(r.at)}</span>
                        <span className="muted small">
                          {t(r.status ?? 'idle')}
                          {r.catchUp ? ` · ${t('catch-up')}` : ''}
                        </span>
                      </button>
                    ))}
                    {!a.runs?.length && <p className="muted small">{t("No runs yet.")}</p>}
                  </div>
                )}
              </>
            )}
          </section>
        ))}
      </div>
    </PageShell>
  );
}

function AutomationForm({ initial, onDone }: { initial?: Automation; onDone: (msg?: string) => void }) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [schedule, setSchedule] = useState(initial?.schedule ?? initial?.description ?? 'every weekday at 9:00');
  const [mode, setMode] = useState(initial?.mode ?? 'assistant');
  const [model, setModel] = useState(initial?.model ?? '');
  const [cwd, setCwd] = useState(initial?.cwd ?? '');
  const [chats, setChats] = useState((initial?.chats ?? []).join(', '));
  const [catchUp, setCatchUp] = useState(initial?.catchUp !== false);
  const [preview, setPreview] = useState<{ description: string; next: string[]; cron?: string; at?: string } | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [info] = useAsync(() => api.appInfo());
  useEffect(() => {
    api.listModels().then((m) => setModels(m.filter((x) => x.ready).map((x) => x.ref)));
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => api.previewSchedule(schedule).then(setPreview, () => setPreview(null)), 250);
    return () => clearTimeout(timer);
  }, [schedule]);
  const save = async () => {
    setErr('');
    const body = { title: title || undefined, prompt, schedule, mode, model: model || undefined, cwd: cwd || undefined, chats: chats.split(',').map((x) => x.trim()).filter(Boolean), catchUp };
    try {
      if (initial) await api.updateAutomation(initial.id, body);
      else await api.createAutomation(body);
      onDone(initial ? t('Saved.') : t('Automation created.'));
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
  };
  return (
    <div className="automation-form">
      <label>
        {t("What should it do?")}
        <textarea rows={3} value={prompt} placeholder={t("Summarize my unread mail and list what needs a reply.")} onChange={(e) => setPrompt(e.target.value)} />
      </label>
      <div className="grid2">
        <label>
          {t("When (plain language or cron)")}
          <input value={schedule} onChange={(e) => setSchedule(e.target.value)} placeholder={t("every weekday at 9:00 · 每天晚上8点 · tomorrow at 15:00 · 0 9 * * 1-5")} />
          <span className={`small ${preview ? 'muted' : 'err-text'}`}>
            {preview ? `${describeSchedule(preview)}${preview.cron ? ` (${preview.cron})` : ''} · ${t('next:')} ${preview.next.map(fmtDate).join(' · ')}` : t('Not understood yet.')}
          </span>
        </label>
        <label>
          {t("Title")}
          <input value={title} placeholder={t("(from the prompt)")} onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label>
          {t("Mode")}
          <select value={mode} onChange={(e) => setMode(e.target.value)}>
            {['assistant', 'agent', 'coding'].map((m) => (
              <option key={m} value={m}>
                {modeLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Model")}
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">{t("default")}</option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          {t("Workspace")}
          <span className="row">
            <input value={cwd} placeholder={t("(default for the mode)")} onChange={(e) => setCwd(e.target.value)} />
            {info?.mode !== 'remote' && <button className="btn-ghost small" onClick={async () => setCwd((await api.pickFolder()) ?? cwd)}>
              …
            </button>}
          </span>
        </label>
        <label>
          {t("Also send results to chats")}
          <input value={chats} placeholder={t("telegram:12345, dingtalk:cid…")} onChange={(e) => setChats(e.target.value)} />
        </label>
      </div>
      <label className="row small">
        <input type="checkbox" checked={catchUp} onChange={(e) => setCatchUp(e.target.checked)} /> {t("Run once after wake-up if a scheduled time was missed (last 24 h)")}
      </label>
      <div className="row">
        <button className="btn-primary" disabled={!prompt.trim() || !preview} onClick={() => void save()}>
          {initial ? t("Save") : t("Create")}
        </button>
        <button className="btn-ghost" onClick={() => onDone()}>
          {t("Cancel")}
        </button>
      </div>
      {err && <p className="small err-text">{err}</p>}
    </div>
  );
}
