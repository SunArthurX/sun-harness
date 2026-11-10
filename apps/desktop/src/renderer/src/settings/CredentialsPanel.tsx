import { useEffect, useState, type FormEvent } from 'react';
import type { CredentialReference } from '@sun/core';
import { api } from '../api';
import { t } from '../i18n';

type Vault = Awaited<ReturnType<typeof api.listDesktopCredentials>>;
type Edit = { kind: 'save'; entry?: CredentialReference } | { kind: 'delete' | 'sign-in'; entry: CredentialReference };

export function CredentialsPanel({ reportActivity }: { reportActivity(dirty: boolean, saving: boolean): void }) {
  const [vault, setVault] = useState<Vault>();
  const [edit, setEdit] = useState<Edit>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const refresh = async () => setVault(await api.listDesktopCredentials());
  useEffect(() => { void refresh().catch(() => setNotice(t('The password vault could not be opened.'))); }, []);
  useEffect(() => reportActivity(!!edit, busy), [edit, busy, reportActivity]);
  useEffect(() => () => reportActivity(false, false), [reportActivity]);

  const perform = async (action: () => Promise<void>, failure: string) => {
    setBusy(true);
    setNotice('');
    try { await action(); setEdit(undefined); }
    catch { setNotice(failure); }
    finally { setBusy(false); }
  };

  const save = (event: FormEvent<HTMLFormElement>, entry?: CredentialReference) => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const input = { origin: String(fields.get('origin')), label: String(fields.get('label')), password: String(fields.get('password')) };
    event.currentTarget.querySelector<HTMLInputElement>('input[type=password]')!.value = '';
    void perform(async () => {
      await api.saveDesktopCredential(input, entry);
      await refresh();
    }, t('The password could not be saved. Check the HTTPS address and your system vault.'));
  };

  return <>
    <p className="small muted">{t('Website passwords are protected by this computer’s macOS Keychain. Private sign-in stays separate from agent browsers and remote gateways.')}</p>
    {vault && !vault.available && <p>{t('The system vault is unavailable. Use browser takeover to sign in manually.')}</p>}
    {vault?.entries.map(entry => <div className="card row" key={entry.id}>
      <strong>{entry.label}</strong><span>{entry.origin}</span>
      <button type="button" disabled={busy || !!edit || !vault.available} onClick={() => setEdit({ kind: 'sign-in', entry })}>{t('Private sign-in')}</button>
      <button type="button" disabled={busy || !!edit || !vault.available} onClick={() => setEdit({ kind: 'save', entry })}>{t('Replace password')}</button>
      <button type="button" disabled={busy || !!edit} onClick={() => setEdit({ kind: 'delete', entry })}>{t('Remove password')}</button>
    </div>)}
    {vault?.available && !edit && <button type="button" onClick={() => setEdit({ kind: 'save' })}>{t('Add website password')}</button>}
    {edit?.kind === 'save' && <form className="card credential-fields" autoComplete="off" onSubmit={event => save(event, edit.entry)}>
      <label>{t('Website HTTPS address')}<input name="origin" type="url" maxLength={8192} required defaultValue={edit.entry?.origin} /></label>
      <label>{t('Account label')}<input name="label" maxLength={120} required defaultValue={edit.entry?.label} /></label>
      <label>{t('Website password')}<input name="password" type="password" autoComplete="new-password" maxLength={4096} required /></label>
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>{t('Save password')}</button>
        <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>{t('Cancel')}</button>
      </div>
    </form>}
    {edit?.kind === 'sign-in' && <form className="card credential-fields" onSubmit={event => {
      event.preventDefault();
      const url = String(new FormData(event.currentTarget).get('url'));
      void perform(() => api.openDesktopCredentialSignIn(edit.entry, url), t('Private sign-in could not open. Check the address and close any other private sign-in window.'));
    }}>
      <label>{t('Sign-in page HTTPS address')}<input type="url" name="url" maxLength={8192} required defaultValue={edit.entry.origin} /></label>
      <p className="small muted">{t('The sign-in page must use the saved origin {origin}.', { origin: edit.entry.origin })}</p>
      <div className="row">
        <button type="submit" className="btn-primary" disabled={busy}>{t('Open private sign-in')}</button>
        <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>{t('Cancel')}</button>
      </div>
    </form>}
    {edit?.kind === 'delete' && <div className="card">
      <p>{t('Remove the saved password for {label}?', { label: edit.entry.label })}</p>
      <div className="row">
        <button type="button" disabled={busy} onClick={() => { void perform(async () => {
          await api.deleteDesktopCredential(edit.entry);
          await refresh();
        }, t('The password could not be removed. Refresh Settings and try again.')); }}>{t('Confirm password removal')}</button>
        <button type="button" disabled={busy} onClick={() => setEdit(undefined)}>{t('Cancel')}</button>
      </div>
    </div>}
    {notice && <p role="status">{notice}</p>}
  </>;
}
