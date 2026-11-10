import { locale, t, tk } from './i18n';
import { modeLabel } from './App';
import { useEffect, useState } from 'react';
import type { ContextReport } from '@sun/core';
import { api } from './api';

const COLORS = ['#e8862a', '#8db8ff', '#9a7fd1', '#7fd1a0', '#e8c37a', '#ff8a7a', '#6fc3c8', '#c8a26f', '#b0b0b0'];
/** Context report categories and system prompt sections, as core names them. */
tk('System prompt'), tk('Tool definitions'), tk('Compaction summary'), tk('User messages'), tk('Attached files'), tk('Images'), tk('Recalled memories'), tk('Assistant messages'), tk('Tool results');
tk('Environment'), tk('Project rules'), tk('Optional rules'), tk('Specs'), tk('Repository map'), tk('Skills'), tk('Knowledge base'), tk('Memory'), tk('User'), tk('Rules for files in context');
tk('The context is at {pct}% of the compaction threshold: run /compact now, or start a new session for an unrelated task.');
tk('{label} alone is {tokens} tokens ({pct}%). Ask for narrower reads (line ranges, grep) next time; /compact drops it.');
tk('{n} tool definitions take {pct}%: disable MCP servers you do not need in this project.');
tk('Project rules are {tokens} tokens: mark rarely needed rule files alwaysApply: false (they become a one-line index).');
tk('The skills index is {tokens} tokens ({pct}%): set "skills": { "compat": false } to skip Claude/agents skill folders, or prune ~/.sun/skills.');
tk('Attached files are a large share: mention folders or smaller files, or let the agent read what it needs.');
tk('Nothing to do: the context is comfortably sized.');

/** Item labels built by core: a few patterns carry words. */
function itemLabel(label: string): string {
  let m = /^(\w+) mode instructions$/.exec(label);
  if (m) return t('{mode} mode instructions', { mode: modeLabel(m[1].toLowerCase()) });
  m = /^recall #(\d+)$/.exec(label);
  if (m) return t('recall #{n}', { n: m[1] });
  m = /^summary of events ≤ #(\d+)$/.exec(label);
  if (m) return t('summary of events ≤ #{n}', { n: m[1] });
  return t(label);
}

const num = (n: number) => n.toLocaleString(locale());
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** A small ring: share of the model's context window the session uses. */
export function ContextRing({ used, window, onClick, active }: { used?: number; window?: number; onClick: () => void; active: boolean }) {
  const f = used && window ? Math.min(1, used / window) : 0;
  const r = 7;
  const c = 2 * Math.PI * r;
  const color = f > 0.8 ? 'var(--err)' : f > 0.5 ? 'var(--warn)' : 'var(--sun)';
  return (
    <button className={`chip context-chip ${active ? 'on' : ''}`} title={used && window ? t('{used} of {window} tokens at the last request — open the context report', { used: num(used), window: num(window) }) : t('Context report')} onClick={onClick}>
      <svg width="18" height="18" viewBox="0 0 18 18">
        <circle cx="9" cy="9" r={r} fill="none" stroke="var(--line)" strokeWidth="2.5" />
        <circle cx="9" cy="9" r={r} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 9 9)" strokeLinecap="round" />
      </svg>
      {used && window ? `${Math.round(f * 100)}%` : t("context")}
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
  if (!r) return <div className="changes context-panel">{err || t("Measuring…")}</div>;
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
          {t('Context · {used} / {window} tokens', { used: k(r.totalTokens), window: k(r.window) })} <span className="muted small">({(r.percent * 100).toFixed(1)}% · {r.model})</span>
        </strong>
        <span className="row">
          <button className="btn-ghost small" onClick={() => void load()}>
            {t("Refresh")}
          </button>
          <button
            className="btn-ghost small"
            onClick={async () => {
              try {
                onCompacted((await api.compact(sessionId)) ? t('Older history compacted into a summary.') : t('Nothing to compact yet.'));
                await load();
              } catch (e) {
                setErr(String((e as Error).message ?? e));
              }
            }}
          >
            {t("Compact now")}
          </button>
          <button className="btn-ghost small" onClick={() => void exportHtml()}>
            {t("Export HTML")}
          </button>
          <button className="btn-ghost small" onClick={onClose}>
            ✕
          </button>
        </span>
      </div>
      <div className="ctx-bar" title={t("Share of the context window by category")}>
        {r.categories.map((c, i) => (
          <span key={c.name} style={{ width: `${(c.tokens / Math.max(1, r.window)) * 100}%`, background: COLORS[i % COLORS.length] }} title={`${t(c.name)}: ${num(c.tokens)}`} />
        ))}
        <b className="ctx-threshold" style={{ left: `${(r.compactAt / Math.max(1, r.window)) * 100}%` }} title={t('compaction at {n}', { n: num(r.compactAt) })} />
      </div>
      <p className="muted small">
        {r.lastRequest
          ? t('Last request (provider-reported): {input} in, {pct}% cached, {output} out.', {
              input: num(r.lastRequest.inputTokens),
              pct: Math.round((r.lastRequest.cachedTokens / Math.max(1, r.lastRequest.inputTokens)) * 100),
              output: num(r.lastRequest.outputTokens),
            })
          : t('No request yet.')}{' '}
        {t('Compaction at {n}', { n: k(r.compactAt) })}
        {r.compactions ? ` · ${t('compacted {n}×', { n: r.compactions })}` : ''}. {t('Category sizes are estimates.')}
      </p>
      {r.categories.map((c, i) => (
        <div key={c.name} className="ctx-cat">
          <button className="ctx-row" onClick={() => setOpen(open === c.name ? undefined : c.name)}>
            <i style={{ background: COLORS[i % COLORS.length] }} />
            <span>{t(c.name)}</span>
            <span className="mono small">{num(c.tokens)}</span>
            <span className="muted small">{((c.tokens / Math.max(1, r.totalTokens)) * 100).toFixed(0)}%</span>
          </button>
          {open === c.name && (
            <div className="ctx-items">
              {c.items.map((x) => (
                <div key={x.label} className="ctx-item">
                  <span>{itemLabel(x.label)}</span>
                  <span className="mono small">{num(x.tokens)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      <ul className="ctx-suggest small">
        {(r.suggestionKeys ?? r.suggestions.map((s) => ({ key: s, params: {} }))).map((s, i) => (
          <li key={i}>{t(s.key, s.params)}</li>
        ))}
      </ul>
      {err && <p className="small err-text">{err}</p>}
    </div>
  );
}
