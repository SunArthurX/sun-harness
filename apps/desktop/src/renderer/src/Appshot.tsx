import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { AppshotPreview, AppshotRect, CapabilityStatus, PreparedAppshot } from '@sun/core';
import { api, type AppshotDispatch } from './api';
import { t } from './i18n';

type Point = { x: number; y: number };
function rectangle(start: Point, end: Point): AppshotRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x), height: Math.abs(start.y - end.y) };
}

export function appshotError(code?: string): string {
  if (code?.includes('APPSHOT_SCREEN_PERMISSION')) return t('Allow Sun Harness in macOS Privacy & Security → Screen & System Audio Recording, then reopen the app.');
  if (code?.includes('APPSHOT_DRAFT_BUSY')) return t('Finish or cancel the existing Appshot first.');
  if (code && /APPSHOT_(NO_WINDOW|FOREGROUND_CHANGED|WINDOW_UNAVAILABLE)/.test(code)) return t('Bring a window to the foreground and try again.');
  if (code?.includes('APPSHOT_DRAFT_STALE')) return t('This Appshot expired or belongs to a different chat. Capture it again.');
  if (code?.includes('APPSHOT_SESSION_BUSY')) return t('Wait for the current response to finish before sending the Appshot.');
  if (code?.includes('FEATURE_DISABLED') || code?.includes('APPSHOT_DISABLED')) return t('Enable Appshots in Settings before capturing.');
  if (code?.includes('SURFACE_UNSUPPORTED') || code?.includes('ADAPTER_MISSING') || code?.includes('APPSHOT_PLATFORM_UNSUPPORTED')) {
    return t('Appshots require the supported macOS desktop app and a local execution host.');
  }
  return t('The Appshot could not be prepared. Try again.');
}

