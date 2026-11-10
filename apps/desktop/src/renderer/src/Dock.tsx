import { t, tk } from './i18n';
import { useEffect, useState } from 'react';
import type { FileChange, SessionEvent, SessionSummary } from '@sun/core';
import { api } from './api';
import { BrowserPanel } from './Browser';
import { ChangesView } from './Changes';

/**
 * Right-hand workspace panes, Cursor Agents Window style.
 * Add a pane by appending to DOCK_PANES and a branch in DockBody. The switcher renders the list; it does not know the pane internals.
 */
export const DOCK_PANES = [
  { id: 'changes', label: tk('Changes') },
  { id: 'browser', label: tk('Browser') },
  { id: 'terminal', label: tk('Terminal') },
  { id: 'files', label: tk('Files') },
] as const;

export type DockPaneId = (typeof DOCK_PANES)[number]['id'];

export function SessionDock({
  summary,
  events,
  running,
  pane,
  onPane,
}: {
  summary: SessionSummary;
  events: SessionEvent[];
  running: boolean;
  pane: DockPaneId | null;
  onPane: (id: DockPaneId | null) => void;
}) {
  const [stats, setStats] = useState({ add: 0, del: 0 });
  const folder = summary.cwd.split('/').filter(Boolean).pop() ?? summary.cwd;
  useEffect(() => {
    api.sessionChanges(summary.id).then(
      (list: FileChange[]) => setStats({ add: list.reduce((n, c) => n + c.additions, 0), del: list.reduce((n, c) => n + c.deletions, 0) }),
      () => setStats({ add: 0, del: 0 }),
    );
  }, [summary.id, events.length]);
  return (
    <aside className="dock">
      <div className="dock-head">
        <span className="muted small">{t('On {folder}', { folder })}</span>
      </div>
      <div className="dock-switch" role="tablist">
        {DOCK_PANES.map((p) => (
          <button key={p.id} role="tab" aria-selected={pane === p.id} className={pane === p.id ? 'on' : ''} onClick={() => onPane(pane === p.id ? null : p.id)}>
            <span>{t(p.label)}</span>
            {p.id === 'changes' && (stats.add > 0 || stats.del > 0) && (
              <span className="dock-stat">
                <span className="add">+{stats.add}</span> <span className="del">−{stats.del}</span>
              </span>
            )}
          </button>
        ))}
      </div>
      {pane && (
        <div className="dock-body">
          <DockBody id={pane} summary={summary} events={events} running={running} onClose={() => onPane(null)} />
        </div>
      )}
    </aside>
  );
}

function DockBody({ id, summary, events, running, onClose }: { id: DockPaneId; summary: SessionSummary; events: SessionEvent[]; running: boolean; onClose: () => void }) {
  if (id === 'changes') return <ChangesView sessionId={summary.id} version={events.length} running={running} onClose={onClose} />;
  if (id === 'browser') return <BrowserPanel key={summary.id} sessionId={summary.id} onClose={onClose} />;
  if (id === 'terminal') return <TerminalPane events={events} />;
  return <FilesPane sessionId={summary.id} version={events.length} />;
}

/** Commands this session ran, including ones still running and background jobs. */
function TerminalPane({ events }: { events: SessionEvent[] }) {
  const results = new Map(events.filter((e) => e.type === 'tool/result').map((e) => [e.callId, e]));
  const calls = events.flatMap((e) =>
    e.type === 'assistant/message'
      ? e.toolCalls.filter((c) => {
          if (c.name !== 'bash') return false;
          try {
            return JSON.parse(c.arguments).background !== true;
          } catch {
            return true;
          }
        })
      : [],
  );
  const jobs = new Map(events.filter((e) => e.type === 'job/finished').map((e) => [e.jobId, e]));
  const started = events.filter((e) => e.type === 'job/started');
  if (!calls.length && !started.length) return <p className="muted small dock-empty">{t('No commands yet.')}</p>;
  return (
    <div className="dock-term">
      <p className="muted small">{t('The commands this session ran.')}</p>
      {calls.map((call) => {
        let command = call.arguments;
        try {
          command = String(JSON.parse(call.arguments).command ?? command);
        } catch {
          /* keep the raw arguments */
        }
        const result = results.get(call.id);
        return (
          <div key={call.id} className="term-block">
            <div className="term-cmd">$ {command}</div>
            {result ? <pre className={result.isError ? 'term-err' : ''}>{result.output.slice(0, 8000)}</pre> : <p className="muted small">{t('running')}</p>}
          </div>
        );
      })}
      {started.map((job) => {
        const done = jobs.get(job.jobId);
        return (
          <div key={job.jobId} className="term-block">
            <div className="term-cmd">$ {job.command}</div>
            <p className="muted small">{done ? `${t(done.state)}${done.exitCode !== undefined ? ` · ${t('exit {code}', { code: done.exitCode })}` : ''}` : t('running')}</p>
          </div>
        );
      })}
    </div>
  );
}

function FilesPane({ sessionId, version }: { sessionId: string; version: number }) {
  const [dir, setDir] = useState('.');
  const [entries, setEntries] = useState<{ name: string; dir: boolean }[]>([]);
  const [file, setFile] = useState<{ path: string; content: string; binary: boolean; truncated: boolean } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setErr('');
    api.listWorkspace(sessionId, dir).then(setEntries, (e) => setErr(String(e.message ?? e)));
  }, [sessionId, dir, version]);
  const up = dir === '.' ? null : dir.split('/').slice(0, -1).join('/') || '.';
  return (
    <div className="dock-files">
      <p className="muted small mono">{dir === '.' ? t('Workspace files') : dir}</p>
      {err && <p className="small err-text">{err}</p>}
      {up && (
        <button className="dock-file" onClick={() => setDir(up)}>
          ..
        </button>
      )}
      {entries.map((e) => {
        const path = dir === '.' ? e.name : `${dir}/${e.name}`;
        return (
          <button
            key={e.name}
            className={`dock-file${file?.path === path ? ' on' : ''}`}
            onClick={() => {
              if (e.dir) setDir(path);
              else api.readSessionFile(sessionId, path).then(setFile, (err2) => setErr(String(err2.message ?? err2)));
            }}
          >
            {e.dir ? `${e.name}/` : e.name}
          </button>
        );
      })}
      {!entries.length && !err && <p className="muted small">{t('Empty folder.')}</p>}
      {file && (
        <pre className="dock-file-body">
          <span className="muted">{file.path}{'\n'}</span>
          {file.binary ? t('binary') : file.content.slice(0, 20_000)}
          {file.truncated ? `\n${t('… truncated (file over 1 MB)')}` : ''}
        </pre>
      )}
    </div>
  );
}
