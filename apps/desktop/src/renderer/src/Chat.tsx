import type { AppshotMetadata, CapabilityStatus } from '@sun/core';
import { describeSchedule, fmtDate, locale, t, tk } from './i18n';
import type { LiveEvent, PendingApproval, ReviewSeverity, SessionEvent, SessionSummary, TodoItem, ToolCall, WorktreeStatus } from '@sun/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppshotDispatch } from './api';
import { api } from './api';
import { VoiceCapture, type VoiceIssue, type VoiceState } from './voice-capture';
import { modeLabel, StatusDot } from './App';
import { Markdown } from './markdown';
import { SessionDock, type DockPaneId } from './Dock';
import { Composer } from './Composer';
import { ContextPanel, ContextRing } from './Context';
import { hookEventLabel, hookRunLabel } from './settings/HooksPanel';
import { TurnChanges } from './Changes';
import { ReviewCard } from './Review';
import { worktreeError } from './settings/WorktreesPanel';

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

/** Colored unified diff; compact shows the first changed lines only. */
function DiffView({ diff, compact }: { diff: string; compact?: boolean }) {
  const lines = diff.split('\n').filter((l) => !/^(---|\+\+\+) /.test(l));
  const added = lines.filter((l) => l.startsWith('+')).length;
  const removed = lines.filter((l) => l.startsWith('-')).length;
  const shown = compact ? lines.filter((l) => /^[+-]/.test(l)).slice(0, 8) : lines;
  return (
    <div className={`diff ${compact ? 'compact' : ''}`}>
      <div className="diff-stat mono small">
        <span className="add">+{added}</span> <span className="del">−{removed}</span>
      </div>
      <pre>
        {shown.map((l, i) => (
          <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>
            {l}
            {'\n'}
          </span>
        ))}
        {compact && lines.filter((l) => /^[+-]/.test(l)).length > 8 ? '…\n' : ''}
      </pre>
    </div>
  );
}

