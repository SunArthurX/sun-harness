import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { CdpConnection } from './cdp.js';
import { sunHome } from '../paths.js';

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 30_000;
const COMMAND_MS = 4000;
const MAX_STAGED_FILES = 20;
const STALE_PART_MS = 10 * 60_000;
const stagedName = /^[a-f0-9-]{36}\.download(\.part)?$/;
const redirects = new Set([301, 302, 303, 307, 308]);

interface PausedRequest {
  requestId: string;
  redirectedRequestId?: string;
  request: { url: string; method: string };
  resourceType: string;
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: { name: string; value: string }[];
}

export interface BrowserDownloadResult {
  name: string;
  path: string;
  bytes: number;
}

function downloadDirectory(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(sessionId)) throw new Error('BROWSER_DOWNLOAD_SESSION_INVALID');
  const home = sunHome();
  mkdirSync(home, { recursive: true, mode: 0o700 });
  let dir = realpathSync(home);
  for (const part of ['browser', 'downloads', sessionId]) {
    dir = join(dir, part);
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (stat.mode & 0o022) !== 0) throw new Error('BROWSER_DOWNLOAD_DIRECTORY_INVALID');
  }
  let occupied = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !stagedName.test(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.name.endsWith('.part') && Date.now() - lstatSync(path).mtimeMs > STALE_PART_MS) unlinkSync(path);
    else occupied++;
  }
  if (occupied >= MAX_STAGED_FILES) throw new Error('BROWSER_DOWNLOAD_STAGING_FULL');
  return dir;
}

function suggestedName(url: string, disposition?: string): string {
  const quoted = /(?:^|;)\s*filename\s*=\s*(?:"([^"]*)"|([^;]*))/i.exec(disposition ?? '');
  const name = quoted?.[1] ?? quoted?.[2] ?? new URL(url).pathname;
  const leaf = basename(name.replaceAll('\\', '/')).replace(/\p{C}/gu, '').trim().slice(0, 160);
  return leaf && leaf !== '.' && leaf !== '..' ? leaf : 'download';
}

class DownloadFile {
  private readonly directory: string;
  private readonly identity: { dev: number; ino: number };
  private readonly temporary: string;
  private readonly final: string;
  private fd?: number;
  private bytes = 0;

  constructor(sessionId: string) {
    this.directory = downloadDirectory(sessionId);
    this.identity = lstatSync(this.directory);
    this.final = join(this.directory, `${randomUUID()}.download`);
    this.temporary = `${this.final}.part`;
    this.fd = openSync(this.temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  }

  private verifyDirectory(): void {
    const stat = lstatSync(this.directory);
    if (!stat.isDirectory() || stat.dev !== this.identity.dev || stat.ino !== this.identity.ino
      || realpathSync(this.directory) !== this.directory) throw new Error('BROWSER_DOWNLOAD_DIRECTORY_INVALID');
  }

  write(data: Buffer): void {
    if (data.byteLength + this.bytes > MAX_BYTES) throw new Error('BROWSER_DOWNLOAD_TOO_LARGE');
    let offset = 0;
    while (offset < data.byteLength) {
      const written = writeSync(this.fd!, data, offset, data.byteLength - offset);
      if (written === 0) throw new Error('BROWSER_DOWNLOAD_WRITE_FAILED');
      offset += written;
    }
    this.bytes += data.byteLength;
  }

  commit(name: string): BrowserDownloadResult {
    fsyncSync(this.fd!);
    this.verifyDirectory();
    const opened = fstatSync(this.fd!);
    const current = lstatSync(this.temporary);
    if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('BROWSER_DOWNLOAD_FILE_CHANGED');
    linkSync(this.temporary, this.final);
    return { name, path: this.final, bytes: this.bytes };
  }

  close(): void {
    if (this.fd !== undefined) {
      closeSync(this.fd);
      this.fd = undefined;
    }
    this.verifyDirectory();
    unlinkSync(this.temporary);
  }
}

export class BrowserDownloads {
  private readonly active = new Set<string>();

  async run(connection: CdpConnection, sessionId: string, url: string, guard: (url?: string) => void): Promise<BrowserDownloadResult> {
    if (this.active.size >= 2 || this.active.has(sessionId)) throw new Error('BROWSER_DOWNLOAD_BUSY');
    this.active.add(sessionId);
    try { return await this.fetch(connection, sessionId, url, guard); }
    finally { this.active.delete(sessionId); }
  }

