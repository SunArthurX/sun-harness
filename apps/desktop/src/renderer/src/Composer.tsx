import { t, tk } from './i18n';
import { useEffect, useRef, useState } from 'react';
import type { CapabilityStatus, PreparedAppshot } from '@sun/core';
import { api, type AppshotDispatch } from './api';
import { AppshotButton, appshotError } from './Appshot';

type Image = { data: string; mime: string; name: string };
type Suggestion = { label: string; insert: string; hint?: string };

/** Desktop-only actions offered in the / menu next to custom commands. */
const LOCAL_COMMANDS: Suggestion[] = [
  { label: '/compact', insert: '/compact', hint: tk("summarize older history now") },
  { label: '/cost', insert: '/cost', hint: tk("tokens and estimated cost") },
  { label: '/export', insert: '/export', hint: tk("download as Markdown") },
  { label: '/review', insert: '/review', hint: tk("review this session's edits for bugs and missing tests") },
];

const toBase64 = (f: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(f);
  });

/** The token being typed at the caret: "@path" or a leading "/command". */
function activeToken(text: string, caret: number): { kind: '@' | '/'; query: string; start: number } | undefined {
  const before = text.slice(0, caret);
  const at = /(^|\s)@([\w./~-]*)$/.exec(before);
  if (at) return { kind: '@', query: at[2], start: caret - at[2].length - 1 };
  const slash = /^\/([\w:.-]*)$/.exec(before);
  if (slash) return { kind: '/', query: slash[1], start: 0 };
  return undefined;
}

