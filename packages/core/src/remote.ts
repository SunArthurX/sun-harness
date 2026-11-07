import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import { homePath, sunHome } from './paths.js';

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

function devicesFile(): string {
  return homePath('gateway-devices.json');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export function listDevices(): DeviceToken[] {
  try {
    return JSON.parse(readFileSync(devicesFile(), 'utf8'));
  } catch {
    return [];
  }
}

function saveDevices(list: DeviceToken[]): void {
  mkdirSync(sunHome(), { recursive: true });
  writeFileSync(devicesFile(), JSON.stringify(list, null, 2), { mode: 0o600 });
}

/** Create a token for one device (phone, laptop, bot). Returns the secret once. */
export function createDevice(name: string): { device: DeviceToken; token: string } {
  if (!name.trim()) throw new Error('Device name required.');
  if (listDevices().some((d) => d.name === name)) throw new Error(`A device named "${name}" exists; revoke it first.`);
  const token = `sund_${randomBytes(24).toString('base64url')}`;
  const device: DeviceToken = { id: randomBytes(4).toString('hex'), name, hash: sha256(token), createdAt: new Date().toISOString() };
  saveDevices([...listDevices(), device]);
  return { device, token };
}

export function revokeDevice(idOrName: string): boolean {
  const list = listDevices();
  const next = list.filter((d) => d.id !== idOrName && d.name !== idOrName);
  saveDevices(next);
  return next.length !== list.length;
}

/** Constant-time check of a presented token against the device list; records last use. */
export function matchDevice(token: string | undefined, list = listDevices()): DeviceToken | undefined {
  if (!token?.startsWith('sund_')) return undefined;
  const h = Buffer.from(sha256(token), 'hex');
  const d = list.find((x) => {
    const other = Buffer.from(x.hash, 'hex');
    return other.length === h.length && timingSafeEqual(other, h);
  });
  if (d) {
    const now = Date.now();
    if (!d.lastUsedAt || now - Date.parse(d.lastUsedAt) > 60_000) {
      d.lastUsedAt = new Date(now).toISOString();
      saveDevices(list);
    }
  }
  return d;
}

// ---------------- client-side remotes ----------------

export interface RemoteEntry {
  name: string;
  url: string;
  token: string;
  /** Pinned certificate (https remotes). */
  fingerprint?: string;
  cert?: string;
}

interface RemotesFile {
  default?: string;
  remotes: RemoteEntry[];
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

function saveRemotes(r: RemotesFile): void {
  mkdirSync(sunHome(), { recursive: true });
  writeFileSync(remotesFile(), JSON.stringify(r, null, 2), { mode: 0o600 });
}

/** Fetch the server certificate without trusting it (trust on first use, checked against an expected fingerprint). */
export function fetchServerCert(url: string): Promise<{ cert: string; fingerprint: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: u.hostname, port: Number(u.port || 443), servername: /^\d/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false }, () => {
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

export async function addRemote(opts: { name: string; url: string; token: string; fingerprint?: string }): Promise<RemoteEntry> {
  const entry: RemoteEntry = { name: opts.name, url: opts.url.replace(/\/$/, ''), token: opts.token };
  if (entry.url.startsWith('https://')) {
    const { cert, fingerprint } = await fetchServerCert(entry.url);
    const norm = (f: string) => f.replace(/[^0-9a-f]/gi, '').toUpperCase();
    if (opts.fingerprint && norm(opts.fingerprint) !== norm(fingerprint)) {
      throw new Error(`Certificate fingerprint mismatch: expected ${opts.fingerprint}, server presented ${fingerprint}. Not saved.`);
    }
    entry.cert = cert;
    entry.fingerprint = fingerprint;
  }
  const r = loadRemotes();
  r.remotes = [...r.remotes.filter((x) => x.name !== entry.name), entry];
  if (!r.default) r.default = entry.name;
  saveRemotes(r);
  return entry;
}

export function removeRemote(name: string): boolean {
  const r = loadRemotes();
  const before = r.remotes.length;
  r.remotes = r.remotes.filter((x) => x.name !== name);
  if (r.default === name) r.default = r.remotes[0]?.name;
  saveRemotes(r);
  return r.remotes.length !== before;
}

export function useRemote(name: string | undefined): void {
  const r = loadRemotes();
  if (name && !r.remotes.some((x) => x.name === name)) throw new Error(`No remote named ${name}.`);
  r.default = name;
  saveRemotes(r);
}

export function getRemote(name?: string): RemoteEntry | undefined {
  const r = loadRemotes();
  const n = name ?? r.default;
  return n ? r.remotes.find((x) => x.name === n) : undefined;
}
