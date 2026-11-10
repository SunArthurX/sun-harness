import { randomUUID } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { browserOrigin } from '../browser/permissions.js';
import { homePath } from '../paths.js';
import { appendSettingsAudit } from './service.js';
import { withStorageLock } from './storage-lock.js';
import { readSettingsFile, transactSettingsFile } from './store.js';

export interface CredentialReference {
  id: string;
  revision: string;
  origin: string;
  label: string;
}

export interface CredentialInput {
  origin: string;
  label: string;
  password: string;
}

export interface CredentialVault {
  available(): Promise<boolean>;
  seal(plaintext: string): Promise<Buffer>;
  open(ciphertext: Buffer): Promise<string>;
}

export type CredentialFillResult = 'filled' | 'field-unavailable';

type StoredCredential = CredentialReference & { sealed: string };
type Grant = { reference: CredentialReference; document: string; expires: number; using: boolean };
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const grantLifetimeMs = 60_000;
const maxEntries = 128;
const maxPasswordBytes = 4096;
const vaultFile = () => homePath('credentials', 'vault.json');

export function credentialOrigin(value: string): string {
  try {
    const origin = browserOrigin(value);
    if (origin.startsWith('https://')) return origin;
  } catch { /* The error must omit the URL, including credentials and query parameters. */ }
  throw new Error('CREDENTIAL_ORIGIN_INVALID');
}

function validLabel(label: unknown): label is string {
  return typeof label === 'string' && label.trim() === label && label.length > 0 && label.length <= 120 && !/[\x00-\x1f\x7f]/.test(label);
}

function validPassword(password: unknown): password is string {
  return typeof password === 'string' && password.length > 0 && !password.includes('\0') && Buffer.byteLength(password) <= maxPasswordBytes;
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && uuid.test(id);
}

function reference(entry: StoredCredential): CredentialReference {
  const { id, revision, origin, label } = entry;
  return { id, revision, origin, label };
}

function entries(document: Record<string, unknown>): StoredCredential[] {
  if (!Object.keys(document).length) return [];
  if (document.version !== 1 || !Array.isArray(document.entries) || document.entries.length > maxEntries) throw new Error('CREDENTIAL_VAULT_INVALID');
  const seen = new Set<string>();
  for (const item of document.entries) {
    if (!item || Object.keys(item).length !== 5 || !validId(item.id) || seen.has(item.id) || !validId(item.revision) || !validLabel(item.label)
      || credentialOrigin(item.origin) !== item.origin || typeof item.sealed !== 'string' || item.sealed.length > 32_768
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.sealed)) throw new Error('CREDENTIAL_VAULT_INVALID');
    seen.add(item.id);
  }
  return document.entries;
}

function ensureVaultPath(): void {
  for (const [path, kind] of [[homePath('credentials'), 'directory'], [vaultFile(), 'file']] as const) {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (info && (kind === 'directory' ? !info.isDirectory() : !info.isFile())) throw new Error('CREDENTIAL_VAULT_INVALID');
  }
}

function readEntries(): StoredCredential[] {
  try {
    ensureVaultPath();
    return entries(readSettingsFile(vaultFile()).document);
  } catch { throw new Error('CREDENTIAL_VAULT_INVALID'); }
}

function changeEntries(edit: (previous: StoredCredential[]) => StoredCredential[]): void {
  withStorageLock(() => {
    const next = edit(readEntries());
    const result = transactSettingsFile(vaultFile(), undefined, () => ({ document: { version: 1, entries: next } }));
    if (!result.ok || result.durability !== 'confirmed') throw new Error('CREDENTIAL_VAULT_WRITE_FAILED');
  });
}

function audit(action: string, id: string, outcome: string): void {
  try { appendSettingsAudit({ action, reference: id, outcome }); }
  catch { /* Auditing has no access to credentials or site content. */ }
}

/** Private desktop extension. Only the injected document sink receives a decrypted password. */
export class CredentialBroker {
  private readonly grants = new Map<string, Grant>();

  constructor(private readonly vault: CredentialVault, private readonly now = Date.now) {}

  async available(): Promise<boolean> {
    try { return await this.vault.available(); }
    catch { return false; }
  }

  list(): CredentialReference[] {
    return readEntries().map(reference);
  }

