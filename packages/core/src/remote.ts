import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { dirname } from 'node:path';
import { isIP } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { homePath, sunHome } from './paths.js';
import { readSettingsFile, transactSettingsFile, withFileLock } from './settings/store.js';

export function gatewayHostId(file = homePath('gateway-identity.json')): string {
  const identity = readSettingsFile(file);
  if (identity.revision !== 'missing') {
    const { id } = identity.document;
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id)) throw new Error('Invalid gateway identity file.');
    return id;
  }
  const saved = transactSettingsFile(file, 'missing', () => ({ document: { id: randomUUID() } }));
  if (saved.ok) return saved.file.document.id as string;
  if (saved.code === 'CONFLICT') return gatewayHostId(file);
  throw new Error(`Could not save gateway identity (${saved.code}).`);
}

// ---------------- TLS certificate ----------------

export interface TlsMaterial {
  cert: string;
  key: string;
  /** SHA-256 fingerprint, "AB:CD:…" (what clients pin). */
  fingerprint: string;
}

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

export function fingerprintOf(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

/**
 * Self-signed certificate for the gateway in ~/.sun/tls (created with openssl on first use).
 * Clients do not need a CA: they pin this certificate's fingerprint.
 */
export function ensureTls(opts: { dir?: string; hosts?: string[] } = {}): TlsMaterial {
  const dir = opts.dir ?? homePath('tls');
  const certFile = `${dir}/cert.pem`;
  const keyFile = `${dir}/key.pem`;
  if (!existsSync(certFile) || !existsSync(keyFile)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const ips = ['127.0.0.1', ...lanAddresses(), ...(opts.hosts ?? []).filter((h) => /^\d+\.\d+\.\d+\.\d+$/.test(h))];
    const dns = ['localhost', ...(opts.hosts ?? []).filter((h) => !/^\d+\.\d+\.\d+\.\d+$/.test(h))];
    const san = [...new Set(dns)].map((d) => `DNS:${d}`).concat([...new Set(ips)].map((i) => `IP:${i}`)).join(',');
    const r = spawnSync(
      'openssl',
      ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '825', '-subj', '/CN=sun-harness gateway', '-addext', `subjectAltName=${san}`],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) throw new Error(`openssl failed to create a certificate: ${(r.stderr || r.error?.message || '').slice(0, 400)}`);
    chmodSync(keyFile, 0o600);
  }
  const cert = readFileSync(certFile, 'utf8');
  return { cert, key: readFileSync(keyFile, 'utf8'), fingerprint: fingerprintOf(cert) };
}

// ---------------- device tokens ----------------

export interface DeviceToken {
  id: string;
  name: string;
  /** sha256 of the token; the token itself is shown once and never stored. */
  hash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export function devicesFile(): string {
  return homePath('gateway-devices.json');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function listDevices(file = devicesFile()): DeviceToken[] {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(value) || !value.every(d => typeof d?.id === 'string' && typeof d.name === 'string'
      && typeof d.createdAt === 'string' && /^[a-f0-9]{64}$/.test(d.hash))) return [];
    return value;
  } catch {
    return [];
  }
}

function writePrivateJson(file: string, value: unknown): void {
  const staged = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true });
    renameSync(staged, file);
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Create a token for one device (phone, laptop, bot). Returns the secret once. */
export function createDevice(name: string): { device: DeviceToken; token: string } {
  if (!name.trim()) throw new Error('Device name required.');
  const token = `sund_${randomBytes(24).toString('base64url')}`;
  const device: DeviceToken = { id: randomUUID(), name, hash: sha256(token), createdAt: new Date().toISOString() };
  const file = devicesFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withFileLock(file, () => {
    const list = listDevices(file);
    if (list.some(d => d.name === name)) throw new Error(`A device named "${name}" exists; revoke it first.`);
    writePrivateJson(file, [...list, device]);
  });
  return { device, token };
}

export function revokeDevice(idOrName: string): boolean {
  const file = devicesFile();
  if (!existsSync(file)) return false;
  return withFileLock(file, () => {
    const list = listDevices(file);
    const next = list.filter(d => d.id !== idOrName && d.name !== idOrName);
    if (next.length === list.length) return false;
    writePrivateJson(file, next);
    return true;
  });
}

/** Constant-time check of a presented token against the device list; records last use. */
export function matchDevice(token: string | undefined, file = devicesFile()): DeviceToken | undefined {
  if (!token?.startsWith('sund_')) return undefined;
  const h = Buffer.from(sha256(token), 'hex');
  const find = (items: DeviceToken[]) => items.find(x => {
    const other = Buffer.from(x.hash, 'hex');
    return other.length === h.length && timingSafeEqual(other, h);
  });
  const device = find(listDevices(file));
  if (!device) return undefined;
  const now = Date.now();
  if (device.lastUsedAt && now - Date.parse(device.lastUsedAt) <= 60_000) return device;
  try {
    return withFileLock(file, () => {
      const current = listDevices(file);
      const present = find(current);
      if (!present) return undefined;
      if (!present.lastUsedAt || now - Date.parse(present.lastUsedAt) > 60_000) {
        present.lastUsedAt = new Date(now).toISOString();
        writePrivateJson(file, current);
      }
      return present;
    });
  } catch {
    // Last-use metadata is best effort. Authorize only against the current list.
    return find(listDevices(file));
  }
}

