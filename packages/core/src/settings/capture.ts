import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { ownedAttachment } from '../attachments.js';
import { sunHome } from '../paths.js';
import { imageSignature } from './bundle.js';

export const APPSHOT_MAX_BYTES = 10 * 1024 * 1024;
export const APPSHOT_MAX_TEXT = 20_000;
const MAX_PIXELS = 16_000_000;
const DRAFT_MS = 5 * 60_000;

export interface AppshotRect { x: number; y: number; width: number; height: number }
export interface AppshotEdits { crop?: AppshotRect; masks: AppshotRect[]; includeText: boolean }
export interface AppshotImage {
  mime: 'image/png' | 'image/jpeg';
  data: string;
  width: number;
  height: number;
}
export interface AppshotWindow { appId: string; title: string; windowId: string }
export interface AppshotCapture extends AppshotImage, AppshotWindow {
  intendedWindow?: AppshotWindow;
  text?: string;
  textTruncated?: boolean;
}
export interface AppshotPreview extends AppshotCapture { id: string; capturedAt: string; targetChanged: boolean }
export interface AppshotMetadata extends AppshotWindow {
  sha256: string;
  bytes: number;
  width: number;
  height: number;
  capturedAt: string;
  text?: string;
  textTruncated?: boolean;
}
export interface PreparedAppshot extends AppshotImage {
  id: string;
  metadata: AppshotMetadata;
}
export type AppshotScope = 'own-app' | 'frontmost';
export type AppshotAdapter = {
  status(): 'available' | 'disabled' | 'unavailable' | 'error' | {
    state: 'available' | 'disabled' | 'unavailable' | 'error'; reasonCode: string;
  };
  capture(scope: AppshotScope): Promise<AppshotCapture>;
  render(source: AppshotImage, edits: AppshotEdits): Promise<AppshotImage>;
};

function safeWindow(input: AppshotWindow): AppshotWindow {
  if (!input || typeof input.appId !== 'string' || !input.appId || typeof input.windowId !== 'string'
    || !input.windowId || typeof input.title !== 'string') throw new Error('APPSHOT_TARGET_INVALID');
  const label = (value: string, max: number) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
  return { appId: label(input.appId, 240), windowId: label(input.windowId, 128), title: label(input.title, 512) };
}

function decode(image: AppshotImage): Buffer {
  if (!image || (image.mime !== 'image/png' && image.mime !== 'image/jpeg')
    || typeof image.data !== 'string' || image.data.length > Math.ceil(APPSHOT_MAX_BYTES / 3) * 4
    || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height)
    || image.width < 1 || image.height < 1 || image.width * image.height > MAX_PIXELS) throw new Error('APPSHOT_IMAGE_INVALID');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.length > APPSHOT_MAX_BYTES || bytes.toString('base64') !== image.data
    || !imageSignature(bytes, image.mime)) throw new Error('APPSHOT_IMAGE_INVALID');
  return bytes;
}

function validRect(rect: AppshotRect, image: AppshotImage): boolean {
  return !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger)
    && rect.x >= 0 && rect.y >= 0 && rect.width > 0 && rect.height > 0
    && rect.x + rect.width <= image.width && rect.y + rect.height <= image.height;
}

export function isAppshotMetadata(value: unknown): value is AppshotMetadata {
  if (!value || typeof value !== 'object') return false;
  const m = value as AppshotMetadata;
  return typeof m.appId === 'string' && !!m.appId && m.appId.length <= 240
    && typeof m.windowId === 'string' && !!m.windowId && m.windowId.length <= 128
    && typeof m.title === 'string' && m.title.length <= 512
    && typeof m.sha256 === 'string' && /^[a-f0-9]{64}$/.test(m.sha256)
    && Number.isSafeInteger(m.bytes) && m.bytes > 0 && m.bytes <= APPSHOT_MAX_BYTES
    && Number.isSafeInteger(m.width) && Number.isSafeInteger(m.height)
    && m.width > 0 && m.height > 0 && m.width * m.height <= MAX_PIXELS
    && typeof m.capturedAt === 'string' && Number.isFinite(Date.parse(m.capturedAt))
    && (m.text === undefined || (typeof m.text === 'string' && m.text.length <= APPSHOT_MAX_TEXT))
    && (m.textTruncated === undefined || typeof m.textTruncated === 'boolean');
}

interface Draft {
  sessionId: string;
  id: string;
  timeout: ReturnType<typeof setTimeout>;
  preview?: AppshotPreview;
  prepared?: PreparedAppshot;
  preparing?: boolean;
  claimed?: boolean;
}

export class AppshotDrafts {
  private draft?: Draft;

  async capture(sessionId: string, adapter: AppshotAdapter, scope: AppshotScope = 'frontmost'): Promise<AppshotPreview> {
    if (this.draft) throw new Error('APPSHOT_DRAFT_BUSY');
    const id = randomUUID();
    const timeout = setTimeout(() => this.cancel(sessionId, id), DRAFT_MS);
    timeout.unref();
    const draft: Draft = { sessionId, id, timeout };
    this.draft = draft;
    try {
      const result = await adapter.capture(scope);
      if (this.draft !== draft) throw new Error('APPSHOT_DRAFT_STALE');
      decode(result);
      const window = safeWindow(result);
      const intendedWindow = result.intendedWindow ? safeWindow(result.intendedWindow) : undefined;
      const text = typeof result.text === 'string' ? result.text.slice(0, APPSHOT_MAX_TEXT) : undefined;
      const textTruncated = typeof result.text === 'string' && (result.text.length > APPSHOT_MAX_TEXT || result.textTruncated === true);
      const { mime, data, width, height } = result;
      draft.preview = { ...window, mime, data, width, height, id, capturedAt: new Date().toISOString(),
        ...(intendedWindow ? { intendedWindow } : {}),
        targetChanged: !!intendedWindow && (window.appId !== intendedWindow.appId || window.windowId !== intendedWindow.windowId),
        ...(text ? { text, ...(textTruncated ? { textTruncated } : {}) } : {}) };
      return structuredClone(draft.preview);
    } catch (error) {
      this.cancel(sessionId, id);
      throw error;
    }
  }

