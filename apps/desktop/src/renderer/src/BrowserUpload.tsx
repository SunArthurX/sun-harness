import { useState } from 'react';
import type { BrowserUploadTarget } from '@sun/core';
import { api } from './api';
import { t } from './i18n';

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function BrowserUpload({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const [selection, setSelection] = useState<{ name: string; bytes: number; data: string; target: BrowserUploadTarget }>();
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  async function select(file: File) {
    setSelection(undefined);
    setNotice('');
    setBusy(true);
    try {
      const target = await api.previewBrowserUpload(sessionId);
      if (file.size > target.maxBytes) {
        setNotice(t('The file exceeds the browser upload limit of {size} MiB.', { size: target.maxBytes / 1024 ** 2 }));
        return;
      }
      const data = await readFile(file);
      setSelection({ name: file.name, bytes: file.size, data, target });
    } catch {
      setNotice(t('Open an approved website in this session before selecting a file.'));
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!selection || busy || disabled) return;
    setBusy(true);
    setNotice('');
    try {
      const { name, data, target } = selection;
      await api.approveBrowserUpload(sessionId, { target, name, data });
      setSelection(undefined);
      setNotice(t('The agent can use this file once on the approved page.'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message.includes('BROWSER_PERMISSION_REQUIRED') || message.includes('BROWSER_PERMISSION_DENIED')
        ? t('Review upload access for this origin in Browser permissions, then select the file again.')
        : t('The file approval could not be saved. Select the file again on the current page.'));
      setSelection(undefined);
    } finally {
      setBusy(false);
    }
  }

  return <div className="small browser-hint">
    <label>{t('Choose a browser upload')} <input type="file" disabled={disabled || busy} onChange={event => {
      const file = event.target.files?.[0];
      event.target.value = '';
      if (file) void select(file);
    }} /></label>
    {selection && <div>
      <p>{t('Approve {name} ({bytes} bytes) for {origin}?', { name: selection.name, bytes: selection.bytes, origin: selection.target.origin })}</p>
      <button className="btn-primary small" disabled={disabled || busy} onClick={approve}>{t('Approve file for this page')}</button>
      <button className="btn-ghost small" disabled={busy} onClick={() => setSelection(undefined)}>{t('Cancel')}</button>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
