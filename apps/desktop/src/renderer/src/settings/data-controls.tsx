import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { BUNDLE_MAX_BYTES, BUNDLE_MAX_COMPRESSED_BYTES } from '@sun/core/settings-protocol';
import type { SessionSummary, StorageCategory, StorageInventory, StorageItem, StorageOperation, StoragePreview } from '@sun/core';
import { api } from '../api';
import { fmtDate, locale, t, tk } from '../i18n';

type OpenSession = (id: string) => void;
type Activity = (dirty: boolean, saving: boolean) => void;

function useSessions() {
  const [sessions, setSessions] = useState<SessionSummary[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const off = window.sun.onLive(event => { if (event.kind === 'sessions') setSessions(event.sessions); });
    void api.listSessions().then(items => { if (!cancelled) setSessions(items); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; off(); };
  }, []);
  return { sessions, failed };
}

export function ArchivesPanel({ onOpen }: { onOpen: OpenSession }) {
  const { sessions, failed } = useSessions();
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState('');
  const items = sessions?.filter(item => item.archived && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  async function restore(item: SessionSummary) {
    setBusy(item.id);
    try {
      await api.setSessionFlags(item.id, { archived: false });
      setMessage(t('Restored {title}', { title: item.title }));
    } catch {
      setMessage(t('Could not restore the archived chat.'));
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <div className="card settings-fields">
      <p className="muted small">{t('Archived chats keep their history. Restoring a chat returns it to the session list.')}</p>
      <label htmlFor="archived-search">{t('Search archived chats')}</label>
      <input id="archived-search" type="search" value={query} onChange={event => setQuery(event.target.value)} />
      {failed && <p role="alert">{t('Could not load sessions.')}</p>}
      {items?.length === 0 && <p>{t('No matching archived chats.')}</p>}
      {items && items.length > 0 && <ul className="data-items">
        {items.map(item => <li key={item.id} className="row" data-archive-id={item.id}>
          <button type="button" className="link" onClick={() => onOpen(item.id)}>{item.title}</button>
          <small className="muted">{fmtDate(item.updatedAt)}</small>
          <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void restore(item)}>{t('Restore chat')}</button>
        </li>)}
      </ul>}
      <p role="status">{message}</p>
    </div>
  );
}

export function TransferPanel({ onOpen, reportActivity }: { onOpen: OpenSession; reportActivity: Activity }) {
  const { sessions, failed } = useSessions();
  const [selected, setSelected] = useState('');
  const [file, setFile] = useState<File>();
  const [cwd, setCwd] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [imported, setImported] = useState<SessionSummary>();
  const fileInput = useRef<HTMLInputElement>(null);
  const session = sessions?.find(item => item.id === selected) ?? sessions?.[0];

  useLayoutEffect(() => reportActivity(false, busy), [busy, reportActivity]);
  useLayoutEffect(() => () => reportActivity(false, false), [reportActivity]);

  async function download() {
    if (!session || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const bytes = await api.exportSessionBundle(session.id);
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = `${session.id}.sunbundle`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setMessage(t('Could not download the session bundle.'));
    } finally {
      setBusy(false);
    }
  }

  async function upload() {
    if (!file || busy) return;
    const name = file.name.toLowerCase();
    const bundle = name.endsWith('.sunbundle');
    setImported(undefined);
    if (!bundle && !name.endsWith('.jsonl')) {
      setMessage(t('Choose a .sunbundle or .jsonl file.'));
      return;
    }
    if (file.size > (bundle ? BUNDLE_MAX_COMPRESSED_BYTES : BUNDLE_MAX_BYTES)) {
      setMessage(t('This file exceeds the session import size limit.'));
      return;
    }
    setBusy(true);
    setMessage('');
    try {
      const options = { cwd: cwd.trim() || undefined };
      const result = bundle
        ? await api.importSessionBundle(new Uint8Array(await file.arrayBuffer()), options)
        : await api.importSession(await file.text(), options);
      setImported(result);
      setFile(undefined);
      if (fileInput.current) fileInput.current.value = '';
    } catch (error) {
      setMessage(error instanceof Error && error.message.includes('IMPORT_WORKSPACE_REQUIRED')
        ? t('Choose an existing absolute workspace on the execution host.')
        : t('Could not import this file. Check the session format and attachments.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="card settings-fields">
        <h3>{t('Export session')}</h3>
        <p className="muted small">{t('A portable bundle includes the transcript and its saved images.')}</p>
        <label htmlFor="data-export-session">{t('Session to export')}</label>
        <select id="data-export-session" value={session?.id ?? ''} onChange={event => setSelected(event.target.value)} disabled={busy || !session}>
          {!session && <option value="">{t('No sessions yet.')}</option>}
          {sessions?.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
        </select>
        {failed && <p role="alert">{t('Could not load sessions.')}</p>}
        <button className="btn-ghost" type="button" disabled={busy || !session} onClick={() => void download()}>{t('Download session bundle')}</button>
      </section>
      <form className="card settings-fields" onSubmit={event => { event.preventDefault(); void upload(); }}>
        <h3>{t('Import session')}</h3>
        <label htmlFor="data-import-file">{t('Session file')}</label>
        <input id="data-import-file" ref={fileInput} type="file" accept=".sunbundle,.jsonl" disabled={busy} onChange={event => {
          setFile(event.target.files?.[0]);
          setImported(undefined);
          setMessage('');
        }} />
        <label htmlFor="data-import-workspace">{t('Replacement workspace (optional)')}</label>
        <input id="data-import-workspace" value={cwd} disabled={busy} onChange={event => setCwd(event.target.value)} />
        <p className="muted small">{t('Enter an absolute path on the execution host if the original workspace is unavailable.')}</p>
        <button type="submit" className="btn-primary" disabled={!file || busy}>{t('Import session')}</button>
      </form>
      {message && <p role="alert">{message}</p>}
      {imported && (
        <div className="row" role="status">
          <span>{t('Imported {title}', { title: imported.title })}</span>
          <button type="button" className="btn-ghost" onClick={() => onOpen(imported.id)}>{t('Open chat')}</button>
        </div>
      )}
    </>
  );
}

const categories: Record<StorageCategory, string> = {
  sessions: tk('Sessions'), attachments: tk('Attachments'), caches: tk('Caches'),
  jobs: tk('Jobs'), browserProfiles: tk('Browser profiles'), worktrees: tk('Worktrees'),
};
const pageSize = 60;

function storageSize(bytes: number): string {
  if (bytes < 1024) return t('{size} B', { size: bytes });
  if (bytes < 1024 * 1024) return t('{size} KiB', { size: (bytes / 1024).toLocaleString(locale(), { maximumFractionDigits: 1 }) });
  return t('{size} MiB', { size: (bytes / (1024 * 1024)).toLocaleString(locale(), { maximumFractionDigits: 2 }) });
}

function storageReason(reason: StorageItem['reason']): string {
  switch (reason) {
    case 'ACTIVE': return t('Active or still in use');
    case 'REFERENCED': return t('Referenced by a retained session');
    case 'UNARCHIVED': return t('Archive this chat first');
    case 'WORKTREE': return t('Managed by the Git worktree workflow');
    case 'PROFILE_SCOPE': return t('Requires browser profile selection');
    case 'PROTECTED': return t('Ownership or completion could not be verified');
    default: return '';
  }
}

function storageFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('STORAGE_STALE')) return t('Storage changed. Preview the current selection again.');
  if (message.includes('STORAGE_INELIGIBLE')) return t('A selected item is no longer eligible for cleanup.');
  if (message.includes('STORAGE_INCOMPLETE')) return t('The inventory is incomplete. Cleanup is unavailable.');
  return t('The storage operation could not be completed. Refresh to check its status.');
}

export function StoragePanel({ reportActivity }: { reportActivity: Activity }) {
  const [inventory, setInventory] = useState<StorageInventory>();
  const [operations, setOperations] = useState<StorageOperation[]>([]);
  const [category, setCategory] = useState<StorageCategory>('sessions');
  const [includeProfiles, setIncludeProfiles] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<StoragePreview>();
  const [confirmProfiles, setConfirmProfiles] = useState(false);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [moving, setMoving] = useState(false);
  const sequence = useRef(0);
  const busy = loading || moving;
  const rows = inventory?.items.filter(item => item.category === category) ?? [];

  useLayoutEffect(() => reportActivity(false, moving), [moving, reportActivity]);
  useLayoutEffect(() => () => reportActivity(false, false), [reportActivity]);

  async function refresh(scope: boolean) {
    const ticket = ++sequence.current;
    setLoading(true);
    setPreview(undefined);
    setConfirmProfiles(false);
    setSelected([]);
    setPage(0);
    try {
      const [next, recent] = await Promise.all([api.storageInventory(scope), api.storageOperations()]);
      if (ticket !== sequence.current) return;
      setInventory(next);
      setOperations(recent);
    } catch (error) {
      if (ticket === sequence.current) { setInventory(undefined); setMessage(storageFailure(error)); }
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  }

  useEffect(() => { void refresh(includeProfiles); }, [includeProfiles]);

  function select(id: string, checked: boolean) {
    setSelected(previous => checked ? [...previous, id] : previous.filter(value => value !== id));
    setPreview(undefined);
    setConfirmProfiles(false);
    setMessage('');
  }

  async function prepare() {
    setLoading(true);
    setMessage('');
    try { setPreview(await api.previewStorage(selected, includeProfiles)); }
    catch (error) { setMessage(storageFailure(error)); }
    finally { setLoading(false); }
  }

  async function move() {
    if (!preview || busy || (preview.includesProfiles && !confirmProfiles)) return;
    setMoving(true);
    setMessage('');
    try {
      const result = await api.moveStorage({ ids: preview.items.map(item => item.id), revision: preview.revision, includeProfiles, confirmProfiles });
      setMessage(t('Moved {moved} resources to trash. Skipped {skipped}.', { moved: result.moved, skipped: result.skipped }));
    } catch (error) {
      setMessage(storageFailure(error));
    } finally {
      await refresh(includeProfiles);
      setMoving(false);
    }
  }

  return (
    <>
      <section className="card settings-fields">
        <h3>{t('Storage on the execution host')}</h3>
        <p className="muted small">{t('Cleanup moves selected files on the execution host. Copies retained by providers are managed separately.')}</p>
        {inventory && (
          <div className="settings-metrics"><table className="metrics">
            <thead><tr><th>{t('Resource')}</th><th>{t('Items')}</th><th>{t('Size')}</th></tr></thead>
            <tbody>{(Object.keys(categories) as StorageCategory[]).map(key => <tr key={key}>
              <td>{t(categories[key])}</td><td>{inventory.totals[key].items}</td><td>{storageSize(inventory.totals[key].bytes)}</td>
            </tr>)}</tbody>
          </table></div>
        )}
        {inventory?.complete === false && <p role="alert">{t('The inventory is incomplete. Cleanup is unavailable.')}</p>}
        <label htmlFor="storage-category">{t('Resource category')}</label>
        <select id="storage-category" value={category} disabled={busy} onChange={event => { setCategory(event.target.value as StorageCategory); setPage(0); }}>
          {(Object.keys(categories) as StorageCategory[]).map(key => <option key={key} value={key}>{t(categories[key])}</option>)}
        </select>
        <label><input type="checkbox" checked={includeProfiles} disabled={busy}
          onChange={event => { setMessage(''); setIncludeProfiles(event.target.checked); }} /> {t('Include stopped browser profiles')}</label>
        <ul className="data-items">
          {rows.slice(page * pageSize, (page + 1) * pageSize).map(item => <li key={item.id} data-storage-item={item.id}>
            <label className="row">
              <input type="checkbox" checked={selected.includes(item.id)} disabled={!!item.reason || !inventory?.complete || busy}
                onChange={event => select(item.id, event.target.checked)} />
              <span>{item.label}</span>
              <small className="muted">{storageSize(item.bytes)} {storageReason(item.reason)}</small>
            </label>
          </li>)}
        </ul>
        {rows.length > pageSize && <div className="row">
          <button type="button" className="btn-ghost" disabled={!page || busy} onClick={() => setPage(page - 1)}>{t('Previous page')}</button>
          <button type="button" className="btn-ghost" disabled={(page + 1) * pageSize >= rows.length || busy} onClick={() => setPage(page + 1)}>{t('Next page')}</button>
        </div>}
        <div className="row">
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => { setMessage(''); void refresh(includeProfiles); }}>{t('Refresh')}</button>
          <button type="button" className="btn-primary" disabled={!selected.length || busy} onClick={() => void prepare()}>{t('Preview cleanup')}</button>
        </div>
        {message && <p role="status">{message}</p>}
      </section>
      {preview && <section className="card settings-fields">
        <h3>{t('Review cleanup')}</h3>
        <p>{t('{count} selected items · {size}', { count: preview.items.length, size: storageSize(preview.bytes) })}</p>
        <ul className="data-items">{preview.items.map(item => <li key={item.id}>{item.label}</li>)}</ul>
        {preview.includesProfiles && <label><input type="checkbox" checked={confirmProfiles} disabled={moving}
          onChange={event => setConfirmProfiles(event.target.checked)} /> {t('I understand this signs me out of the selected browser profiles.')}</label>}
        <button type="button" className="btn-primary" disabled={busy || (preview.includesProfiles && !confirmProfiles)} onClick={() => void move()}>{t('Move selected to trash')}</button>
      </section>}
      {operations.length > 0 && <section className="card settings-fields">
        <h3>{t('Recent trash operations')}</h3>
        <ul className="data-items">{operations.map(operation => <li key={operation.id}>
          {t('{moved} in trash · {pending} pending · {skipped} skipped · {purged} purged', {
            moved: operation.moved, pending: operation.pending, skipped: operation.skipped, purged: operation.purged,
          })}
          {operation.moved > 0 && <small className="muted"> {t('Purge after {date}', { date: fmtDate(operation.purgeAfter) })}</small>}
        </li>)}</ul>
      </section>}
    </>
  );
}