  async prepare(sessionId: string, id: string, edits: AppshotEdits, adapter: AppshotAdapter): Promise<PreparedAppshot> {
    const draft = this.draft;
    const source = draft?.preview;
    if (!draft || !source || draft.sessionId !== sessionId || draft.id !== id || draft.preparing) throw new Error('APPSHOT_DRAFT_STALE');
    if (!edits || typeof edits.includeText !== 'boolean' || !Array.isArray(edits.masks) || edits.masks.length > 20
      || edits.masks.some(mask => !validRect(mask, source)) || (edits.crop !== undefined && !validRect(edits.crop, source))) {
      throw new Error('APPSHOT_EDITS_INVALID');
    }
    draft.preparing = true;
    try {
      const cleanEdits = structuredClone(edits);
      const { mime, data, width, height } = source;
      const image = await adapter.render({ mime, data, width, height }, cleanEdits);
      if (this.draft !== draft) throw new Error('APPSHOT_DRAFT_STALE');
      const bytes = decode(image);
      if (image.width !== (edits.crop?.width ?? width) || image.height !== (edits.crop?.height ?? height)) {
        throw new Error('APPSHOT_IMAGE_INVALID');
      }
      const includeText = edits.includeText && !edits.crop && !edits.masks.length && !!source.text;
      const metadata = {
        ...safeWindow(source), capturedAt: source.capturedAt, width: image.width, height: image.height,
        sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        ...(includeText ? { text: source.text, ...(source.textTruncated ? { textTruncated: true } : {}) } : {}),
      };
      draft.prepared = { id, mime: image.mime, data: image.data, width: image.width, height: image.height, metadata };
      draft.preview = undefined;
      return structuredClone(draft.prepared);
    } finally { draft.preparing = false; }
  }

  claim(sessionId: string, id: string): { image: PreparedAppshot; finish(consumed: boolean): void } {
    const draft = this.draft;
    if (!draft || draft.sessionId !== sessionId || draft.id !== id || !draft.prepared || draft.claimed) throw new Error('APPSHOT_DRAFT_STALE');
    draft.claimed = true;
    return {
      image: draft.prepared,
      finish: consumed => {
        draft.claimed = false;
        if (consumed) this.cancel(sessionId, id);
      },
    };
  }

  cancel(sessionId: string, id: string): void {
    const draft = this.draft;
    if (!draft || draft.sessionId !== sessionId || draft.id !== id) return;
    clearTimeout(draft.timeout);
    this.draft = undefined;
  }

  dispose(): void {
    if (this.draft) this.cancel(this.draft.sessionId, this.draft.id);
  }
}

export function storeAppshot(directory: string, prepared: PreparedAppshot) {
  const home = resolve(sunHome());
  const parts = relative(home, resolve(directory)).split(sep);
  if (!(parts.length === 2 && parts[0] === 'attachments' || parts.length === 3 && parts[0] === 'sessions' && parts[2] === 'attachments')
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(parts[1])) throw new Error('APPSHOT_STORAGE_INVALID');
  let parent = home;
  for (const part of parts) {
    parent = join(parent, part);
    try { mkdirSync(parent, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    if (!lstatSync(parent).isDirectory()) throw new Error('APPSHOT_STORAGE_INVALID');
  }
  const path = join(parent, `appshot-${randomUUID()}.${prepared.mime === 'image/png' ? 'png' : 'jpg'}`);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    writeFileSync(fd, Buffer.from(prepared.data, 'base64'));
    fsyncSync(fd);
  } catch (error) {
    unlinkSync(path);
    throw error;
  } finally { closeSync(fd); }
  try {
    const dir = openSync(parent, 'r');
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } catch {
    // Directory synchronization is not supported on every filesystem.
  }
  return { path, mime: prepared.mime, appshot: prepared.metadata };
}

export function matchesAppshot(bytes: Buffer, mime: string, metadata: AppshotMetadata): boolean {
  return isAppshotMetadata(metadata) && (mime === 'image/png' || mime === 'image/jpeg')
    && bytes.length === metadata.bytes && imageSignature(bytes, mime)
    && createHash('sha256').update(bytes).digest('hex') === metadata.sha256;
}

export function readAppshot(path: string, mime: string, metadata: AppshotMetadata): Buffer | undefined {
  try {
    if (!isAppshotMetadata(metadata) || (mime !== 'image/png' && mime !== 'image/jpeg') || !ownedAttachment(path)) return;
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== metadata.bytes) return;
      const bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const size = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!size) return;
        offset += size;
      }
      if (fstatSync(fd).size === bytes.length && matchesAppshot(bytes, mime, metadata)) return bytes;
    } finally { closeSync(fd); }
  } catch {
    // Report missing or changed bytes as an unavailable attachment during replay.
  }
}
