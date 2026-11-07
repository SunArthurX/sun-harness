import { useEffect, useMemo, useState } from 'react';
import type { FileChange } from '@sun/core';
import { api } from './api';

const STATUS: Record<FileChange['status'], { letter: string; cls: string }> = {
  added: { letter: 'A', cls: 'st-a' },
  modified: { letter: 'M', cls: 'st-m' },
  deleted: { letter: 'D', cls: 'st-d' },
};
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method 'sun:call': (Error: )?/, '');

/** Colored unified diff with line numbers on both sides. */
export function DiffLines({ diff }: { diff: string }) {
  const rows: { a?: number; b?: number; t: string; cls: string }[] = [];
  let a = 0;
  let b = 0;
  for (const l of diff.split('\n')) {
    if (/^(---|\+\+\+) /.test(l)) continue;
    const h = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(l);
    if (h) {
      a = Number(h[1]);
      b = Number(h[2]);
      rows.push({ t: l, cls: 'hunk' });
    } else if (l.startsWith('+')) rows.push({ b: b++, t: l.slice(1), cls: 'add' });
    else if (l.startsWith('-')) rows.push({ a: a++, t: l.slice(1), cls: 'del' });
    else rows.push({ a: a++, b: b++, t: l.slice(1), cls: '' });
  }
  return (
    <div className="difflines">
      {rows.map((r, i) => (
        <div key={i} className={`dl ${r.cls}`}>
          <span className="ln">{r.a ?? ''}</span>
          <span className="ln">{r.b ?? ''}</span>
          <span className="mk">{r.cls === 'add' ? '+' : r.cls === 'del' ? '−' : ''}</span>
          <span className="tx">{r.t}</span>
        </div>
      ))}
    </div>
  );
}

function FileView({ sessionId, path }: { sessionId: string; path: string }) {
  const [f, setF] = useState<{ content: string; truncated: boolean; binary: boolean; size: number }>();
  const [err, setErr] = useState('');
  useEffect(() => {
    api.readSessionFile(sessionId, path).then(setF, (e) => setErr(errText(e)));
  }, [sessionId, path]);
  if (err) return <p className="muted small">{err}</p>;
  if (!f) return <p className="muted small">Loading…</p>;
  if (f.binary) return <p className="muted small">Binary file ({Math.round(f.size / 1000)} kB).</p>;
  return (
    <div className="difflines file">
      {f.content.split('\n').map((l, i) => (
        <div key={i} className="dl">
          <span className="ln">{i + 1}</span>
          <span className="tx">{l}</span>
        </div>
      ))}
      {f.truncated && <p className="muted small">… truncated (file over 1 MB)</p>}
    </div>
  );
}

function FileActions({ sessionId, c, fromSeq, onChanged, onMsg }: { sessionId: string; c: FileChange; fromSeq?: number; onChanged: () => void; onMsg: (m: string) => void }) {
  return (
    <span className="file-actions">
      <button className="btn-ghost small" title="Open in the default app" onClick={() => void api.openPath(c.abs)} disabled={c.status === 'deleted'}>
        Open
      </button>
      <button className="btn-ghost small" title="Copy the path" onClick={() => void navigator.clipboard?.writeText(c.abs).then(() => onMsg('Path copied.'))}>
        Copy path
      </button>
      <button
        className="btn-ghost small"
        title={fromSeq !== undefined ? 'Restore the file as it was before this turn' : 'Restore the file as it was before this session'}
        onClick={async () => {
          if (!confirm(`Revert ${c.path}${fromSeq !== undefined ? ' to before this turn' : ' to before this session'}? (Undo can bring the change back.)`)) return;
          try {
            await api.revertFile(sessionId, c.path, fromSeq);
            onMsg(`Reverted ${c.path}.`);
            onChanged();
          } catch (e) {
            onMsg(errText(e));
          }
        }}
      >
        Revert
      </button>
    </span>
  );
}