export function AppshotButton({ sessionId, capability, attached, shortcut, onShortcut, onPrepared }: {
  sessionId: string;
  capability?: CapabilityStatus;
  attached: boolean;
  shortcut?: AppshotDispatch;
  onShortcut(): void;
  onPrepared(value: PreparedAppshot): void;
}) {
  const [preview, setPreview] = useState<AppshotPreview>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [includeText, setIncludeText] = useState(true);
  const [mode, setMode] = useState<'crop' | 'mask'>('mask');
  const [crop, setCrop] = useState<AppshotRect>();
  const [masks, setMasks] = useState<AppshotRect[]>([]);
  const [draft, setDraft] = useState<AppshotRect>();
  const start = useRef<Point | undefined>(undefined);
  const active = useRef(false);
  const current = useRef<string | undefined>(undefined);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      if (current.current) void api.cancelAppshot(sessionId, current.current).catch(() => undefined);
      current.current = undefined;
    };
  }, [sessionId]);

  const show = (value: AppshotPreview) => {
    current.current = value.id;
    setCrop(undefined);
    setMasks([]);
    setDraft(undefined);
    setIncludeText(true);
    setPreview(value);
  };

  useEffect(() => {
    if (!shortcut) return;
    if ('preview' in shortcut) {
      if (attached) void api.cancelAppshot(sessionId, shortcut.preview.id).catch(() => undefined);
      else show(shortcut.preview);
    } else setNotice(appshotError(shortcut.error));
    onShortcut();
  }, [shortcut, attached, sessionId, onShortcut]);

  const capture = async () => {
    if (busy || attached || preview) return;
    setNotice('');
    if (capability?.state !== 'available') { setNotice(appshotError(capability?.reasonCode)); return; }
    setBusy(true);
    try {
      const value = await api.captureAppshot(sessionId);
      if (!active.current) {
        await api.cancelAppshot(sessionId, value.id);
        return;
      }
      show(value);
    } catch (error) {
      if (active.current) setNotice(appshotError(String(error)));
    } finally { if (active.current) setBusy(false); }
  };

  const cancel = () => {
    if (current.current) void api.cancelAppshot(sessionId, current.current).catch(() => undefined);
    current.current = undefined;
    setPreview(undefined);
    setNotice('');
  };

  const prepare = async () => {
    if (!preview || busy) return;
    setBusy(true);
    setNotice('');
    try {
      const value = await api.prepareAppshot(sessionId, preview.id, { crop, masks, includeText });
      if (!active.current || current.current !== preview.id) return;
      current.current = undefined;
      setPreview(undefined);
      onPrepared(value);
    } catch (error) {
      if (active.current) setNotice(appshotError(String(error)));
    } finally { if (active.current) setBusy(false); }
  };

  const point = (event: PointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    const snap = (coordinate: number, start: number, size: number, pixels: number) =>
      Math.max(0, Math.min(pixels, Math.round((coordinate - start) / size * pixels)));
    return { x: snap(event.clientX, rect.left, rect.width, preview!.width),
      y: snap(event.clientY, rect.top, rect.height, preview!.height) };
  };
  const outline = (rect: AppshotRect) => ({
    left: `${rect.x / preview!.width * 100}%`, top: `${rect.y / preview!.height * 100}%`,
    width: `${rect.width / preview!.width * 100}%`, height: `${rect.height / preview!.height * 100}%`,
  });
  const edited = !!crop || masks.length > 0;

  return <>
    <button type="button" className="btn-ghost small" onClick={() => void capture()} disabled={busy || attached || !!preview}>
      {t('Capture Appshot')}
    </button>
    {notice && <span role="status" className="small">{notice}</span>}
    {preview && <section className="appshot-preview" role="dialog" aria-label={t('Review Appshot')}
      onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); cancel(); } }}>
      <header>
        <h3>{t('Review Appshot')}</h3>
        <p>{t('Captured window: {title} ({app})', { title: preview.title || t('Untitled window'), app: preview.appId })}</p>
        {preview.targetChanged && <p role="status">{t('The foreground window changed. This preview shows the actual capture.')}</p>}
      </header>
      <div className="appshot-image"
        onPointerDown={event => {
          if (busy || event.button !== 0 || (mode === 'mask' && masks.length >= 20)) return;
          start.current = point(event);
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={event => { if (start.current) setDraft(rectangle(start.current, point(event))); }}
        onPointerCancel={() => { start.current = undefined; setDraft(undefined); }}
        onPointerUp={event => {
          const origin = start.current;
          start.current = undefined;
          setDraft(undefined);
          if (!origin) return;
          const rect = rectangle(origin, point(event));
          if (!rect.width || !rect.height) return;
          if (mode === 'crop') setCrop(rect);
          else setMasks(previous => [...previous, rect]);
        }}>
        <img src={`data:${preview.mime};base64,${preview.data}`} alt={t('Private Appshot preview')} draggable={false} />
        {crop && <span className="appshot-crop" style={outline(crop)} />}
        {masks.map((rect, index) => <span className="appshot-mask" key={index} style={outline(rect)} />)}
        {draft && <span className="appshot-crop" style={outline(draft)} />}
      </div>
      <p className="small">{t('Drag on the image to select a crop or cover a region.')}</p>
      <div className="row">
        <button type="button" aria-pressed={mode === 'crop'} disabled={busy} onClick={() => setMode('crop')}>{t('Crop area')}</button>
        <button type="button" aria-pressed={mode === 'mask'} disabled={busy} onClick={() => setMode('mask')}>{t('Cover area')}</button>
        <button type="button" disabled={busy || !edited} onClick={() => { setCrop(undefined); setMasks([]); }}>{t('Clear edits')}</button>
      </div>
      {preview.text ? <>
        <label><input type="checkbox" checked={includeText && !edited} disabled={busy || edited}
          onChange={event => setIncludeText(event.target.checked)} /> {t('Include captured text')}</label>
        {edited ? <p className="small">{t('Image edits exclude captured text from the attachment.')}</p>
          : includeText && <pre className="appshot-text">{preview.text}</pre>}
        {preview.textTruncated && <p className="small">{t('The captured text was truncated.')}</p>}
      </> : <p className="small">{t('This Appshot contains an image only.')}</p>}
      <div className="row">
        <button type="button" className="btn-primary" disabled={busy} onClick={() => void prepare()}>{t('Attach prepared Appshot')}</button>
        <button type="button" className="btn-ghost" onClick={cancel}>{t('Cancel')}</button>
      </div>
    </section>}
  </>;
}
