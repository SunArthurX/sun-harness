import type { LiveEvent, PendingApproval, SessionEvent, SessionSummary, TodoItem, ToolCall, WorktreeStatus } from '@sun/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import { MODE_META, StatusDot } from './App';
import { Markdown } from './markdown';
import { BrowserPanel } from './Browser';

type ResultEvent = Extract<SessionEvent, { type: 'tool/result' }>;

const TOOL_GLYPH: Record<string, string> = {
  read_file: '◎',
  write_file: '✎',
  edit_file: '✎',
  list_dir: '▤',
  glob: '✱',
  grep: '⌕',
  bash: '❯',
  web_fetch: '⇣',
  web_search: '⌕',
  todo_write: '☑',
  kb_search: '❖',
  kb_add_note: '❖',
  memory_save: '✧',
  load_skill: '⌬',
  task: '⑂',
  schedule_task: '⏲',
};

function summarizeArgs(call: ToolCall): string {
  try {
    const a = JSON.parse(call.arguments || '{}');
    return String(a.command ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.name ?? a.prompt ?? a.fact ?? a.title ?? '').slice(0, 140);
  } catch {
    return call.arguments.slice(0, 140);
  }
}

function ToolCard({ call, result, pending }: { call: ToolCall; result?: ResultEvent; pending: boolean }) {
  const [open, setOpen] = useState(false);
  const state = result ? (result.isError ? 'err' : 'ok') : pending ? 'run' : 'idle';
  const isMcp = call.name.startsWith('mcp__');
  return (
    <div className={`tool tool-${state}`}>
      <button className="tool-head" onClick={() => setOpen(!open)}>
        <span className="tool-glyph">{TOOL_GLYPH[call.name] ?? (isMcp ? '⧉' : '•')}</span>
        <span className="tool-name">{isMcp ? call.name.replace(/^mcp__/, '').replace('__', ' › ') : call.name}</span>
        <span className="tool-arg">{summarizeArgs(call)}</span>
        <span className="tool-meta">{result?.durationMs !== undefined ? `${(result.durationMs / 1000).toFixed(1)}s` : state === 'run' ? '…' : ''}</span>
      </button>
      {open && (
        <div className="tool-body">
          <div className="tool-label">arguments</div>
          <pre>{(() => {
            try {
              return JSON.stringify(JSON.parse(call.arguments || '{}'), null, 2);
            } catch {
              return call.arguments;
            }
          })()}</pre>
          {result && (
            <>
              <div className="tool-label">{result.isError ? 'error' : 'output'}</div>
              <pre>{result.output}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Clicks and key presses in the first moments after the card appears were aimed at something else. */
const APPROVAL_ARM_MS = 700;

function ApprovalCard({ a }: { a: PendingApproval }) {
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setArmed(false);
    // Move focus off the composer so a pending Enter cannot reach the new buttons.
    (document.activeElement as HTMLElement | null)?.blur?.();
    const t = setTimeout(() => setArmed(true), APPROVAL_ARM_MS);
    return () => clearTimeout(t);
  }, [a.promptId]);
  let args = a.arguments;
  try {
    args = JSON.stringify(JSON.parse(a.arguments), null, 2);
  } catch {
    // raw
  }
  const plan = a.name === 'exit_plan_mode' ? (() => {
    try {
      return String(JSON.parse(a.arguments).plan ?? '');
    } catch {
      return '';
    }
  })() : '';
  const answer = async (d: 'allow' | 'allow_always' | 'deny') => {
    if (!armed) return;
    try {
      await api.approve(a.callId, d, a.promptId);
    } catch (e) {
      setError(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
  };
  return (
    <div className={`approval ${armed ? 'armed' : 'arming'}`} data-prompt={a.promptId}>
      <div className="approval-head">
        <span className="risk">{plan ? 'plan' : a.risk}</span>
        {plan ? <strong>Review the plan</strong> : <><strong>{a.name}</strong> wants to run</>}
        {a.sessionId !== a.displaySessionId ? ' (from a subagent)' : ''}
      </div>
      {plan ? (
        <div className="plan-body">
          <Markdown text={plan} />
        </div>
      ) : (
        <pre>{args.slice(0, 4000)}</pre>
      )}
      <div className="approval-actions">
        <button className="btn-primary" disabled={!armed} onClick={() => answer('allow')}>
          {plan ? 'Approve and start coding' : 'Allow'}
        </button>
        {!plan && (
          <button className="btn-ghost" disabled={!armed} onClick={() => answer('allow_always')}>
            Always allow {a.name}
          </button>
        )}
        <button className="btn-danger" disabled={!armed} onClick={() => answer('deny')}>
          {plan ? 'Keep planning' : 'Deny'}
        </button>
        {!armed && <span className="muted small">read first…</span>}
      </div>
      {error && <p className="small err-text">{error}</p>}
    </div>
  );
}

function PausedBanner({ s, models }: { s: SessionSummary; models: string[] }) {
  const [model, setModel] = useState(models.find((m) => m !== s.model) ?? s.model);
  const quota = s.statusReason === 'quota' || s.statusReason === 'auth';
  const text: Record<string, string> = {
    quota: 'The model quota is exhausted.',
    auth: 'The API key was rejected.',
    rate_limit: 'The provider is rate limiting.',
    network: 'The network or provider is unavailable.',
    max_steps: 'The step limit was reached.',
    interrupted: 'The app stopped during this run.',
  };
  return (
    <div className={`banner ${s.status === 'error' ? 'banner-err' : ''}`}>
      <div>
        <strong>{s.status === 'error' ? 'Run failed' : 'Paused'}</strong> — {text[s.statusReason ?? ''] ?? s.statusReason}{' '}
        <span className="muted">{s.statusDetail?.slice(0, 220)}</span>
        {quota && <div className="muted small">Everything is saved. Resume after topping up, or continue on another model. Auto-resume retries periodically.</div>}
      </div>
      <div className="banner-actions">
        <button className="btn-primary" onClick={() => api.resume(s.id)}>
          Resume
        </button>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => api.resume(s.id, model)}>
          Switch &amp; resume
        </button>
      </div>
    </div>
  );
}

function ChangesPanel({ s, onClose }: { s: SessionSummary; onClose: () => void }) {
  const [status, setStatus] = useState<WorktreeStatus>();
  const [diff, setDiff] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => {
    api.worktreeStatus(s.id).then(setStatus, (e) => setMsg(String(e.message ?? e)));
    api.worktreeDiff(s.id).then(setDiff, () => undefined);
  };
  useEffect(load, [s.id, s.status]);
  const act = async (f: () => Promise<unknown>, done: string) => {
    try {
      await f();
      setMsg(done);
    } catch (e) {
      setMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
  };
  const closed = s.worktree?.closed;
  return (
    <div className="changes">
      <div className="row-between">
        <strong>
          ⑂ {s.worktree?.branch} <span className="muted small">→ {s.worktree?.repo.replace(/^\/Users\/[^/]+/, '~')}</span>
        </strong>
        <button className="btn-ghost small" onClick={onClose}>
          Close
        </button>
      </div>
      {closed ? (
        <p className="muted">This worktree was {closed}.</p>
      ) : (
        <>
          <p className="muted small">
            {status ? `${status.files.length} files · +${status.insertions} −${status.deletions}` : 'Loading…'} · the main checkout is untouched until you merge.
          </p>
          <div className="change-files mono small">
            {status?.files.map((f) => (
              <div key={f.path}>
                <span className={`fs fs-${f.status[0]}`}>{f.status[0]}</span> {f.path}
              </div>
            ))}
          </div>
          {diff && (
            <details>
              <summary className="small">Diff</summary>
              <pre className="diff">{diff.slice(0, 200_000)}</pre>
            </details>
          )}
          <div className="row">
            <button className="btn-primary small" disabled={!status?.files.length} onClick={() => act(() => api.mergeWorktree(s.id, 'squash'), 'Squashed into the main checkout (staged). Review and commit there.')}>
              Merge (squash)
            </button>
            <button className="btn-ghost small" disabled={!status?.files.length} onClick={() => act(() => api.mergeWorktree(s.id, 'merge'), 'Merged with a merge commit.')}>
              Merge commit
            </button>
            <button className="btn-danger small" onClick={() => confirm('Discard all changes in this worktree?') && act(() => api.discardWorktree(s.id), 'Discarded.')}>
              Discard
            </button>
            <button className="btn-ghost small" onClick={load}>
              Refresh
            </button>
          </div>
        </>
      )}
      {msg && <p className="small">{msg}</p>}
    </div>
  );
}

function Todos({ items }: { items: TodoItem[] }) {
  const done = items.filter((i) => i.status === 'done').length;
  return (
    <div className="todos">
      <div className="todos-head">
        Plan <span className="muted">{done}/{items.length}</span>
        <span className="bar">
          <span style={{ width: `${(done / Math.max(1, items.length)) * 100}%` }} />
        </span>
      </div>
      {items.map((i) => (
        <div key={i.id} className={`todo todo-${i.status}`}>
          <span>{i.status === 'done' ? '●' : i.status === 'in_progress' ? '◐' : i.status === 'cancelled' ? '⊘' : '○'}</span> {i.content}
        </div>
      ))}
    </div>
  );
}

/** Deliverables: files the session created or changed, newest first. */
function FilesPanel({ sessionId, version, onClose }: { sessionId: string; version: number; onClose: () => void }) {
  const [files, setFiles] = useState<Awaited<ReturnType<typeof api.deliverables>>>([]);
  useEffect(() => {
    api.deliverables(sessionId).then(setFiles, () => setFiles([]));
  }, [sessionId, version]);
  const size = (n: number) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n > 1e3 ? `${(n / 1e3).toFixed(1)} kB` : `${n} B`);
  return (
    <div className="changes files-panel">
      <div className="row-between">
        <strong>Files from this session</strong>
        <button className="btn-ghost small" onClick={onClose}>
          ✕
        </button>
      </div>
      {!files.length && <p className="muted small">No files yet.</p>}
      {files.map((f) => (
        <div key={f.abs} className="file-row">
          <span className={`tag ${f.created ? 'ok' : ''}`}>{f.created ? 'new' : 'changed'}</span>
          <button className="linklike mono small" title={f.abs} onClick={() => api.openPath(f.abs)}>
            {f.path}
          </button>
          <span className="muted small">{size(f.size)}</span>
        </div>
      ))}
    </div>
  );
}

/** Read a reply with the OS voices (Markdown stripped, long replies cut). */
function speakText(md: string): void {
  const text = md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/[#*_`>|\[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 1500);
  const u = new SpeechSynthesisUtterance(text);
  if (/[\u4e00-\u9fff]/.test(text)) u.lang = 'zh-CN';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** Hold-free voice input: click to record, click again to transcribe into the composer. */
function VoiceButton({ onText }: { onText: (t: string) => void }) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [err, setErr] = useState('');
  const rec = useRef<MediaRecorder | null>(null);
  const start = async () => {
    setErr('');
    try {
      await api.askMicrophone().catch(() => true);
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      const r = new MediaRecorder(stream);
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setState('transcribing');
        const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
        const b64 = btoa(Array.from(new Uint8Array(await blob.arrayBuffer()), (b) => String.fromCharCode(b)).join(''));
        try {
          const text = await api.transcribe(b64, blob.type);
          if (text) onText(text);
        } catch (e) {
          setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
        }
        setState('idle');
      };
      rec.current = r;
      r.start();
      setState('recording');
    } catch (e) {
      setErr(String((e as Error).message ?? e));
    }
  };
  return (
    <>
      {err && <span className="small err-text" title={err}>voice: {err.slice(0, 60)}</span>}
      <button
        className={`btn-ghost small ${state === 'recording' ? 'recording' : ''}`}
        title={state === 'recording' ? 'Stop and transcribe' : 'Voice input'}
        disabled={state === 'transcribing'}
        onClick={() => (state === 'recording' ? rec.current?.stop() : start())}
      >
        {state === 'recording' ? '● Stop' : state === 'transcribing' ? '…' : '🎙'}
      </button>
    </>
  );
}

export function Chat({
  summary,
  approvals,
  onOpen,
  onDeleted,
}: {
  summary: SessionSummary;
  approvals: PendingApproval[];
  onOpen: (id: string) => void;
  onDeleted: () => void;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState('');
  const [input, setInput] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modes, setModes] = useState<{ id: string; label: string }[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [speak, setSpeak] = useState(() => localStorage.getItem('sun.speak') === '1');
  const speakRef = useRef(speak);
  speakRef.current = speak;
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api.getEvents(summary.id).then((snap) =>
      setEvents((live) => {
        const seen = new Set(snap.map((e) => e.seq));
        return [...snap, ...live.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
      }),
    );
    api.listModels().then((ms) => setModels(ms.filter((m) => m.ready).map((m) => m.ref)));
    api.listModes().then(setModes);
  }, [summary.id]);

  // Subscribe directly: every live event must be applied (a shared state value would drop batched updates).
  useEffect(
    () =>
      window.sun.onLive((live: LiveEvent) => {
        if (live.kind === 'event' && live.sessionId === summary.id) {
          setEvents((ev) => (ev.some((e) => e.seq === live.event.seq) ? ev : [...ev, live.event]));
          if (live.event.type === 'assistant/message') {
            if (speakRef.current && live.event.text && !live.event.toolCalls.length) speakText(live.event.text);
            setDraft('');
            setThinking('');
          }
        } else if (live.kind === 'delta' && live.sessionId === summary.id) {
          if (live.text) setDraft((d) => d + live.text);
          if (live.reasoning) setThinking((t) => (t + live.reasoning).slice(-1200));
        }
      }),
    [summary.id],
  );

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [events, draft, thinking, approvals]);

  const results = useMemo(() => {
    const m = new Map<string, ResultEvent>();
    for (const e of events) if (e.type === 'tool/result') m.set(e.callId, e);
    return m;
  }, [events]);
  const todos = useMemo(() => [...events].reverse().find((e) => e.type === 'todo/update') as Extract<SessionEvent, { type: 'todo/update' }> | undefined, [events]);

  const finishedJobs = useMemo(() => new Set(events.filter((e) => e.type === 'job/finished').map((e) => (e as Extract<SessionEvent, { type: 'job/finished' }>).jobId)), [events]);
  const running = summary.status === 'running' || summary.status === 'awaiting_approval';
  const mine = approvals.filter((a) => a.displaySessionId === summary.id);
  const usage = events.reduce((acc, e) => (e.type === 'assistant/message' && e.usage ? acc + e.usage.inputTokens + e.usage.outputTokens : acc), 0);
  const cached = events.reduce((acc, e) => (e.type === 'assistant/message' && e.usage?.cachedTokens ? acc + e.usage.cachedTokens : acc), 0);
  const inputTokens = events.reduce((acc, e) => (e.type === 'assistant/message' && e.usage ? acc + e.usage.inputTokens : acc), 0);
  const undoable = useMemo(() => {
    const undone = new Set(events.filter((e) => e.type === 'checkpoint/undo').map((e) => (e as Extract<SessionEvent, { type: 'checkpoint/undo' }>).id));
    return events.filter((e) => e.type === 'checkpoint' && !undone.has(e.id)).length;
  }, [events]);
  const usesBrowser = useMemo(() => events.some((e) => e.type === 'assistant/message' && e.toolCalls.some((c) => c.name.startsWith('browser_'))), [events]);
  const [undoMsg, setUndoMsg] = useState('');
  const [sandbox, setSandbox] = useState<{ kind: string; description: string }>();
  useEffect(() => {
    api.sandboxInfo(summary.id).then(setSandbox, () => setSandbox(undefined));
  }, [summary.id]);
  const undo = async () => {
    try {
      const r = await api.undo(summary.id, 1);
      setUndoMsg(r.restored.length ? `Restored ${r.restored.map((f) => f.split('/').pop()).join(', ')}` : 'Nothing to undo');
    } catch (e) {
      setUndoMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
    setTimeout(() => setUndoMsg(''), 4000);
  };

  const submit = async () => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    stick.current = true;
    await api.send(summary.id, text);
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <StatusDot s={summary} />
          <h2>{summary.title}</h2>
          <button className="chip mono" title="Open workspace" onClick={() => api.openPath(summary.cwd)}>
            {summary.cwd.replace(/^\/Users\/[^/]+/, '~')}
          </button>
          {sandbox && (
            <span className={`chip mono ${sandbox.kind === 'none' ? 'warn' : ''}`} title={sandbox.description}>
              {sandbox.kind === 'none' ? 'no sandbox' : `⛉ ${sandbox.kind}`}
            </span>
          )}
          {undoable > 0 && (
            <button className={`chip ${showFiles ? 'on' : ''}`} title="Files this session created or changed" onClick={() => setShowFiles(!showFiles)}>
              ▤ Files
            </button>
          )}
          {usesBrowser && (
            <button className={`chip ${showBrowser ? 'on' : ''}`} title="Live view of the agent's browser" onClick={() => setShowBrowser(!showBrowser)}>
              ◎ Browser
            </button>
          )}
          {summary.worktree && (
            <button className={`chip mono branch ${showChanges ? "on" : ""}`} title="Worktree changes" onClick={() => setShowChanges(!showChanges)}>
              ⑂ {summary.worktree.branch}
              {summary.worktree.closed ? ` (${summary.worktree.closed})` : ''}
            </button>
          )}
        </div>
        <div className="chat-controls">
          <select value={summary.mode} onChange={(e) => api.switchMode(summary.id, e.target.value)} title="Mode">
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <select value={summary.model} onChange={(e) => api.switchModel(summary.id, e.target.value)} title="Model">
            {[...new Set([summary.model, ...models])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          {usage > 0 && (
            <span className="muted small mono" title={`${cached} of ${inputTokens} input tokens served from the provider's prompt cache`}>
              {(usage / 1000).toFixed(1)}k tok{cached > 0 ? ` · ${Math.round((cached / Math.max(1, inputTokens)) * 100)}% cached` : ''}
            </span>
          )}
          {undoMsg && <span className="muted small">{undoMsg}</span>}
          <button className="btn-ghost small" title="Undo the last file edit step (checkpoint)" disabled={running || !undoable} onClick={undo}>
            ↶ Undo{undoable ? ` (${undoable})` : ''}
          </button>
          <button
            className="btn-ghost small"
            title="Delete session"
            onClick={async () => {
              if (confirm('Delete this session log?')) {
                await api.deleteSession(summary.id);
                onDeleted();
              }
            }}
          >
            ✕
          </button>
        </div>
      </header>

      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {showChanges && summary.worktree && <ChangesPanel s={summary} onClose={() => setShowChanges(false)} />}
        {showBrowser && <BrowserPanel sessionId={summary.id} onClose={() => setShowBrowser(false)} />}
        {showFiles && <FilesPanel sessionId={summary.id} version={events.length} onClose={() => setShowFiles(false)} />}
        {todos && todos.items.length > 0 && <Todos items={todos.items} />}
        {events.map((e) => {
          switch (e.type) {
            case 'user/message':
              if (e.source === 'job')
                return (
                  <details key={e.seq} className="job-result">
                    <summary>
                      <span className="tool-glyph">⏵</span> {e.text.split('\n')[0].replace(/^\[|\]$/g, '')}
                    </summary>
                    <pre>{e.text.split('\n').slice(1).join('\n')}</pre>
                  </details>
                );
              return e.source === 'hook' ? (
                <div key={e.seq} className="divider">
                  hook context
                </div>
              ) : (
                <div key={e.seq} className={`msg user ${e.source === 'schedule' ? 'scheduled' : ''}`}>
                  {e.source === 'schedule' && <div className="muted small">⏲ scheduled</div>}
                  <Markdown text={e.text} />
                </div>
              );
            case 'assistant/message':
              return (
                <div key={e.seq} className="msg assistant">
                  {e.reasoning && (
                    <details className="reasoning">
                      <summary>Reasoning</summary>
                      <p>{e.reasoning}</p>
                    </details>
                  )}
                  {e.text && <Markdown text={e.text} />}
                  {e.toolCalls.map((c) => (
                    <ToolCard key={c.id} call={c} result={results.get(c.id)} pending={running} />
                  ))}
                </div>
              );
            case 'model/switch':
              return (
                <div key={e.seq} className="divider">
                  model {e.from} → {e.to}
                </div>
              );
            case 'mode/switch':
              return (
                <div key={e.seq} className="divider">
                  mode {e.from} → {e.to}
                </div>
              );
            case 'job/started':
              return (
                <div key={e.seq} className="job-line">
                  <span className={`dot ${finishedJobs.has(e.jobId) ? 'dot-off' : 'dot-running'}`} />
                  <span className="mono small">{e.jobId}</span>
                  <span className="mono small muted job-cmd">{e.command}</span>
                  {!finishedJobs.has(e.jobId) && (
                    <button className="btn-ghost small" onClick={() => api.killJob(e.jobId)}>
                      Stop
                    </button>
                  )}
                </div>
              );
            case 'job/finished':
              return (
                <div key={e.seq} className="divider">
                  {e.jobId} {e.state}
                  {e.exitCode !== undefined ? ` · exit ${e.exitCode}` : ''}
                </div>
              );
            case 'verify/result':
              return (
                <details key={e.seq} className={`verify-line ${e.passed ? 'ok' : 'bad'}`}>
                  <summary>
                    {e.passed ? '✓ verified' : '✗ verification failed'} <span className="mono small muted">{e.results.map((r) => r.command).join(' && ')}</span>
                  </summary>
                  <pre>{e.results.map((r) => `$ ${r.command}  (exit ${r.code})\n${r.output}`).join('\n\n').slice(-6000)}</pre>
                </details>
              );
            case 'browser/takeover':
              return (
                <div key={e.seq} className="divider">
                  {e.on ? 'you took over the browser' : 'browser handed back to the agent'}
                </div>
              );
            case 'checkpoint/undo':
              return (
                <div key={e.seq} className="divider">
                  undo {e.id} · restored {e.restored.length} file{e.restored.length === 1 ? '' : 's'}
                </div>
              );
            case 'context/compaction':
              return (
                <div key={e.seq} className="divider" title={e.summary}>
                  context compacted
                </div>
              );
            default:
              return null;
          }
        })}
        {(draft || thinking) && (
          <div className="msg assistant streaming">
            {thinking && !draft && <p className="thinking">{thinking.slice(-400)}</p>}
            {draft && <Markdown text={draft} />}
          </div>
        )}
        {running && !draft && !thinking && !mine.length && <div className="pulse">working</div>}
        {mine.map((a) => (
          <ApprovalCard key={a.callId} a={a} />
        ))}
        {(summary.status === 'paused' || summary.status === 'error') && <PausedBanner s={summary} models={models} />}
        {summary.parent && (
          <button className="chip" onClick={() => onOpen(summary.parent!)}>
            ← back to parent session
          </button>
        )}
      </div>

      <div className="composer">
        <textarea
          value={input}
          placeholder={running ? 'Queue a follow-up… (sent when the current run ends)' : `Message ${MODE_META[summary.mode]?.label ?? summary.mode}… (Enter to send, Shift+Enter for newline)`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          rows={Math.min(8, Math.max(2, input.split('\n').length))}
        />
        <div className="composer-actions">
          <VoiceButton onText={(t) => setInput((v) => (v ? `${v} ${t}` : t))} />
          <button
            className={`btn-ghost small ${speak ? 'on' : ''}`}
            title={speak ? 'Stop reading replies aloud' : 'Read replies aloud'}
            onClick={() => {
              localStorage.setItem('sun.speak', speak ? '0' : '1');
              if (speak) speechSynthesis.cancel();
              setSpeak(!speak);
            }}
          >
            {speak ? '🔊' : '🔈'}
          </button>
          {running ? (
            <button className="btn-danger" onClick={() => api.abort(summary.id)}>
              ■ Stop
            </button>
          ) : (
            <button className="btn-primary" onClick={submit} disabled={!input.trim()}>
              Send ↵
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