  private async fetch(connection: CdpConnection, sessionId: string, url: string, guard: (url?: string) => void): Promise<BrowserDownloadResult> {
    guard(url);
    const initialUrl = new URL(url);
    initialUrl.hash = '';
    const file = new DownloadFile(sessionId);
    let targetId: string | undefined;
    let sid: string | undefined;
    let stream: string | undefined;
    let off: (() => void) | undefined;
    let settled = false;
    let name: string | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let watcher: ReturnType<typeof setInterval> | undefined;
    const requests = new Map<string, string>();
    const pendingRedirects = new Map<string, string>();
    let resolve!: (value: string) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<string>((accept, fail) => {
      resolve = accept;
      reject = fail;
    });
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const check = (requestUrl?: string) => {
      if (settled) throw new Error('BROWSER_DOWNLOAD_ABORTED');
      guard(requestUrl);
    };
    const send = <T = any>(method: string, params: Record<string, unknown> = {}) => connection.send<T>(method, params, sid, COMMAND_MS);
    async function paused(event: PausedRequest) {
      const { request, requestId, resourceType, redirectedRequestId, responseStatusCode, responseErrorReason } = event;
      check(request.url);
      if (request.method !== 'GET' || resourceType !== 'Document') throw new Error('BROWSER_DOWNLOAD_UNEXPECTED_REQUEST');
      if (responseStatusCode === undefined && responseErrorReason === undefined) {
        const expected = redirectedRequestId ? pendingRedirects.get(redirectedRequestId) : requests.size ? undefined : initialUrl.href;
        const actual = new URL(request.url);
        actual.hash = '';
        if (expected !== actual.href) throw new Error('BROWSER_DOWNLOAD_UNEXPECTED_REQUEST');
        if (redirectedRequestId) pendingRedirects.delete(redirectedRequestId);
        requests.set(requestId, request.url);
        await send('Fetch.continueRequest', { requestId, interceptResponse: true });
        return;
      }
      if (requests.get(requestId) !== request.url || responseStatusCode === undefined) throw new Error('BROWSER_DOWNLOAD_RESPONSE_FAILED');
      const header = (name: string) => event.responseHeaders?.find(entry => entry.name.toLowerCase() === name)?.value;
      if (redirects.has(responseStatusCode)) {
        const location = header('location');
        if (!location || requests.size > MAX_REDIRECTS) throw new Error('BROWSER_DOWNLOAD_REDIRECT_LIMIT');
        const next = new URL(location, request.url);
        next.hash = '';
        check(next.href);
        pendingRedirects.set(requestId, next.href);
        await send('Fetch.continueResponse', { requestId });
        return;
      }
      if (responseStatusCode < 200 || responseStatusCode >= 300) throw new Error(`BROWSER_DOWNLOAD_HTTP_${responseStatusCode}`);
      const length = header('content-length');
      if (length && Number(length) > MAX_BYTES) throw new Error('BROWSER_DOWNLOAD_TOO_LARGE');
      stream = (await send<{ stream: string }>('Fetch.takeResponseBodyAsStream', { requestId })).stream;
      while (true) {
        check(request.url);
        const chunk = await send<{ data: string; base64Encoded?: boolean; eof: boolean }>('IO.read', { handle: stream, size: 64 * 1024 });
        check(request.url);
        file.write(Buffer.from(chunk.data, chunk.base64Encoded ? 'base64' : 'utf8'));
        if (chunk.eof) break;
      }
      resolve(suggestedName(request.url, header('content-disposition')));
    }

    try {
      ({ targetId } = await connection.send('Target.createTarget', { url: 'about:blank', background: true }, undefined, COMMAND_MS));
      ({ sessionId: sid } = await connection.send('Target.attachToTarget', { targetId, flatten: true }, undefined, COMMAND_MS));
      await send('Network.enable');
      await send('Network.setBypassServiceWorker', { bypass: true });
      await send('Network.setCacheDisabled', { cacheDisabled: true });
      await send('Fetch.enable', { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] });
      off = connection.on('Fetch.requestPaused', (event, eventSid) => {
        if (eventSid === sid) void paused(event).catch(fail);
      });
      deadline = setTimeout(() => fail(new Error('BROWSER_DOWNLOAD_TIMEOUT')), TIMEOUT_MS);
      watcher = setInterval(() => {
        try {
          if (connection.isClosed) throw new Error('BROWSER_DOWNLOAD_DISCONNECTED');
          guard();
        } catch (error) { fail(error); }
      }, 100);
      check(url);
      void connection.send<{ errorText?: string }>('Page.navigate', { url: initialUrl.href }, sid, TIMEOUT_MS)
        .then(result => { if (result.errorText && !settled) fail(new Error('BROWSER_DOWNLOAD_NAVIGATION_FAILED')); }, fail);
      name = await promise;
    } finally {
      settled = true;
      clearInterval(watcher);
      clearTimeout(deadline);
      off?.();
      try {
        if (stream) await send('IO.close', { handle: stream }).catch(() => undefined);
        if (targetId) await connection.send('Target.closeTarget', { targetId }, undefined, COMMAND_MS).catch(() => undefined);
      } finally {
        if (name === undefined) file.close();
      }
    }
    try {
      guard();
      return file.commit(name);
    } finally {
      file.close();
    }
  }
}
