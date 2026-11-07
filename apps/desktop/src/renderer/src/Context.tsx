import { useEffect, useState } from 'react';
import type { ContextReport } from '@sun/core';
import { api } from './api';

const COLORS = ['#e8862a', '#8db8ff', '#9a7fd1', '#7fd1a0', '#e8c37a', '#ff8a7a', '#6fc3c8', '#c8a26f', '#b0b0b0'];
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A small ring: share of the model's context window the session uses. */
export function ContextRing({ used, window, onClick, active }: { used?: number; window?: number; onClick: () => void; active: boolean }) {
  const f = used && window ? Math.min(1, used / window) : 0;
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = f > 0.8 ? 'var(--err)' : f > 0.5 ? 'var(--warn)' : 'var(--sun)';
  return (
    <button className={`chip context-chip ${active ? 'on' : ''}`} title={used && window ? `${used.toLocaleString('en')} of ${window.toLocaleString('en')} tokens at the last request — open the context report` : 'Context report'} onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
      </svg>
      {used && window ? `${Math.round(f * 100)}%` : 'context'}
    </button>
  );
}

/** Context report: what the next request contains, by category, with suggestions and actions. */
export function ContextPanel({ sessionId, version, onClose, onCompacted }: { sessionId: string; version: number; onClose: () => void; onCompacted: (msg: string) => void }) {
  const [r, setR] = useState<ContextReport>();
  const [open, setOpen] = useState<string>();
  const [err, setErr] = useState('');
  const load = () => api.contextUsage(sessionId).then(setR, (e) => setErr(String(e.message ?? e)));
  useEffect(() => {
    void load();
  }, [sessionId, version]);
  if (!r) return <div className="changes context-panel">{err || 'Measuring…'}</div>;
  const exportHtml = async () => {
    const html = await api.contextReportHtml(sessionId);
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `context-${sessionId}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <div className="changes context-panel">
      <div className="row-between">
        <strong>
          Context · {k(r.totalTokens)} / {k(r.window)} tokens <span className="muted small">({(r.percent * 100).toFixed(1)}% · {r.model})</span>
        </strong>
        <span className="row">
          <button className="btn-ghost small" onClick={() => void load()}>
            Refresh
          </button>
          <button
            className="btn-ghost small"
            onClick={async () => {
              try {
                onCompacted((await api.compact(sessionId)) ? 'Older history compacted into a summary.' : 'Nothing to compact yet.');
                await load();
              } catch (e) {
                setErr(String((e as Error).message ?? e));
              }
            }}
          >
            Compact now
          </button>
          <button className="btn-ghost small" onClick={() => void exportHtml()}>
            Export HTML
          </button>
          <button className="btn-ghost small" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="ctx-bar" title="Share of the context window by category">
        {r.categories.map((c, i) => (
          <span key={c.name} style={{ width: `${(c.tokens / Math.max(1, r.window)) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${c.name}: ${c.tokens.toLocaleString('en')}`} />
        ))}
        <b className="ctx-threshold" style={{ left: `${(r.compactAt / Math.max(1, r.window)) * 100}%` }} title={`compaction at ${r.compactAt.toLocaleString('en')}`} />
      </div>
      <p className="muted small">
        {r.lastRequest
          ? `Last request (provider-reported): ${r.lastRequest.inputTokens.toLocaleString('en')} in, ${Math.round((r.lastRequest.cachedTokens / Math.max(1, r.lastRequest.inputTokens)) * 100)}% cached, ${r.lastRequest.outputTokens.toLocaleString('en')} out.`
          : 'No request yet.'}{' '}
        Compaction at {k(r.compactAt)}
        {r.compactions ? ` · compacted ${r.compactions}×` : ''}. Category sizes are estimates.
      </p>
      {r.categories.map((c, i) => (
        <div key={c.name} className="ctx-cat">
          <button className="ctx-row" onClick={() => setOpen(open === c.name ? undefined : c.name)}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span>{c.name}</span>
            <span className="mono small">{c.tokens.toLocaleString('en')}</span>
            <span className="muted small">{((c.tokens / Math.max(1, r.totalTokens)) * 100).toFixed(0)}%</span>
          </button>
          {open === c.name && (
            <div className="ctx-items">
              {c.items.map((x) => (
                <div key={x.label} className="ctx-item">
                  <span>{x.label}</span>
                  <span className="mono small">{x.tokens.toLocaleString('en')}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <ul className="ctx-suggest small">
        {r.suggestions.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      {err && <p className="small err-text">{err}</p>}
    </div>
  );
}