  async save(input: CredentialInput, prior?: Pick<CredentialReference, 'id' | 'revision'>): Promise<CredentialReference> {
    const origin = credentialOrigin(input?.origin);
    const label = typeof input?.label === 'string' ? input.label.trim() : undefined;
    const password = input?.password;
    if (!validLabel(label) || !validPassword(password) || (prior && (!validId(prior.id) || !validId(prior.revision)))) {
      throw new Error('CREDENTIAL_INPUT_INVALID');
    }
    if (!await this.available()) throw new Error('CREDENTIAL_VAULT_UNAVAILABLE');
    const meta = { id: prior?.id ?? randomUUID(), revision: randomUUID(), origin, label };
    let sealed: string;
    try {
      const bytes = await this.vault.seal(JSON.stringify({ ...meta, password }));
      sealed = bytes.toString('base64');
      if (!sealed.length || sealed.length > 32_768) throw new Error('Invalid sealed value');
    } catch { throw new Error('CREDENTIAL_VAULT_UNAVAILABLE'); }
    changeEntries(previous => {
      if (prior && !previous.some(entry => entry.id === prior.id && entry.revision === prior.revision)) throw new Error('CREDENTIAL_REFERENCE_CHANGED');
      if (!prior && previous.length >= maxEntries) throw new Error('CREDENTIAL_VAULT_FULL');
      return [...previous.filter(entry => entry.id !== meta.id), { ...meta, sealed }];
    });
    audit(prior ? 'credential.replace' : 'credential.create', meta.id, 'saved');
    return meta;
  }

  remove(id: string, revision: string): void {
    if (!validId(id) || !validId(revision)) throw new Error('CREDENTIAL_INPUT_INVALID');
    changeEntries(previous => {
      if (!previous.some(entry => entry.id === id && entry.revision === revision)) throw new Error('CREDENTIAL_REFERENCE_CHANGED');
      return previous.filter(entry => entry.id !== id);
    });
    audit('credential.delete', id, 'removed');
  }

  grant(id: string, revision: string, origin: string, document: string): string {
    if (!validId(id) || !validId(revision) || !document) throw new Error('CREDENTIAL_GRANT_INVALID');
    const entry = readEntries().find(item => item.id === id && item.revision === revision);
    if (!entry || entry.origin !== credentialOrigin(origin)) throw new Error('CREDENTIAL_GRANT_INVALID');
    const now = this.now();
    for (const [token, grant] of this.grants) if (grant.expires <= now) this.grants.delete(token);
    if (this.grants.size >= 16) throw new Error('CREDENTIAL_GRANT_INVALID');
    const token = randomUUID();
    this.grants.set(token, { reference: reference(entry), document, expires: now + grantLifetimeMs, using: false });
    return token;
  }

  revoke(token: string): void {
    this.grants.delete(token);
  }

  async fill(token: string, target: { origin: string; document: string },
    dispatch: (password: string, expires: number) => Promise<CredentialFillResult>): Promise<CredentialFillResult> {
    const grant = this.grants.get(token);
    if (!grant || grant.using || grant.expires <= this.now() || grant.document !== target.document
      || grant.reference.origin !== credentialOrigin(target.origin)) throw new Error('CREDENTIAL_GRANT_INVALID');
    grant.using = true;
    const { id, revision, origin, label } = grant.reference;
    try {
      const entry = readEntries().find(item => item.id === id && item.revision === revision);
      if (!entry || entry.origin !== origin || entry.label !== label) throw new Error('CREDENTIAL_GRANT_INVALID');
      if (!await this.available()) throw new Error('CREDENTIAL_VAULT_UNAVAILABLE');
      let payload: { id: string; revision: string; origin: string; label: string; password: string };
      try {
        payload = JSON.parse(await this.vault.open(Buffer.from(entry.sealed, 'base64')));
        if (payload?.id !== id || payload.revision !== revision || payload.origin !== origin || payload.label !== label
          || !validPassword(payload.password)) throw new Error('Invalid vault envelope');
      } catch { throw new Error('CREDENTIAL_VAULT_UNAVAILABLE'); }
      const result = await withStorageLock(() => {
        if (this.grants.get(token) !== grant || grant.expires <= this.now() || !readEntries().some(item =>
          item.id === id && item.revision === revision && item.origin === origin && item.label === label && item.sealed === entry.sealed)) {
          throw new Error('CREDENTIAL_GRANT_INVALID');
        }
        try { return dispatch(payload.password, grant.expires).catch((): CredentialFillResult => 'field-unavailable'); }
        catch { return 'field-unavailable'; }
      });
      const outcome = result === 'filled' ? 'filled' : 'field-unavailable';
      audit('credential.fill', id, outcome);
      return outcome;
    } finally { this.revoke(token); }
  }
}
