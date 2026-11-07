import type { KnowledgeHit, McpServerState, PluginState, Proposal, ScheduledTask, Skill, SunConfig } from '@sun/core';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { Markdown } from './markdown';

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

export function KnowledgePage() {
  const [stats, reload] = useAsync(() => api.kbStats());
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<(KnowledgeHit & { provider: string })[]>();
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [memory, setMemory] = useState('');
  const [saved, setSaved] = useState('');
  useEffect(() => {
    api.getMemory().then(setMemory);
  }, []);
  return (
    <PageShell
      eyebrow="Context"
      title={
        <>
          Knowledge <em>&amp; memory</em>
        </>
      }
      intro="Notes the agents can search (kb_search), plus the memory file every session reads. Add folders of Markdown in Settings; company knowledge plugs in as another provider."
    >
      <div className="grid2">
        <section className="card">
          <h3>Search</h3>
          <div className="row">
            <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={async (e) => e.key === 'Enter' && setHits(await api.kbSearch(q))} placeholder="Search your notes…" />
            <button className="btn-primary" onClick={async () => setHits(await api.kbSearch(q))}>
              Search
            </button>
          </div>
          {stats && (
            <p className="muted small">
              {stats.personal.documents} documents · {stats.personal.chunks} chunks
              {stats.personal.model ? ` · ${stats.personal.embedded} embedded (${stats.personal.model})` : ' · keyword search (BM25)'} · providers: {stats.providers.map((p) => p.name).join(', ')}
              {stats.personal.lastError && <span className="err-text"> · embeddings unavailable, using BM25: {stats.personal.lastError}</span>}
              <br />
              roots: <span className="mono">{stats.roots.join(', ')}</span>
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
            {hits && !hits.length && <p className="muted">No results.</p>}
          </div>
        </section>
        <section className="card">
          <h3>Add a note</h3>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title" />
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={7} placeholder="Markdown…" />
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
            Save to personal KB
          </button>
          {saved && <p className="muted small mono">Saved {saved}</p>}
          <h3 className="mt">Memory</h3>
          <textarea className="mono" value={memory} onChange={(e) => setMemory(e.target.value)} rows={10} placeholder="# Memory&#10;## Profile&#10;- …" />
          <button className="btn-ghost" onClick={() => api.setMemory(memory).then(() => setSaved('memory saved'))}>
            Save memory
          </button>
        </section>
      </div>
    </PageShell>
  );
}

// ---------------- Extensions ----------------

export function ExtensionsPage({ cwd }: { cwd?: string }) {
  const [dir, setDir] = useState<string | undefined>(cwd);
  const [info] = useAsync(() => api.appInfo());
  const target = dir ?? info?.defaultCwd ?? '';
  const [skills] = useAsync(() => (target ? api.listSkills(target) : Promise.resolve([] as Skill[])), [target]);
  const [mcp, setMcp] = useState<McpServerState[]>();
  const [plugins, setPlugins] = useState<PluginState[]>();
  const [schedules, reloadSchedules] = useAsync(() => api.listSchedules());
  useEffect(() => {
    if (target) api.listMcp(target).then(setMcp);
    api.listPlugins().then(setPlugins);
  }, [target]);
  return (
    <PageShell
      eyebrow="Capabilities"
      title={
        <>
          Skills, MCP <em>&amp; plugins</em>
        </>
      }
      intro="Everything the agent can do beyond the built-in tools. Skills load on demand; MCP servers come from ~/.sun/mcp.json, .mcp.json and .sun/mcp.json; plugins live in ~/.sun/plugins."
      actions={
        <button className="chip mono" onClick={async () => setDir((await api.pickFolder()) ?? dir)}>
          {target.replace(/^\/Users\/[^/]+/, '~') || 'choose workspace'}
        </button>
      }
    >
      <div className="grid2">
        <section className="card">
          <h3>Skills {skills && <span className="muted">({skills.length})</span>}</h3>
          <div className="list">
            {skills?.map((s) => (
              <div key={s.name} className="item">
                <div>
                  <strong>{s.name}</strong> <span className={`scope s-${s.scope}`}>{s.scope}</span>
                </div>
                <p className="muted small">{s.description}</p>
              </div>
            ))}
          </div>
        </section>
        <div className="stack">
          <section className="card">
            <div className="card-head">
              <h3>MCP servers</h3>
              <button className="btn-ghost small" onClick={async () => setMcp(await api.reloadMcp(target))}>
                Reconnect
              </button>
            </div>
            {mcp?.length === 0 && <p className="muted small">No servers configured. Add one to ~/.sun/mcp.json: {'{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "pkg"] } } }'}</p>}
            {mcp?.map((s) => (
              <div key={s.name} className="item">
                <div>
                  <span className={`dot dot-${s.status === 'ready' ? 'idle' : s.status === 'error' ? 'error' : 'paused'}`} /> <strong>{s.name}</strong>{' '}
                  <span className="muted small">{s.status}</span>
                </div>
                <p className="muted small mono">{s.error ?? s.tools.join(', ')}</p>
              </div>
            ))}
          </section>
          <section className="card">
            <div className="card-head">
              <h3>Plugins</h3>
              <button className="btn-ghost small" onClick={async () => setPlugins(await api.reloadPlugins())}>
                Reload
              </button>
            </div>
            {plugins?.length === 0 && <p className="muted small">No plugins in ~/.sun/plugins. See docs/manual/extensions.md for the plugin API.</p>}
            {plugins?.map((p) => (
              <div key={p.name} className="item">
                <strong>{p.name}</strong> <span className="muted small">{p.status}</span>
                <p className="muted small mono">{p.error ?? Object.entries(p.contributes).filter(([, v]) => v.length).map(([k, v]) => `${k}: ${v.join(', ')}`).join(' · ')}</p>
              </div>
            ))}
          </section>
          <section className="card">
            <h3>Schedules</h3>
            {schedules?.length === 0 && <p className="muted small">Ask the assistant to "remind me…" or "every weekday at 9…" to create one.</p>}
            {schedules?.map((t: ScheduledTask) => (
              <div key={t.id} className="item row-between">
                <div>
                  <strong>{t.title}</strong> <span className="muted small mono">{t.cron ?? t.at}</span>
                  {!t.enabled && <span className="muted small"> (done)</span>}
                </div>
                <button className="btn-ghost small" onClick={() => api.removeSchedule(t.id).then(reloadSchedules)}>
                  Remove
                </button>
              </div>
            ))}
          </section>
        </div>
      </div>
    </PageShell>
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
          <span className={`ptype`}>{p.type}</span> <strong>{p.title}</strong>
        </div>
        <span className="muted small mono">
          {p.source.kind} {p.source.ref}
        </span>
      </div>
      <Markdown text={p.content} className="small" />
      {p.rationale && <p className="muted small">Why: {p.rationale}</p>}
      {p.status === 'pending' ? (
        <div className="row">
          <button className="btn-primary small" onClick={() => run('accept', () => api.acceptProposal(p.id))}>
            Accept
          </button>
          <button className="btn-ghost small" onClick={() => run('reject', () => api.rejectProposal(p.id))}>
            Reject
          </button>
        </div>
      ) : (
        <p className="muted small">{p.status}</p>
      )}
    </div>
  );
  return (
    <PageShell
      eyebrow="Self-improvement"
      title={
        <>
          The harness <em>evolves</em>
        </>
      }
      intro="Reflection turns finished sessions into proposals: memories, reusable skills, global rules, or feature ideas. Intel adds ideas from other harnesses. Nothing changes until you accept."
      actions={
        <button className="btn-primary" disabled={!currentSession || !!busy} onClick={() => run('reflect', () => api.reflect(currentSession!))}>
          {busy === 'reflect' ? 'Reflecting…' : 'Reflect on current session'}
        </button>
      }
    >
      <h3>Pending ({pending.length})</h3>
      <div className="proposals">{pending.map((p) => <P key={p.id} p={p} />)}</div>
      {!pending.length && <p className="muted">No pending proposals.</p>}
      {done.length > 0 && (
        <>
          <h3 className="mt">History</h3>
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
      eyebrow="Field watch"
      title={
        <>
          Harness <em>intel</em>
        </>
      }
      intro="A daily briefing on what other harnesses shipped — what changed, the mechanism underneath, and what sun-harness could adopt. Runs daily via launchd and catches up when the app opens."
      actions={
        <>
          {current?.pending && (
            <button className="btn-ghost" disabled={!!busy} onClick={() => go('analyze', () => api.analyzeIntel(current.date))}>
              {busy === 'analyze' ? 'Analyzing…' : 'Analyze pending'}
            </button>
          )}
          <button className="btn-primary" disabled={!!busy} onClick={() => go('run', () => api.runIntel(false))}>
            {busy === 'run' ? 'Fetching & analyzing…' : 'Run now'}
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
          {reports?.length === 0 && <p className="muted small">No reports yet.</p>}
        </div>
        <article className="report card">
          {md ? <Markdown text={md} /> : <p className="muted">Run intel to get the first briefing.</p>}
          {current && (
            <button className="link small mono" onClick={() => api.openPath(current.html)}>
              open HTML report
            </button>
          )}
        </article>
      </div>
    </PageShell>
  );
}

// ---------------- Settings ----------------

export function SettingsPage() {
  const [cfg, setCfg] = useState<SunConfig>();
  const [models, setModels] = useState<{ ref: string; provider: string; ready: boolean }[]>([]);
  const [info] = useAsync(() => api.appInfo());
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api.getConfig().then(setCfg);
    api.listModels().then(setModels);
  }, []);
  if (!cfg) return null;
  const save = async (patch: Partial<SunConfig>) => {
    setCfg(await api.updateConfig(patch));
    setModels(await api.listModels());
    setMsg('Saved');
    setTimeout(() => setMsg(''), 1500);
  };
  const ready = models.filter((m) => m.ready).map((m) => m.ref);
  const providers = Object.entries(cfg.providers);
  return (
    <PageShell
      eyebrow="Preferences"
      title={
        <>
          Settings <em>{msg && <span className="saved">{msg}</span>}</em>
        </>
      }
      intro={`Stored in ${info?.home ?? '~/.sun'}/config.json. API keys are read from environment variables (your login shell is imported at launch).`}
    >
      <div className="grid2">
        <section className="card">
          <h3>Models</h3>
          <label>
            Default model
            <select value={cfg.defaultModel} onChange={(e) => save({ defaultModel: e.target.value })}>
              {[...new Set([cfg.defaultModel, ...ready])].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Fallback chain (used when a model runs out of quota)
            <div className="chips">
              {ready.map((m) => {
                const on = cfg.fallbackModels.includes(m);
                return (
                  <button key={m} className={`chip ${on ? 'on' : ''}`} onClick={() => save({ fallbackModels: on ? cfg.fallbackModels.filter((x) => x !== m) : [...cfg.fallbackModels, m] })}>
                    {on ? `${cfg.fallbackModels.indexOf(m) + 1}. ` : ''}
                    {m}
                  </button>
                );
              })}
            </div>
          </label>
          <label>
            Auto-resume paused sessions every
            <div className="row">
              <input type="checkbox" checked={cfg.autoResume.enabled} onChange={(e) => save({ autoResume: { ...cfg.autoResume, enabled: e.target.checked } })} />
              <input type="number" min={1} value={cfg.autoResume.intervalMinutes} onChange={(e) => save({ autoResume: { ...cfg.autoResume, intervalMinutes: Number(e.target.value) } })} />
              <span className="muted">minutes</span>
            </div>
          </label>
          <h3 className="mt">Approval</h3>
          <div className="segmented">
            {(['suggest', 'auto-edit', 'full-auto'] as const).map((m) => (
              <button key={m} className={cfg.approval === m ? 'on' : ''} onClick={() => save({ approval: m })}>
                {m}
              </button>
            ))}
          </div>
          <p className="muted small">
            suggest: ask before any write or command · auto-edit: workspace edits are free, commands and network ask · full-auto: never ask
          </p>
          <label className="row">
            <input type="checkbox" checked={cfg.denyInsteadOfPrompting} onChange={(e) => save({ denyInsteadOfPrompting: e.target.checked })} />
            Deny instead of prompting (the agent is told why and keeps going; headless runs always do this)
          </label>
          <label>
            Max steps per run
            <input type="number" value={cfg.maxSteps} onChange={(e) => save({ maxSteps: Number(e.target.value) })} />
          </label>
          <h3 className="mt">Shell sandbox</h3>
          <div className="segmented">
            {(['auto', 'seatbelt', 'bwrap', 'docker', 'off'] as const).map((m) => (
              <button key={m} className={cfg.sandbox.mode === m ? 'on' : ''} onClick={() => save({ sandbox: { ...cfg.sandbox, mode: m } })}>
                {m}
              </button>
            ))}
          </div>
          <div className="segmented">
            {(['on', 'allowlist', 'off'] as const).map((n) => (
              <button key={n} className={cfg.sandbox.network === n ? 'on' : ''} onClick={() => save({ sandbox: { ...cfg.sandbox, network: n } })}>
                network {n}
              </button>
            ))}
          </div>
          {cfg.sandbox.network === 'allowlist' && (
            <label>
              Allowed hosts (comma separated, *.domain for subdomains)
              <input className="mono small" value={cfg.sandbox.allow.join(', ')} onChange={(e) => save({ sandbox: { ...cfg.sandbox, allow: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) } })} />
            </label>
          )}
          <label className="row">
            <input type="checkbox" checked={cfg.sandbox.autoApprove} onChange={(e) => save({ sandbox: { ...cfg.sandbox, autoApprove: e.target.checked } })} />
            In auto-edit, run sandboxed shell commands without asking
          </label>
          <p className="muted small">
            auto: macOS seatbelt or Linux bubblewrap when available · docker: one container per session ({cfg.sandbox.docker.image}) · commands can write only the workspace and package caches; credentials and the harness's tokens are hidden
          </p>
        </section>
        <div className="stack">
          <section className="card">
            <h3>Providers</h3>
            {providers.map(([id, p]) => (
              <div key={id} className="provider">
                <span className={`dot ${models.some((m) => m.provider === id && m.ready) ? 'dot-idle' : 'dot-off'}`} />
                <strong>{id}</strong>
                <span className="muted small mono">{p.apiKeyEnv ?? (p.noKey ? 'no key' : '')}</span>
                <input
                  className="mono small"
                  defaultValue={p.baseUrl}
                  onBlur={(e) => e.target.value !== p.baseUrl && save({ providers: { [id]: { ...p, baseUrl: e.target.value } } } as never)}
                />
                <input
                  className="mono small"
                  defaultValue={p.models.join(', ')}
                  title="Models (comma separated)"
                  onBlur={(e) => save({ providers: { [id]: { ...p, models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } } } as never)}
                />
              </div>
            ))}
          </section>
          <section className="card">
            <h3>Knowledge</h3>
            <label>
              Personal KB folders (comma separated)
              <input className="mono" defaultValue={cfg.kb.roots.join(', ')} onBlur={(e) => save({ kb: { ...cfg.kb, roots: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) } })} />
            </label>
            <label className="row">
              <input type="checkbox" checked={cfg.kb.embeddings.enabled} onChange={(e) => save({ kb: { ...cfg.kb, embeddings: { ...cfg.kb.embeddings, enabled: e.target.checked } } })} />
              Hybrid retrieval (BM25 + embeddings; note chunks are sent to the embedding provider)
            </label>
            <input
              className="mono"
              placeholder="qwen/text-embedding-v4"
              defaultValue={cfg.kb.embeddings.model}
              onBlur={(e) => save({ kb: { ...cfg.kb, embeddings: { ...cfg.kb.embeddings, model: e.target.value } } })}
            />
            <label className="row">
              <input type="checkbox" checked={cfg.kb.company.enabled} onChange={(e) => save({ kb: { ...cfg.kb, company: { ...cfg.kb.company, enabled: e.target.checked } } })} />
              Company knowledge base (reserved HTTP provider)
            </label>
            <input className="mono" placeholder="https://kb.company.internal/api" defaultValue={cfg.kb.company.baseUrl} onBlur={(e) => save({ kb: { ...cfg.kb, company: { ...cfg.kb.company, baseUrl: e.target.value } } })} />
            <h3 className="mt">Intel schedule</h3>
            <div className="row">
              <input type="number" min={0} max={23} value={cfg.intel.hour} onChange={(e) => save({ intel: { hour: Number(e.target.value) } } as never)} />
              <span>:</span>
              <input type="number" min={0} max={59} value={cfg.intel.minute} onChange={(e) => save({ intel: { minute: Number(e.target.value) } } as never)} />
              <span className="muted small">{cfg.intel.sources.length} sources · run `sun intel install-schedule` after changing</span>
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}