// ---------------- client-side remotes ----------------

export interface RemoteEntry {
  name: string;
  url: string;
  token: string;
  /** Pinned certificate (https remotes). */
  fingerprint?: string;
  cert?: string;
  hostId?: string;
  label?: string;
}

interface RemotesFile {
  default?: string;
  desktop?: string;
  remotes: RemoteEntry[];
}

export function remoteEndpoint(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Use a gateway origin with no credentials, path, query, or fragment.');
  }
  return url.origin;
}

function remotesFile(): string {
  return homePath('remotes.json');
}

export function loadRemotes(): RemotesFile {
  try {
    return JSON.parse(readFileSync(remotesFile(), 'utf8'));
  } catch {
    return { remotes: [] };
  }
}

/** Fetch the server certificate without trusting it (trust on first use, checked against an expected fingerprint). */
export function fetchServerCert(url: string): Promise<{ cert: string; fingerprint: string }> {
  const u = new URL(remoteEndpoint(url));
  if (u.protocol !== 'https:') throw new Error('Certificate inspection requires HTTPS.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host, port: Number(u.port || 443), servername: isIP(host) ? undefined : host, rejectUnauthorized: false }, () => {
      const raw = sock.getPeerCertificate(false)?.raw;
      sock.end();
      if (!raw) return reject(new Error('Server sent no certificate.'));
      const cert = `-----BEGIN CERTIFICATE-----\n${raw.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
      resolve({ cert, fingerprint: fingerprintOf(cert) });
    });
    sock.setTimeout(10_000, () => sock.destroy(new Error('TLS connect timeout')));
    sock.on('error', reject);
  });
}

export async function addRemote(
  opts: { name: string; url: string; token: string; fingerprint?: string },
  verify?: (entry: RemoteEntry) => Promise<Pick<RemoteEntry, 'hostId' | 'label'>>,
): Promise<RemoteEntry> {
  const entry: RemoteEntry = { name: opts.name, url: remoteEndpoint(opts.url), token: opts.token };
  if (entry.url.startsWith('https://')) {
    const { cert, fingerprint } = await fetchServerCert(entry.url);
    const norm = (f: string) => f.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (opts.fingerprint && norm(opts.fingerprint) !== norm(fingerprint)) {
      throw new Error(`Certificate fingerprint mismatch: expected ${opts.fingerprint}, server presented ${fingerprint}. Not saved.`);
    }
    entry.cert = cert;
    entry.fingerprint = fingerprint;
  }
  assertRemotePin(entry);
  const prior = getRemote(entry.name);
  if (prior?.hostId) {
    if (prior.url !== entry.url) throw new Error('GATEWAY_HOST_CHANGED');
    entry.hostId = prior.hostId;
    entry.label = prior.label;
  }
  if (verify) Object.assign(entry, await verify(entry));
  storeRemote(entry);
  return entry;
}

export function assertRemotePin(entry: Pick<RemoteEntry, 'url' | 'fingerprint'>, remotes = loadRemotes().remotes): void {
  if (remotes.some(old => old.url === entry.url && old.fingerprint && old.fingerprint !== entry.fingerprint)) {
    throw new Error('GATEWAY_PIN_CHANGED: Gateway certificate fingerprint changed. Remove the previous connection before trusting a replacement.');
  }
}

export function storeRemote(entry: RemoteEntry, selectDesktop = false): void {
  const file = remotesFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withFileLock(file, () => {
    const r = loadRemotes();
    assertRemotePin(entry, r.remotes);
    const old = r.remotes.find(profile => profile.name === entry.name);
    if (old?.hostId && (old.url !== entry.url || entry.hostId && old.hostId !== entry.hostId)) throw new Error('GATEWAY_HOST_CHANGED');
    if (old?.hostId && !entry.hostId) entry = { ...entry, hostId: old.hostId, label: old.label };
    r.remotes = [...r.remotes.filter(x => x.name !== entry.name), entry];
    if (selectDesktop) r.desktop = entry.name;
    else if (!r.default) r.default = entry.name;
    writePrivateJson(file, r);
  });
}

export function clearDesktopRemote(): void {
  const file = remotesFile();
  if (!existsSync(file)) return;
  withFileLock(file, () => {
    const r = loadRemotes();
    if (r.desktop) writePrivateJson(file, { ...r, desktop: undefined });
  });
}

export function removeRemote(name: string): boolean {
  const file = remotesFile();
  if (!existsSync(file)) return false;
  return withFileLock(file, () => {
    const r = loadRemotes();
    const remotes = r.remotes.filter(x => x.name !== name);
    if (remotes.length === r.remotes.length) return false;
    writePrivateJson(file, { ...r, remotes, default: r.default === name ? remotes[0]?.name : r.default,
      desktop: r.desktop === name ? undefined : r.desktop });
    return true;
  });
}

export function useRemote(name: string | undefined): void {
  const file = remotesFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  withFileLock(file, () => {
    const r = loadRemotes();
    if (name && !r.remotes.some(x => x.name === name)) throw new Error(`No remote named ${name}.`);
    writePrivateJson(file, { ...r, default: name });
  });
}

export function getRemote(name?: string): RemoteEntry | undefined {
  const r = loadRemotes();
  const n = name ?? r.default;
  return n ? r.remotes.find((x) => x.name === n) : undefined;
}
