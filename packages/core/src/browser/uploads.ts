import { randomUUID } from 'node:crypto';

export const BROWSER_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;
const TOTAL_BYTES = 5 * BROWSER_UPLOAD_MAX_BYTES;
const TTL_MS = 5 * 60_000;

export interface BrowserUploadTarget {
  origin: string;
  generation: string;
  document: number;
  lease: number;
  permissionRevision: string;
  maxBytes: number;
}

export interface BrowserUploadRequest {
  target: BrowserUploadTarget;
  name: string;
  data: string;
}

export interface BrowserUploadApproval {
  handle: string;
  name: string;
  bytes: number;
  expiresAt: number;
}

interface PendingUpload extends BrowserUploadApproval {
  target: BrowserUploadTarget;
  data: string;
  expiry: ReturnType<typeof setTimeout>;
}

export function sameUploadTarget(a: BrowserUploadTarget, b?: BrowserUploadTarget): boolean {
  return !!b && a.origin === b.origin && a.generation === b.generation && a.document === b.document && a.lease === b.lease
    && a.permissionRevision === b.permissionRevision;
}

export class BrowserUploads {
  private readonly pending = new Map<string, PendingUpload>();
  private bytes = 0;

  clear(sessionId: string): void {
    const previous = this.pending.get(sessionId);
    if (!previous) return;
    clearTimeout(previous.expiry);
    this.pending.delete(sessionId);
    this.bytes -= previous.bytes;
  }

  approve(sessionId: string, target: BrowserUploadTarget, request: BrowserUploadRequest): BrowserUploadApproval {
    if (!sameUploadTarget(target, request?.target)) throw new Error('BROWSER_UPLOAD_TARGET_STALE');
    const { name, data } = request;
    if (typeof name !== 'string' || !name || name.length > 255 || /[/\\\p{C}]/u.test(name) || name === '.' || name === '..'
      || typeof data !== 'string' || data.length > Math.ceil(BROWSER_UPLOAD_MAX_BYTES / 3) * 4) throw new Error('BROWSER_UPLOAD_INVALID');
    const decoded = Buffer.from(data, 'base64');
    if (decoded.length > BROWSER_UPLOAD_MAX_BYTES || decoded.toString('base64') !== data) throw new Error('BROWSER_UPLOAD_INVALID');
    const previous = this.pending.get(sessionId);
    if (this.bytes - (previous?.bytes ?? 0) + decoded.length > TOTAL_BYTES || (!previous && this.pending.size >= 32)) {
      throw new Error('BROWSER_UPLOAD_BUSY');
    }
    this.clear(sessionId);
    const approval = { handle: randomUUID(), name, bytes: decoded.length, expiresAt: Date.now() + TTL_MS };
    const expiry = setTimeout(() => this.clear(sessionId), TTL_MS);
    expiry.unref();
    this.pending.set(sessionId, { ...approval, target, data, expiry });
    this.bytes += decoded.length;
    return approval;
  }

  private current(sessionId: string, target: BrowserUploadTarget): PendingUpload | undefined {
    const upload = this.pending.get(sessionId);
    if (upload && (Date.now() >= upload.expiresAt || !sameUploadTarget(target, upload.target))) {
      this.clear(sessionId);
      return;
    }
    return upload;
  }

  list(sessionId: string, target: BrowserUploadTarget): BrowserUploadApproval[] {
    const upload = this.current(sessionId, target);
    if (!upload) return [];
    const { handle, name, bytes, expiresAt } = upload;
    return [{ handle, name, bytes, expiresAt }];
  }

  consume(sessionId: string, target: BrowserUploadTarget, handle: string): Pick<PendingUpload, 'name' | 'data'> {
    const upload = this.current(sessionId, target);
    if (!upload || upload.handle !== handle) throw new Error('BROWSER_UPLOAD_HANDLE_INVALID');
    this.clear(sessionId);
    return { name: upload.name, data: upload.data };
  }
}