export function Composer({
  cwd,
  sessionId,
  appshotCapability,
  shortcutAppshot,
  onShortcutAppshot,
  placeholder,
  running,
  inject,
  onSend,
  onLocalCommand,
  onAbort,
  extra,
  lastMessage,
}: {
  cwd: string;
  sessionId: string;
  appshotCapability?: CapabilityStatus;
  shortcutAppshot?: AppshotDispatch;
  onShortcutAppshot(): void;
  placeholder: string;
  running: boolean;
  /** Text pushed in from outside (voice, rewind); a new `n` applies it once. */
  inject?: { text: string; n: number; replace?: boolean };
  onSend: (text: string, images: { data: string; mime: string }[], appshot?: string) => Promise<void>;
  /** Handle /compact, /cost, /export; return true when handled. */
  onLocalCommand: (cmd: string) => Promise<boolean>;
  onAbort: () => void;
  extra?: React.ReactNode;
  /** ↑ in an empty composer brings back the last message (Claude Code / shell habit). */
  lastMessage?: string;
}) {
  const [input, setInput] = useState(inject?.replace ? inject.text : '');
  const [images, setImages] = useState<Image[]>([]);
  const [appshot, setAppshot] = useState<PreparedAppshot>();
  const [appshotNotice, setAppshotNotice] = useState('');
  const [sendingAppshot, setSendingAppshot] = useState(false);
  const pendingAppshot = useRef<string | undefined>(undefined);
  const appshotSending = useRef(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [commands, setCommands] = useState<Suggestion[]>([]);
  const [drag, setDrag] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const token = useRef<ReturnType<typeof activeToken>>(undefined);

  useEffect(() => () => {
    if (pendingAppshot.current) void api.cancelAppshot(sessionId, pendingAppshot.current).catch(() => undefined);
  }, [sessionId]);

  const clearAppshot = () => {
    if (pendingAppshot.current) void api.cancelAppshot(sessionId, pendingAppshot.current).catch(() => undefined);
    pendingAppshot.current = undefined;
    setAppshot(undefined);
  };

  useEffect(() => {
    api.listCommands(cwd).then(
      (cs) => setCommands(cs.map((x) => ({ label: `/${x.name}`, insert: `/${x.name} `, hint: `${x.argumentHint ? `${x.argumentHint} · ` : ''}${x.description}` }))),
      () => setCommands([]),
    );
  }, [cwd]);
  useEffect(() => {
    if (!inject) return;
    setInput((v) => (inject.replace || !v ? inject.text : `${v} ${inject.text}`));
    ta.current?.focus();
  }, [inject?.n]);

  const refreshSuggestions = async (text: string, caret: number) => {
    const t = activeToken(text, caret);
    token.current = t;
    if (!t) return setSuggestions([]);
    if (t.kind === '/') {
      const q = t.query.toLowerCase();
      setSuggestions([...commands, ...LOCAL_COMMANDS].filter((s) => s.label.slice(1).toLowerCase().startsWith(q)).slice(0, 12));
    } else {
      const paths = await api.completePaths(cwd, t.query).catch(() => [] as string[]);
      setSuggestions(paths.map((p) => ({ label: p, insert: `@${p}${p.endsWith('/') ? '' : ' '}` })));
    }
    setSel(0);
  };

  const accept = (s: Suggestion) => {
    const t = token.current;
    const el = ta.current;
    if (!t || !el) return;
    const caret = el.selectionStart;
    const next = input.slice(0, t.start) + s.insert + input.slice(caret);
    setInput(next);
    setSuggestions([]);
    requestAnimationFrame(() => {
      el.focus();
      const pos = t.start + s.insert.length;
      el.setSelectionRange(pos, pos);
      if (s.insert.endsWith('/')) void refreshSuggestions(next, pos);
    });
  };

  const addFiles = async (files: FileList | File[]) => {
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    const added = await Promise.all(imgs.map(async (f) => ({ data: await toBase64(f), mime: f.type, name: f.name || 'pasted image' })));
    setImages((cur) => [...cur, ...added].slice(0, 8));
  };

  const submit = async () => {
    const text = input.trim();
    if (!text && !images.length && !appshot || appshotSending.current) return;
    if (appshot) {
      if (running) { setAppshotNotice(appshotError('APPSHOT_SESSION_BUSY')); return; }
      appshotSending.current = true;
      setSendingAppshot(true);
      setAppshotNotice('');
      try {
        await onSend(text || t('Look at the attached Appshot.'), images.map(({ data, mime }) => ({ data, mime })), appshot.id);
        pendingAppshot.current = undefined;
        setAppshot(undefined);
        setInput('');
        setImages([]);
        setSuggestions([]);
      } catch (error) {
        setAppshotNotice(appshotError(String(error)));
      } finally {
        appshotSending.current = false;
        setSendingAppshot(false);
      }
      return;
    }
    if (/^\/(compact|cost|export)\b/.test(text) && (await onLocalCommand(text))) {
      setInput('');
      return;
    }
    setInput('');
    const sent = images;
    setImages([]);
    setSuggestions([]);
    await onSend(text || 'Look at the attached image(s).', sent.map(({ data, mime }) => ({ data, mime })));
  };

  return (
    <div
      className={`composer ${drag ? 'dragging' : ''}`}
      onDragOver={(e) => {
        if ([...e.dataTransfer.items].some((i) => i.type.startsWith('image/'))) {
          e.preventDefault();
          setDrag(true);
        }
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void addFiles(e.dataTransfer.files);
      }}
    >
      {suggestions.length > 0 && (
        <div className="suggest">
          {suggestions.map((s, i) => (
            <button key={s.label} className={i === sel ? 'on' : ''} onMouseDown={(e) => (e.preventDefault(), accept(s))}>
              <span className="mono">{s.label}</span>
              {s.hint && <span className="muted small">{t(s.hint)}</span>}
            </button>
          ))}
        </div>
      )}
      {(images.length > 0 || appshot) && (
        <div className="thumbs">
          {appshot && <span className="thumb" title={appshot.metadata.title}>
            <img src={`data:${appshot.mime};base64,${appshot.data}`} alt={t('Prepared Appshot')} />
            <button type="button" className="thumb-x" aria-label={t('Remove Appshot')} disabled={sendingAppshot} onClick={clearAppshot}>✕</button>
          </span>}
          {images.map((im, i) => (
            <span key={i} className="thumb" title={im.name}>
              <img src={`data:${im.mime};base64,${im.data}`} alt={im.name} />
              <button className="thumb-x" onClick={() => setImages((cur) => cur.filter((_, k) => k !== i))}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea
        ref={ta}
        value={input}
        placeholder={placeholder}
        onChange={(e) => {
          setInput(e.target.value);
          void refreshSuggestions(e.target.value, e.target.selectionStart);
        }}
        onPaste={(e) => {
          const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
          if (files.length) {
            e.preventDefault();
            void addFiles(files);
          }
        }}
        onKeyDown={(e) => {
          if (suggestions.length) {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              setSel((v) => (v + (e.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length);
              return;
            }
            if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
              e.preventDefault();
              accept(suggestions[sel]);
              return;
            }
            if (e.key === 'Escape') return setSuggestions([]);
          }
          if (e.key === 'ArrowUp' && !input && lastMessage) {
            e.preventDefault();
            setInput(lastMessage);
            return;
          }
          if (e.key === 'Escape' && running) {
            e.preventDefault();
            onAbort();
            return;
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void submit();
          }
        }}
        rows={Math.min(8, Math.max(2, input.split('\n').length))}
      />
      <div className="composer-actions">
        <label className="btn-ghost small attach" title={t("Attach images (or paste / drop them)")}>
          ⊕
          <input type="file" accept="image/*" multiple hidden onChange={(e) => e.target.files && void addFiles(e.target.files)} />
        </label>
        <AppshotButton sessionId={sessionId} capability={appshotCapability} attached={!!appshot}
          shortcut={shortcutAppshot} onShortcut={onShortcutAppshot}
          onPrepared={value => {
            pendingAppshot.current = value.id;
            setAppshot(value);
            setAppshotNotice('');
          }} />
        {appshotNotice && <span className="small" role="status">{appshotNotice}</span>}
        {extra}
        {running ? (
          <button className="btn-danger" onClick={onAbort}>
            {t("■ Stop")}
          </button>
        ) : (
          <button className="btn-primary" onClick={() => void submit()} disabled={sendingAppshot || (!input.trim() && !images.length && !appshot)}>
            {t("Send ↵")}
          </button>
        )}
      </div>
    </div>
  );
}
