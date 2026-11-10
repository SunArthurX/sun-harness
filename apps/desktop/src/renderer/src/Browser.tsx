import { t } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { BrowserControl, BrowserFrameRef, LiveEvent } from '@sun/core';
import { api } from './api';
import { BrowserUpload } from './BrowserUpload';

const SPECIAL_KEYS = new Set(['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/** Live view of the session's browser tab; "Take over" pauses the agent's browser tools and forwards your input. */
export function BrowserPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [frame, setFrame] = useState<BrowserFrameRef & { data: string; width: number; height: number }>();
  const [page, setPage] = useState<{ url?: string; title?: string }>({});
  const [takeover, setTakeover] = useState(false);
  const [driving, setDriving] = useState(false);
  const [changing, setChanging] = useState(false);
  const active = useRef(false);
  const control = useRef<BrowserControl | undefined>(undefined);
  const [error, setError] = useState('');
  const img = useRef<HTMLImageElement>(null);

  useEffect(() => {
    active.current = true;
    let receivedLive = false;
    setFrame(undefined);
    setPage({});
    setError('');
    setDriving(false);
    setTakeover(false);
    setChanging(false);
    const off = window.sun.onLive((e: LiveEvent) => {
      if (e.kind !== 'browser' || e.sessionId !== sessionId) return;
      receivedLive = true;
      setTakeover(e.takeover);
      if (e.frame && e.generation && e.frameId !== undefined) {
        setFrame({ data: e.frame, width: e.width ?? 1280, height: e.height ?? 800, generation: e.generation, frameId: e.frameId });
        if (control.current && (!e.takeover || control.current.generation !== e.generation)) {
          control.current = undefined;
          setDriving(false);
        }
      }
      if (e.url !== undefined) setPage({ url: e.url, title: e.title });
    });
    let cancelled = false;
    api.browserInfo(sessionId).then(i => {
      if (!cancelled && !receivedLive) setTakeover(i.takeover);
    }).catch(() => undefined);
    const viewer = crypto.randomUUID();
    const streaming = api.browserView(sessionId, true, viewer);
    streaming.catch(() => {
      if (!cancelled) setError(t('The live browser view is unavailable.'));
    });
    return () => {
      cancelled = true;
      active.current = false;
      off();
      const lease = control.current;
      control.current = undefined;
      if (lease) api.browserTakeover(sessionId, false, undefined, lease).catch(() => undefined);
      streaming.catch(() => undefined).then(() => api.browserView(sessionId, false, viewer)).catch(() => undefined);
    };
  }, [sessionId]);

  const point = (ev: { clientX: number; clientY: number }) => {
    const r = img.current!.getBoundingClientRect();
    const w = frame?.width ?? 1280;
    const h = frame?.height ?? 800;
    return { x: Math.round(((ev.clientX - r.left) / r.width) * w), y: Math.round(((ev.clientY - r.top) / r.height) * h) };
  };
  const changeControl = async () => {
    if (!frame || changing) return;
    const previous = control.current;
    setChanging(true);
    setError('');
    try {
      const lease = await api.browserTakeover(sessionId, !previous, { generation: frame.generation, frameId: frame.frameId }, previous);
      if (!active.current) {
        if (lease) await api.browserTakeover(sessionId, false, undefined, lease).catch(() => undefined);
        return;
      }
      control.current = lease;
      setDriving(!!lease);
      setTakeover(!!lease);
    } catch {
      setError(t('Browser control changed. Wait for the latest frame and try again.'));
    } finally {
      setChanging(false);
    }
  };
  const send = (input: Parameters<typeof api.browserInput>[1]) => {
    if (!frame || !control.current || changing) return;
    api.browserInput(sessionId, input, { generation: frame.generation, frameId: frame.frameId }, control.current)
      .then(() => setError(''))
      .catch(() => setError(t('Browser control changed. Wait for the latest frame and try again.')));
  };

  return (
    <div className={`browser-panel ${takeover ? 'taken' : ''}`}>
      <div className="browser-bar">
        <span className="mono small browser-url" title={page.url}>
          {page.title ? <strong>{page.title}</strong> : null} {page.url}
        </span>
        <button className={driving ? 'btn-primary small' : 'btn-ghost small'} disabled={changing || !frame || (takeover && !driving)} onClick={changeControl}>
          {driving ? t("Hand back to agent") : t("Take over")}
        </button>
        <button className="btn-ghost small" onClick={onClose}>
          ✕
        </button>
      </div>
      {driving && <p className="small browser-hint">{t("You control the browser. After handback, the agent needs a fresh snapshot.")}</p>}
      {takeover && !driving && <p className="small browser-hint">{t("Another viewer controls this browser.")}</p>}
      {frame && <BrowserUpload sessionId={sessionId} disabled={takeover || changing} />}
      {error && <p className="small browser-hint" role="status">{error}</p>}
      <div
        className="browser-view"
        tabIndex={0}
        onKeyDown={(e) => {
          if (!driving) return;
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
            alt={t("browser")}
            draggable={false}
            onClick={(e) => driving && send({ type: 'click', ...point(e) })}
            onWheel={(e) => driving && send({ type: 'wheel', ...point(e), deltaX: e.deltaX, deltaY: e.deltaY })}
          />
        ) : (
          <p className="muted small">{t("Waiting for the page…")}</p>
        )}
      </div>
    </div>
  );
}