/** ChatGPT Tasks-style confirmation: the schedule found in the message, editable before creating. */
function ProposalCard({ sessionId, p, resolved }: { sessionId: string; p: Extract<SessionEvent, { type: 'automation/proposal' }>; resolved?: Extract<SessionEvent, { type: 'automation/resolved' }> }) {
  const [schedule, setSchedule] = useState(p.description);
  const [title, setTitle] = useState(p.title);
  const [preview, setPreview] = useState<{ description: string; next: string[]; cron?: string; at?: string } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => api.previewSchedule(schedule).then((r) => setPreview(r ?? null), () => setPreview(null)), 250);
    return () => clearTimeout(timer);
  }, [schedule]);
  if (resolved)
    return (
      <div className="divider">
        {resolved.action === 'run' ? t('answered now (not scheduled)') : `⏲ ${resolved.action === 'both' ? t('automation created and answered now') : t('automation created')}`}
      </div>
    );
  const act = async (action: 'create' | 'run' | 'both') => {
    try {
      await api.resolveProposal(sessionId, p.proposalId, action, action === 'run' ? undefined : { title, schedule: schedule !== p.description ? schedule : undefined });
    } catch (e) {
      setErr(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
  };
  return (
    <div className="proposal">
      <div className="approval-head">
        <span className="risk">{t("⏲ automation")}</span>
        <strong>{t("Schedule this?")}</strong>
      </div>
      <label className="small">
        {t("Title")}
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="small">
        {t("When (plain language or cron)")}
        <input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
      </label>
      <p className="muted small">
        {preview ? `${describeSchedule(preview)} · ${t('next:')} ${preview.next.slice(0, 3).map(fmtDate).join(' · ')}` : t("Not understood yet — try “every weekday at 9:00”, “每天晚上8点”, “tomorrow at 15:00”.")}
      </p>
      <p className="small">
        {t("Prompt:")} <span className="mono">{p.prompt}</span>
      </p>
      <div className="approval-actions">
        <button className="btn-primary" disabled={!preview} onClick={() => void act('create')}>
          {t("Create automation")}
        </button>
        <button className="btn-ghost" disabled={!preview} onClick={() => void act('both')}>
          {t("Create & run now")}
        </button>
        <button className="btn-ghost" onClick={() => void act('run')}>
          {t("Just answer now")}
        </button>
      </div>
      {err && <p className="small err-text">{err}</p>}
    </div>
  );
}

function AttachmentThumb({ path, appshot }: { path: string; appshot?: AppshotMetadata }) {
  const [src, setSrc] = useState<string>();
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    let active = true;
    api.readAttachment(path, appshot).then(
      a => { if (active) setSrc(`data:${a.mime};base64,${a.data}`); },
      () => { if (active) setMissing(true); },
    );
    return () => { active = false; };
  }, [path, appshot?.sha256]);
  return src ? <img className="thumb-img" src={src} alt={t('attachment')} title={appshot?.title} />
    : <span className="chip small">{missing && appshot ? t('Appshot attachment unavailable') : t('image')}</span>;
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
      {!open && result?.diff && <DiffView diff={result.diff} compact />}
      {open && (
        <div className="tool-body">
          {result?.diff && <DiffView diff={result.diff} />}
          <div className="tool-label">{t("arguments")}</div>
          <pre>{(() => {
            try {
              return JSON.stringify(JSON.parse(call.arguments || '{}'), null, 2);
            } catch {
              return call.arguments;
            }
          })()}</pre>
          {result && (
            <>
              <div className="tool-label">{result.isError ? t("error") : t("output")}</div>
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
        <span className="risk">{plan ? t('plan') : t(a.risk)}</span>
        {plan ? <strong>{t('Review the plan')}</strong> : <><strong>{a.name}</strong> {t('wants to run')}</>}
        {a.sessionId !== a.displaySessionId ? ` ${t('(from a subagent)')}` : ''}
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
          {plan ? t("Approve and start coding") : t("Allow")}
        </button>
        {!plan && (
          <button className="btn-ghost" disabled={!armed} onClick={() => answer('allow_always')}>
            {t('Always allow {tool}', { tool: a.name })}
          </button>
        )}
        <button className="btn-danger" disabled={!armed} onClick={() => answer('deny')}>
          {plan ? t("Keep planning") : t("Deny")}
        </button>
        {!armed && <span className="muted small">{t("read first…")}</span>}
      </div>
      {error && <p className="small err-text">{error}</p>}
    </div>
  );
}

function PausedBanner({ s, models }: { s: SessionSummary; models: string[] }) {
  const [model, setModel] = useState(models.find((m) => m !== s.model) ?? s.model);
  const quota = s.statusReason === 'quota' || s.statusReason === 'auth';
  const text: Record<string, string> = {
    quota: t('The model quota is exhausted.'),
    auth: t('The API key was rejected.'),
    rate_limit: t('The provider is rate limiting.'),
    network: t('The network or provider is unavailable.'),
    max_steps: t('The step limit was reached.'),
    interrupted: t('The app stopped during this run.'),
    review_required: t('Completion requires a current review with no findings and no omitted changes.'),
  };
  return (
    <div className={`banner ${s.status === 'error' ? 'banner-err' : ''}`}>
      <div>
        <strong>{s.status === 'error' ? t("Run failed") : t("Paused")}</strong> — {text[s.statusReason ?? ''] ?? s.statusReason}{' '}
        {s.statusReason !== 'review_required' && <span className="muted">{s.statusDetail?.slice(0, 220)}</span>}
        {quota && <div className="muted small">{t("Everything is saved. Resume after topping up, or continue on another model. Auto-resume retries periodically.")}</div>}
      </div>
      <div className="banner-actions">
        <button className="btn-primary" onClick={() => api.resume(s.id)}>
          {t("Resume")}
        </button>
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
        <button className="btn-ghost" onClick={() => api.resume(s.id, model)}>
          {t('Switch & resume')}
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
  const act = async <T,>(f: () => Promise<T>, done: (result: T) => string) => {
    try {
      setMsg(done(await f()));
      load();
    } catch (e) {
      setMsg(worktreeError(e));
    }
  };
  const closed = s.worktree?.closed;
  return (
    <div className="changes" data-worktree={closed ?? 'open'}>
      <div className="row-between">
        <strong>
          ⑂ {s.worktree?.branch} <span className="muted small">→ {s.worktree?.repo.replace(/^\/Users\/[^/]+/, '~')}</span>
        </strong>
        <button className="btn-ghost small" onClick={onClose}>
          {t("Close")}
        </button>
      </div>
      {closed ? (
        <p className="muted">{closed === 'merged' ? t('This worktree was merged.') : closed === 'discarded' ? t('This worktree was discarded.') : t('This worktree was {state}.', { state: t(closed) })}</p>
      ) : (
        <>
          <p className="muted small">
            {status ? `${t('{n} files', { n: status.files.length })} · +${status.insertions} −${status.deletions}` : t('Loading…')} · {t('the main checkout is untouched until you merge.')}
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
              <summary className="small">{t("Diff")}</summary>
              <pre className="diff">{diff.slice(0, 200_000)}</pre>
            </details>
          )}
          <div className="row">
            <button className="btn-primary small" data-action="squash" disabled={!status?.files.length} onClick={() => act(() => api.mergeWorktree(s.id, 'squash'), result => result.cleanup === 'retained'
              ? t('Merged. The worktree was retained for inspection.') : t('Squashed into the main checkout (staged). Review and commit there.'))}>
              {t("Merge (squash)")}
            </button>
            <button className="btn-ghost small" disabled={!status?.files.length} onClick={() => act(() => api.mergeWorktree(s.id, 'merge'), result => result.cleanup === 'retained'
              ? t('Merged. The worktree was retained for inspection.') : t('Merged with a merge commit.'))}>
              {t("Merge commit")}
            </button>
            <button className="btn-danger small" onClick={() => confirm(t('Remove this clean worktree? Unmerged commits will be kept.')) &&
              act(() => api.discardWorktree(s.id), result => result.branchKept ? t('Worktree removed. The branch was kept.') : t('Discarded.'))}>
              {t("Discard")}
            </button>
            <button className="btn-ghost small" onClick={load}>
              {t("Refresh")}
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
        {t("Plan")} <span className="muted">{done}/{items.length}</span>
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

/** Read a reply with the OS voices (Markdown stripped, long replies cut). */
function speakText(md: string): void {
  const text = md
    .replace(/```[\s\S]*?```/g, ' (code) ')
    .replace(/[#*_`>|\[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 1500);
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return;
  const u = new SpeechSynthesisUtterance(text);
  if (/[\u4e00-\u9fff]/.test(text)) u.lang = 'zh-CN';
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}

/** Recording stays local until the user chooses Stop and transcribe. */
function VoiceButton({ onText }: { onText: (value: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle');
  const [issue, setIssue] = useState<VoiceIssue>();
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const [capture] = useState(() => new VoiceCapture({
    ask: api.askMicrophone,
    open: () => {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('Microphone unavailable', 'NotFoundError');
      return navigator.mediaDevices.getUserMedia({ audio: true });
    },
    record: stream => new MediaRecorder(stream),
    transcribe: api.transcribe,
    cancel: api.cancelTranscription,
    id: () => crypto.randomUUID(),
  }, (next, error) => { setState(next); setIssue(error); }, value => onTextRef.current(value)));
  useEffect(() => () => capture.cancel(false), [capture]);
  return (
    <>
      {issue && <span role="status" className="small err-text">{issue === 'denied'
        ? t('Microphone permission was denied. You can still type your message.')
        : issue === 'unavailable' ? t('No microphone is available. You can still type your message.')
        : t('Voice input failed. You can still type your message.')}</span>}
      {state === 'idle' && <button type="button" className="btn-ghost small" title={t('Voice input')} onClick={() => void capture.start()}>🎙</button>}
      {state === 'requesting' && <span role="status" className="small">{t('Waiting for microphone access…')}</span>}
      {state === 'recording' && <button type="button" className="btn-ghost small recording" title={t('Stop and transcribe')} onClick={() => capture.finish()}>{t('● Stop')}</button>}
      {state === 'transcribing' && <span role="status" className="small">{t('Transcribing…')}</span>}
      {state !== 'idle' && <button type="button" className="btn-ghost small" onClick={() => capture.cancel()}>{t('Cancel voice input')}</button>}
    </>
  );
}

function ComputerStop() {
  const [owner, setOwner] = useState<Awaited<ReturnType<typeof api.computerOwner>>>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    const poll = () => { void api.computerOwner().then(value => { if (current) setOwner(value); }, () => undefined); };
    poll();
    const timer = setInterval(poll, 1000);
    return () => { current = false; clearInterval(timer); };
  }, []);
  if (!owner) return null;
  return <span className="row">
    <span className="small muted">{t('Computer control assigned to {app}.', { app: owner.appId })}</span>
    <button type="button" className="btn-ghost small" onClick={() => {
      void api.stopComputerUse().then(() => setOwner(undefined), () => setFailed(true));
    }}>{t('Stop computer control')}</button>
    {failed && <span role="status">{t('Computer control could not be stopped.')}</span>}
  </span>;
}

export function Chat({
  summary,
  approvals,
  onOpen,
  onManageStorage,
  voiceEnabled,
  appshotCapability,
  computerAvailable,
  shortcutAppshot,
  onShortcutAppshot,
  readAloud,
  onReadAloud,
  refresh,
  reviewSeverity,
}: {
  summary: SessionSummary;
  approvals: PendingApproval[];
  voiceEnabled: boolean;
  appshotCapability?: CapabilityStatus;
  computerAvailable?: boolean;
  shortcutAppshot?: AppshotDispatch;
  onShortcutAppshot(): void;
  readAloud: boolean;
  onReadAloud: (enabled: boolean) => void;
  onOpen: (id: string) => void;
  onManageStorage: () => void;
  refresh: number;
  reviewSeverity: ReviewSeverity;
}) {
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const latestReview = events.findLast(event => event.type === 'review/report')?.seq;
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState('');
  const [inject, setInject] = useState<{ text: string; n: number; replace?: boolean } | undefined>(() => {
    const p = sessionStorage.getItem(`sun.prefill.${summary.id}`);
    if (p !== null) sessionStorage.removeItem(`sun.prefill.${summary.id}`);
    return p !== null ? { text: p, n: 1, replace: true } : undefined;
  });
  const [models, setModels] = useState<string[]>([]);
  const [modes, setModes] = useState<{ id: string; label: string }[]>([]);
  const [showChanges, setShowChanges] = useState(false);
  const [showOut, setShowOut] = useState(false);
  const [dockPane, setDockPane] = useState<DockPaneId | null>(null);
  const [outs, setOuts] = useState<{ path: string; abs: string; size: number }[]>([]);
  const [showContext, setShowContext] = useState(false);
  /** run/status seq → seq of the message that started the turn, for turns that edited files. */
  const turnStarts = useMemo(() => {
    const m = new Map<number, number>();
    let start: number | undefined;
    let edited = false;
    for (const e of events) {
      if (e.type === 'user/message' && e.source !== 'memory' && e.source !== 'hook' && e.source !== 'verify') {
        if (start === undefined || !edited) start = e.seq;
      } else if (e.type === 'checkpoint') edited = true;
      else if (e.type === 'run/status' && ['idle', 'aborted', 'paused', 'error'].includes(e.status) && start !== undefined) {
        if (edited) m.set(e.seq, start);
        start = undefined;
        edited = false;
      }
    }
    return m;
  }, [events]);
  const resolvedProposals = useMemo(() => new Map(events.filter((e) => e.type === 'automation/resolved').map((e) => [(e as { proposalId: string }).proposalId, e as Extract<SessionEvent, { type: 'automation/resolved' }>])), [events]);
  const lastMessage = useMemo(() => {
    const u = [...events].reverse().find((e) => e.type === 'user/message' && (!e.source || e.source === 'user')) as Extract<SessionEvent, { type: 'user/message' }> | undefined;
    return u ? (u.command?.input ?? u.text.replace(/\n\n<attached (file|dir)="[^"]*">[\s\S]*?<\/attached>/g, '')) : undefined;
  }, [events]);
  useEffect(() => {
    if (showOut) api.deliverables(summary.id).then(setOuts, () => setOuts([]));
  }, [showOut, summary.id, events.length]);
  const speakRef = useRef(readAloud);
  speakRef.current = readAloud;
  useEffect(() => {
    if (!readAloud && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
  }, [readAloud]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    api.getEvents(summary.id).then((snap) =>
      setEvents((live) => {
        const seen = new Set(snap.map((e) => e.seq));
        return [...snap, ...live.filter((e) => !seen.has(e.seq))].sort((a, b) => a.seq - b.seq);
      }), () => undefined,
    );
    api.listModels().then((ms) => setModels(ms.filter((m) => m.ready).map((m) => m.ref)), () => undefined);
    api.listModes().then(setModes, () => undefined);
  }, [summary.id, refresh]);

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
  const [undoMsg, setUndoMsg] = useState('');
  const [sandbox, setSandbox] = useState<{ kind: string; description: string }>();
  useEffect(() => {
    api.sandboxInfo(summary.id).then(setSandbox, () => setSandbox(undefined));
  }, [summary.id]);
  const undo = async () => {
    try {
      const r = await api.undo(summary.id, 1);
      setUndoMsg(r.restored.length ? t('Restored {files}', { files: r.restored.map((f) => f.split('/').pop()).join(', ') }) : t('Nothing to undo'));
    } catch (e) {
      setUndoMsg(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
    setTimeout(() => setUndoMsg(''), 4000);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !running || document.querySelector('.palette')) return;
      if ((e.target as HTMLElement)?.closest?.('.composer')) return; // the composer handles its own Esc
      void api.abort(summary.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, summary.id]);
  const [notice, setNotice] = useState('');
  const [costUsd, setCostUsd] = useState<number>();
  useEffect(() => {
    if (!running) api.cost(summary.id).then((c) => setCostUsd(c.unpriced.length ? undefined : c.usd), () => undefined);
  }, [summary.id, running, events.length]);
  const flash = (text: string) => {
    setNotice(text);
    setTimeout(() => setNotice(''), 5000);
  };
  const download = (name: string, text: string, type: string) => {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const exportAs = async (format: 'markdown' | 'html' | 'jsonl') => {
    const text = await api.exportSession(summary.id, format);
    download(`${summary.title.replace(/[^\w-]+/g, '-').slice(0, 50) || summary.id}.${format === 'markdown' ? 'md' : format}`, text, format === 'html' ? 'text/html' : 'text/plain');
  };
  const localCommand = async (cmd: string): Promise<boolean> => {
    if (cmd.startsWith('/compact')) {
      flash((await api.compact(summary.id).catch((e) => (flash(String(e.message ?? e)), false))) ? t('Older history compacted into a summary.') : t('Nothing to compact yet.'));
      return true;
    }
    if (cmd.startsWith('/review')) {
      flash(t('Reviewing…'));
      const text = await api.reviewSession(summary.id).catch((e) => String((e as Error).message ?? e));
      flash(text === 'No file changes to review.' ? t('No file changes to review.') : t('Review'));
      return true;
    }
    if (cmd.startsWith('/cost')) {
      const c = await api.cost(summary.id);
      flash(
        c.byModel
          .map((m) => `${m.model}: ${t('{input}k in ({pct}% cached), {output}k out', { input: (m.input / 1000).toFixed(1), pct: Math.round((m.cached / Math.max(1, m.input)) * 100), output: (m.output / 1000).toFixed(1) })} · ${m.usd !== undefined ? `$${m.usd.toFixed(4)}` : t('Unknown price')}`)
          .join(' · ') || t('No usage yet.'),
      );
      return true;
    }
    if (cmd.startsWith('/export')) {
      const f = cmd.split(/\s+/)[1] ?? 'markdown';
      await exportAs(f.startsWith('h') ? 'html' : f.startsWith('j') ? 'jsonl' : 'markdown');
      return true;
    }
    return false;
  };
  const rewind = async (seq: number) => {
    const files = confirm(t('Rewind to before this message?\n\nOK: also undo the file edits made from here on.\nCancel: conversation only (files stay as they are).'));
    try {
      const r = await api.fork(summary.id, seq, files);
      sessionStorage.setItem(`sun.prefill.${r.session.id}`, r.text);
      onOpen(r.session.id);
    } catch (e) {
      flash(String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, ''));
    }
  };

  return (
    <div className="chat">
      <header className="chat-head">
        <div className="chat-title">
          <StatusDot s={summary} />
          <h2>{summary.title}</h2>
          <button className="chip mono" title={t("Open workspace")} onClick={() => api.openPath(summary.cwd)}>
            {summary.cwd.replace(/^\/Users\/[^/]+/, '~')}
          </button>
          {summary.worktree && (
            <button className={`chip mono branch ${showChanges ? "on" : ""}`} title={t("Worktree changes")} onClick={() => setShowChanges(!showChanges)}>
              ⑂ {summary.worktree.branch}
              {summary.worktree.closed ? ` (${t(summary.worktree.closed)})` : ''}
            </button>
          )}
        </div>
        <div className="chat-controls">
          <select value={summary.mode} onChange={(e) => api.switchMode(summary.id, e.target.value)} title={t("Mode")}>
            {modes.map((m) => (
              <option key={m.id} value={m.id}>
                {modeLabel(m.id)}
              </option>
            ))}
          </select>
          <select value={summary.model} onChange={(e) => api.switchModel(summary.id, e.target.value)} title={t("Model")}>
            {[...new Set([summary.model, ...models])].map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
          <button type="button" className="btn-ghost small" onClick={onManageStorage}>{t('Manage session storage')}</button>
        </div>
      </header>
      <div className="chat-split">
      <div className="chat-main">
      <div className="chat-subbar">
        {computerAvailable && <ComputerStop />}
        {sandbox && (
          <span className={`chip mono ${sandbox.kind === 'none' ? 'warn' : ''}`} title={sandbox.description}>
            {sandbox.kind === 'none' ? t("no sandbox") : `⛉ ${sandbox.kind}`}
          </span>
        )}
        {undoable > 0 && (
          <button className={`chip ${dockPane === 'changes' ? 'on' : ''}`} title={t("Files this session created or changed")} onClick={() => setDockPane(dockPane === 'changes' ? null : 'changes')}>
            {t("▤ Changes")}
          </button>
        )}
        <button className="chip" title={t("Review the changes in this session")} disabled={running} onClick={() => void localCommand('/review')}>
          {t("Review")}
        </button>
        <button className={`chip ${showOut ? 'on' : ''}`} title={t("Files this session produced")} onClick={() => setShowOut(!showOut)}>
          {t("Deliverables")}
        </button>
          <button className={`chip ${dockPane === 'browser' ? 'on' : ''}`} title={t("Live view of the agent's browser")} onClick={() => setDockPane(dockPane === 'browser' ? null : 'browser')}>
            {t("◎ Browser")}
          </button>
        <ContextRing used={summary.contextTokens} window={summary.contextWindow} active={showContext} onClick={() => setShowContext(!showContext)} />
        <span className="spacer" />
        {notice && <span className="small notice">{notice}</span>}
        {costUsd !== undefined && costUsd > 0 && (
          <span className="muted small mono" title={t("Estimated from logged usage and the pricing table (config.pricing)")}>
            ${costUsd < 0.01 ? costUsd.toFixed(4) : costUsd.toFixed(2)}
          </span>
        )}
        <select className="small" value="" title={t("Export this session")} onChange={(e) => e.target.value && void exportAs(e.target.value as 'markdown')}>
          <option value="">{t("Export…")}</option>
          <option value="markdown">{t('Markdown')}</option>
          <option value="html">{t('HTML')}</option>
          <option value="jsonl">{t("JSONL (re-importable)")}</option>
        </select>
        {usage > 0 && (
          <span className="muted small mono" title={t("{cached} of {input} input tokens served from the provider's prompt cache", { cached, input: inputTokens })}>
            {t('{n}k tok', { n: (usage / 1000).toFixed(1) })}
            {cached > 0 ? ` · ${t('{pct}% cached', { pct: Math.round((cached / Math.max(1, inputTokens)) * 100) })}` : ''}
          </span>
        )}
        {undoMsg && <span className="muted small">{undoMsg}</span>}
        <button className="btn-ghost small" title={t("Undo the last file edit step (checkpoint)")} disabled={running || !undoable} onClick={undo}>
          {t("↶ Undo")}{undoable ? ` (${undoable})` : ''}
        </button>
      </div>
      {(showContext || showOut || (showChanges && summary.worktree)) && (
        <div className="chat-panels">
          {showContext && <ContextPanel sessionId={summary.id} version={events.length} onClose={() => setShowContext(false)} onCompacted={flash} />}
          {showChanges && summary.worktree && <ChangesPanel s={summary} onClose={() => setShowChanges(false)} />}
          {showOut && (
            <div className="changes">
              <div className="card-head">
                <strong>{t("Deliverables")}</strong>
                <button className="btn-ghost small" onClick={() => setShowOut(false)}>{t("Close")}</button>
              </div>
              {!outs.length && <p className="muted small">{t("No deliverables yet.")}</p>}
              {outs.map((f) => (
                <div key={f.abs} className="item">
                  <button className="link small mono" onClick={() => api.openPath(f.abs)}>{f.path}</button>
                  <span className="muted small">{t('{n} kB', { n: Math.max(1, Math.round(f.size / 1000)) })}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {todos && todos.items.length > 0 && <Todos items={todos.items} />}
      <div
        className="transcript"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
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
                  {t("hook context")}
                </div>
              ) : (
                <div key={e.seq} className={`msg user ${e.source === 'schedule' ? 'scheduled' : ''}`}>
                  {e.source === 'schedule' && <div className="muted small">{t("⏲ scheduled")}</div>}
                  {e.source === 'memory' && <div className="muted small">{t("✧ recalled memories")}</div>}
                  {e.command && <div className="muted small mono">/{e.command.name}</div>}
                  <Markdown text={e.command ? e.command.input : e.text.replace(/\n\n<attached (file|dir)="[^"]*">[\s\S]*?<\/attached>/g, (_m, _k) => '')} />
                  {(e.text.match(/<attached (?:file|dir)="([^"]*)"/g) ?? []).map((m) => (
                    <span key={m} className="chip mono small">@{m.replace(/^<attached (?:file|dir)="|"$/g, '')}</span>
                  ))}
                  {e.images && e.images.length > 0 && (
                    <div className="thumbs">
                      {e.images.map((im) => (
                        <AttachmentThumb key={im.path} path={im.path} appshot={im.appshot} />
                      ))}
                    </div>
                  )}
                  {(!e.source || e.source === 'user') && !running && (
                    <button className="rewind" title={t("Rewind: new session from before this message (optionally undo file edits)")} onClick={() => rewind(e.seq)}>
                      {t("↶ Rewind")}
                    </button>
                  )}
                </div>
              );
            case 'assistant/message':
              return (
                <div key={e.seq} className="msg assistant">
                  {e.reasoning && (
                    <details className="reasoning">
                      <summary>{t("Reasoning")}</summary>
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
                  {t('model')} {e.from} → {e.to}
                </div>
              );
            case 'mode/switch':
              return (
                <div key={e.seq} className="divider">
                  {t('mode')} {modeLabel(e.from)} → {modeLabel(e.to)}
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
                      {t("Stop")}
                    </button>
                  )}
                </div>
              );
            case 'job/finished':
              return (
                <div key={e.seq} className="divider">
                  {e.jobId} {t(e.state)}
                  {e.exitCode !== undefined ? ` · ${t('exit {code}', { code: e.exitCode })}` : ''}
                </div>
              );
            case 'verify/result':
              return (
                <details key={e.seq} className={`verify-line ${e.passed ? 'ok' : 'bad'}`}>
                  <summary>
                    {e.passed ? t("✓ verified") : t("✗ verification failed")} <span className="mono small muted">{e.results.map((r) => r.command).join(' && ')}</span>
                  </summary>
                  <pre>{e.results.map((r) => `$ ${r.command}  (exit ${r.code})\n${r.output}`).join('\n\n').slice(-6000)}</pre>
                </details>
              );
            case 'browser/takeover':
              return (
                <div key={e.seq} className="divider">
                  {e.on ? t("you took over the browser") : t("browser handed back to the agent")}
                </div>
              );
            case 'hook/run':
              return e.state === 'completed' && (e.code === 0 || e.code === 2) ? null : (
                <div key={e.seq} className="divider">
                  {t('Hook {event} · {state} · exit {code}', { event: hookEventLabel(e.event), state: hookRunLabel(e.state), code: e.code })}
                </div>
              );
            case 'run/status': {
              const from = turnStarts.get(e.seq);
              return from !== undefined ? <TurnChanges key={e.seq} sessionId={summary.id} fromSeq={from} toSeq={e.seq} running={running} /> : null;
            }
            case 'automation/proposal':
              return <ProposalCard key={e.seq} sessionId={summary.id} p={e} resolved={resolvedProposals.get(e.proposalId)} />;
            case 'automation/resolved':
              return null;
            case 'file/revert':
              return (
                <div key={e.seq} className="divider">
                  {t("reverted")} {e.path}
                </div>
              );
            case 'checkpoint/undo':
              return (
                <div key={e.seq} className="divider">
                  {t('undo')} {e.id} · {e.restored.length === 1 ? t('restored 1 file') : t('restored {n} files', { n: e.restored.length })}
                </div>
              );
            case 'context/compaction':
              return (
                <div key={e.seq} className="divider" title={e.summary}>
                  {t("context compacted")}
                </div>
              );
            case 'review/report':
              if (e.review) return <ReviewCard key={e.seq} sessionId={summary.id} report={e.review}
                latest={e.seq === latestReview} changed={summary.updatedAt} minimumSeverity={reviewSeverity} />;
              return (
                <div key={e.seq} className="msg assistant review">
                  <div className="tool-label">{t('Review')}</div>
                  <Markdown text={e.text} />
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
        {running && !draft && !thinking && !mine.length && <div className="pulse">{t("working")}</div>}
        {mine.map((a) => (
          <ApprovalCard key={a.callId} a={a} />
        ))}
        {(summary.status === 'paused' || summary.status === 'error') && <PausedBanner s={summary} models={models} />}
        {summary.parent && (
          <button className="chip" onClick={() => onOpen(summary.parent!)}>
            {t("← back to parent session")}
          </button>
        )}
      </div>

      <Composer
        sessionId={summary.id}
        appshotCapability={appshotCapability}
        shortcutAppshot={shortcutAppshot}
        onShortcutAppshot={onShortcutAppshot}
        cwd={summary.cwd}
        running={running}
        inject={inject}
        placeholder={running ? t('Queue a follow-up… (sent when the current run ends)') : t('Message {mode}… (@ file, / command, paste images · Enter to send)', { mode: modeLabel(summary.mode) })}
        onSend={async (text, images, appshot) => {
          stick.current = true;
          if (appshot) await api.sendAppshotMessage(summary.id, text, images, appshot);
          else await api.sendMessage(summary.id, text, images);
        }}
        onLocalCommand={localCommand}
        onAbort={() => api.abort(summary.id)}
        lastMessage={lastMessage}
        extra={
          <>
            {voiceEnabled && <VoiceButton onText={text => setInject({ text, n: Date.now() })} />}
            <button
              className={`btn-ghost small ${readAloud ? 'on' : ''}`}
              title={readAloud ? t("Stop reading replies aloud") : t("Read replies aloud")}
              onClick={() => onReadAloud(!readAloud)}
            >
              {readAloud ? '🔊' : '🔈'}
            </button>
          </>
        }
      />
      </div>
      <SessionDock summary={summary} events={events} running={running} pane={dockPane} onPane={setDockPane} />
      </div>
    </div>
  );
}