/** End-of-turn summary (Codex / Cursor-style): which files this turn changed; click a file for its diff or content. */
export function TurnChanges({ sessionId, fromSeq, toSeq, running }: { sessionId: string; fromSeq: number; toSeq: number; running: boolean }) {
  const [changes, setChanges] = useState<FileChange[]>();
  const [open, setOpen] = useState<string>();
  const [view, setView] = useState<'diff' | 'file'>('diff');
  const [msg, setMsg] = useState('');
  const [v, setV] = useState(0);
  useEffect(() => {
    api.sessionChanges(sessionId, fromSeq, toSeq).then(setChanges, () => setChanges([]));
  }, [sessionId, fromSeq, toSeq, v]);
  if (!changes?.length) return null;
  const add = changes.reduce((n, x) => n + x.additions, 0);
  const del = changes.reduce((n, x) => n + x.deletions, 0);
  return (
    <div className="turn-changes">
      <div className="tc-head">
        <strong>
          {changes.length} file{changes.length > 1 ? 's' : ''} changed
        </strong>{' '}
        <span className="add">+{add}</span> <span className="del">−{del}</span>
        {msg && <span className="muted small"> · {msg}</span>}
      </div>
      {changes.map((c) => (
        <div key={c.abs} className={`tc-file ${open === c.abs ? 'open' : ''}`}>
          <button className="tc-row" onClick={() => setOpen(open === c.abs ? undefined : c.abs)}>
            <span className={`st ${STATUS[c.status].cls}`}>{STATUS[c.status].letter}</span>
            <span className="mono small tc-path">{c.path}</span>
            <span className="small">
              {c.binary ? <span className="muted">binary</span> : <><span className="add">+{c.additions}</span> <span className="del">−{c.deletions}</span></>}
            </span>
          </button>
          {open === c.abs && (
            <div className="tc-body">
              <div className="row-between">
                <span className="segmented small-seg">
                  <button className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>
                    Diff
                  </button>
                  <button className={view === 'file' ? 'on' : ''} onClick={() => setView('file')} disabled={c.status === 'deleted'}>
                    File
                  </button>
                </span>
                {!running && <FileActions sessionId={sessionId} c={c} fromSeq={fromSeq} onChanged={() => setV((x) => x + 1)} onMsg={setMsg} />}
              </div>
              {view === 'diff' ? c.diff ? <DiffLines diff={c.diff} /> : <p className="muted small">No text diff ({c.binary ? 'binary' : c.status}).</p> : <FileView sessionId={sessionId} path={c.path} />}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  change?: FileChange;
}

function buildTree(changes: FileChange[]): TreeNode {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const c of changes) {
    const parts = c.path.split('/');
    let node = root;
    parts.forEach((p, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.children.find((x) => x.name === p);
      if (!child) node.children.push((child = { name: p, path, children: [] }));
      if (i === parts.length - 1) child.change = c;
      node = child;
    });
  }
  const sort = (n: TreeNode) => {
    n.children.sort((a, b) => Number(!!a.change) - Number(!!b.change) || a.name.localeCompare(b.name));
    n.children.forEach(sort);
  };
  sort(root);
  return root;
}

/** Session-wide review (GitHub / Cursor-style): file tree on the left, diff or file on the right. */
export function ChangesView({ sessionId, version, running, onClose }: { sessionId: string; version: number; running: boolean; onClose: () => void }) {
  const [changes, setChanges] = useState<FileChange[]>([]);
  const [sel, setSel] = useState<string>();
  const [view, setView] = useState<'diff' | 'file'>('diff');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState('');
  const [v, setV] = useState(0);
  useEffect(() => {
    api.sessionChanges(sessionId).then(
      (cs) => {
        setChanges(cs);
        setSel((cur) => (cur && cs.some((c) => c.abs === cur) ? cur : cs[0]?.abs));
      },
      () => setChanges([]),
    );
  }, [sessionId, version, v]);
  const tree = useMemo(() => buildTree(changes), [changes]);
  const current = changes.find((c) => c.abs === sel);
  const add = changes.reduce((n, x) => n + x.additions, 0);
  const del = changes.reduce((n, x) => n + x.deletions, 0);
  const renderNode = (n: TreeNode, depth: number): React.ReactNode =>
    n.change ? (
      <button key={n.path} className={`tree-file ${sel === n.change.abs ? 'on' : ''}`} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => setSel(n.change!.abs)}>
        <span className={`st ${STATUS[n.change.status].cls}`}>{STATUS[n.change.status].letter}</span>
        <span className="mono small">{n.name}</span>
        <span className="small tree-stat">{n.change.binary ? '' : <><span className="add">+{n.change.additions}</span> <span className="del">−{n.change.deletions}</span></>}</span>
      </button>
    ) : (
      <div key={n.path}>
        <button
          className="tree-dir"
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() =>
            setCollapsed((s) => {
              const next = new Set(s);
              if (next.has(n.path)) next.delete(n.path);
              else next.add(n.path);
              return next;
            })
          }
        >
          {collapsed.has(n.path) ? '▸' : '▾'} <span className="mono small">{n.name}/</span>
        </button>
        {!collapsed.has(n.path) && n.children.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  return (
    <div className="changes changes-view">
      <div className="row-between">
        <strong>
          Changes in this session · {changes.length} file{changes.length === 1 ? '' : 's'} <span className="add">+{add}</span> <span className="del">−{del}</span>
        </strong>
        <span className="row">
          {msg && <span className="muted small">{msg}</span>}
          <button className="btn-ghost small" onClick={() => setV((x) => x + 1)}>
            Refresh
          </button>
          <button className="btn-ghost small" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      {!changes.length ? (
        <p className="muted small">No file changes yet.</p>
      ) : (
        <div className="cv-body">
          <div className="cv-tree">{tree.children.map((c) => renderNode(c, 0))}</div>
          <div className="cv-pane">
            {current && (
              <>
                <div className="row-between cv-pane-head">
                  <span className="mono small">{current.path}</span>
                  <span className="row">
                    <span className="segmented small-seg">
                      <button className={view === 'diff' ? 'on' : ''} onClick={() => setView('diff')}>
                        Diff
                      </button>
                      <button className={view === 'file' ? 'on' : ''} onClick={() => setView('file')} disabled={current.status === 'deleted'}>
                        File
                      </button>
                    </span>
                    {!running && <FileActions sessionId={sessionId} c={current} onChanged={() => setV((x) => x + 1)} onMsg={setMsg} />}
                  </span>
                </div>
                {view === 'diff' ? current.diff ? <DiffLines diff={current.diff} /> : <p className="muted small">No text diff ({current.binary ? 'binary' : current.status}).</p> : <FileView sessionId={sessionId} path={current.path} />}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
