import { useEffect, useRef, useState } from 'react';
import type { LiveEvent } from '@sun/core';
import { api } from './api';

const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/** Live view of the session's browser tab; "Take over" pauses the agent's browser tools and forwards your input. */
export function BrowserPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [frame, setFrame] = useState<{ data: string; width: number; height: number }>();
  const [page, setPage] = useState<{ url?: string; title?: string }>({});
  const [takeover, setTakeover] = useState(false);
  const [vncUrl, setVncUrl] = useState<string>();
  const [error, setError] = useState('');
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    api.browserInfo(sessionId).then((i) => {
      setTakeover(i.takeover);
      setVncUrl(i.vncUrl);
    });
    api.browserView(sessionId, true).catch((e) => setError(String(e.message ?? e)));
    const off = window.sun.onLive((e: LiveEvent) => {
      if (e.kind !== 'browser' || e.sessionId !== sessionId) return;
      setTakeover(e.takeover);
      if (e.frame) setFrame({ data: e.frame, width: e.width ?? 1280, height: e.height ?? 800 });
      if (e.url !== undefined) setPage({ url: e.url, title: e.title });
    });
    return () => {
      off();
      api.browserView(sessionId, false).catch(() => undefined);
    };
  }, [sessionId]);

  const point = (ev: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    const w = frame?.width ?? 1280;
    const h = frame?.height ?? 800;
    return { x: Math.round(((ev.clientX - r.left) / r.width) * w), y: Math.round(((ev.clientY - r.top) / r.height) * h) };
  };
  const send = (input: Parameters<typeof api.browserInput>[1]) => api.browserInput(sessionId, input).catch((e) => setError(String(e.message ?? e)));

  return (
    <div className={`browser-panel ${takeover ? 'taken' : ''}`}>
      <div className="browser-bar">
        <span className="mono small browser-url" title={page.url}>
          {page.title ? <strong>{page.title}</strong> : null} {page.url}
        </span>
        <button className={takeover ? 'btn-primary small' : 'btn-ghost small'} onClick={() => api.browserTakeover(sessionId, !takeover)}>
          {takeover ? 'Hand back to agent' : 'Take over'}
        </button>
        {vncUrl && (
          <button className="btn-ghost small" title="Full desktop of the sandboxed browser (noVNC)" onClick={() => api.openExternal(vncUrl)}>
            noVNC ↗
          </button>
        )}
        <button className="btn-ghost small" onClick={onClose}>
          ✕
        </button>
      </div>
      {takeover && <p className="small browser-hint">You are driving: clicks, scrolling and typing go to the page. The agent waits until you hand it back.</p>}
      <div
        className="browser-view"
        tabIndex={0}
        onKeyDown={(e) => {
          if (!takeover) return;
          e.preventDefault();
          const mods = [e.ctrlKey && 'Control', e.metaKey && 'Meta', e.altKey && 'Alt'].filter(Boolean) as string[];
          if (SPECIAL_KEYS.has(e.key) || mods.length) send({ type: 'key', key: [...mods, e.shiftKey && mods.length ? 'Shift' : '', e.key].filter(Boolean).join('+') });
          else if (e.key.length === 1) send({ type: 'text', text: e.key });
        }}
      >
        {frame ? (
          <img
            ref={img}
            src={`data:image/jpeg;base64,${frame.data}`}
            alt="browser"
            draggable={false}
            onClick={(e) => takeover && send({ type: 'click', ...point(e) })}
            onWheel={(e) => takeover && send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          />
        ) : (
          <p className="muted small">{error || 'Waiting for the page…'}</p>
        )}
      </div>
    </div>
  );
}
