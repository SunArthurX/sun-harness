import { constants, closeSync, fsyncSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ownedAttachment } from '../attachments.js';
import { SessionLog } from '../log.js';
import { pendingToolCalls } from '../messages.js';
import { isReviewOutcome } from '../review.js';
import type { SessionEvent, SessionEventBody, SessionSummary } from '../types.js';
import { imageMime } from '../ux/mentions.js';
import { BUNDLE_MAX_ATTACHMENT_BYTES, BUNDLE_MAX_BYTES, BUNDLE_MAX_ENTRIES, imageSignature, packBundle, unpackBundle } from './bundle.js';
import { isAppshotMetadata, matchesAppshot } from './capture.js';
import { record } from './schema.js';

export interface SessionImportOptions {
  cwd?: string;
}

type Meta = Extract<SessionEvent, { type: 'session/meta' }>;
type Image = NonNullable<Extract<SessionEvent, { type: 'user/message' }>['images']>[number];
const operational = new Set([
  'approval/request', 'approval/decision', 'hook/run', 'run/status', 'worktree/closed', 'worktree/merge', 'worktree/setup', 'checkpoint',
  'checkpoint/undo', 'browser/takeover', 'automation/proposal', 'automation/resolved', 'file/revert',
  'session/flags', 'memory/extract', 'job/started', 'job/finished',
]);
const MAX_TRANSCRIPT_EVENTS = 200_000;
const sources = new Set(['user', 'hook', 'schedule', 'system', 'job', 'verify', 'memory', 'trigger']);
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const string = (value: unknown): value is string => typeof value === 'string';
const optionalString = (value: unknown) => value === undefined || string(value);
const bool = (value: unknown) => typeof value === 'boolean';
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(string);
const date = (value: unknown): value is string => string(value) && Number.isFinite(Date.parse(value));

function usableEvent(event: Record<string, unknown>): event is Record<string, unknown> & SessionEvent {
  switch (event.type) {
    case 'session/title':
      return string(event.title) && (event.source === undefined || (string(event.source) && ['first-message', 'model', 'user'].includes(event.source)));
    case 'session/import-note':
      return string(event.originalType);
    case 'user/message':
      return string(event.text) && (event.source === undefined || (string(event.source) && sources.has(event.source)))
        && (event.command === undefined || (record(event.command) && string(event.command.name) && string(event.command.input)))
        && (event.images === undefined || (Array.isArray(event.images)
          && event.images.every(image => record(image) && string(image.path) && string(image.mime)
            && (image.appshot === undefined || isAppshotMetadata(image.appshot)))));
    case 'assistant/message':
      return string(event.text) && string(event.model) && optionalString(event.reasoning)
        && Array.isArray(event.toolCalls) && event.toolCalls.every(call =>
          record(call) && string(call.id) && !!call.id && string(call.name) && string(call.arguments))
        && new Set(event.toolCalls.map(call => call.id)).size === event.toolCalls.length
        && (event.usage === undefined || (record(event.usage) && count(event.usage.inputTokens) && count(event.usage.outputTokens)
          && (event.usage.cachedTokens === undefined || (count(event.usage.cachedTokens) && event.usage.cachedTokens <= event.usage.inputTokens))));
    case 'tool/result':
      return string(event.callId) && string(event.name) && string(event.output) && bool(event.isError)
        && optionalString(event.diff) && (event.durationMs === undefined || (typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)));
    case 'request/header':
      return string(event.model) && string(event.systemPrompt) && strings(event.tools);
    case 'model/switch':
      return string(event.from) && string(event.to) && string(event.reason);
    case 'mode/switch':
      return string(event.from) && string(event.to);
    case 'context/compaction':
      return string(event.summary) && count(event.upToSeq) && optionalString(event.model);
    case 'review/report':
      return string(event.text) && (event.review === undefined || isReviewOutcome(event.review));
    case 'review/request':
      return string(event.digest) && /^[a-f0-9]{64}$/.test(event.digest) && string(event.modelRef)
        && Array.isArray(event.omissions) && event.omissions.every(item => record(item) && string(item.path) && string(item.reason))
        && (event.request === undefined || (record(event.request) && string(event.request.model)
          && string(event.request.system) && Array.isArray(event.request.tools) && event.request.tools.length === 0
          && Array.isArray(event.request.messages) && event.request.messages.length === 1
          && record(event.request.messages[0]) && event.request.messages[0].role === 'user' && string(event.request.messages[0].content)));
    case 'context/taint':
      return string(event.tool) && strings(event.findings);
    case 'verify/result':
      return bool(event.passed) && Array.isArray(event.results) && event.results.every(result =>
        record(result) && string(result.command) && string(result.output)
        && (result.code === null || (typeof result.code === 'number' && Number.isSafeInteger(result.code))));
    case 'todo/update':
      return Array.isArray(event.items) && event.items.every(item => record(item) && string(item.id) && string(item.content)
        && string(item.status) && ['pending', 'in_progress', 'done', 'cancelled'].includes(item.status));
    default:
      return false;
  }
}

function parseTranscript(jsonl: string): { meta: Meta; events: SessionEvent[] } {
  if (typeof jsonl !== 'string' || Buffer.byteLength(jsonl) > BUNDLE_MAX_BYTES) throw new Error('Session transcript exceeds the import size limit.');
  const events: SessionEvent[] = [];
  for (let offset = 0; offset < jsonl.length;) {
    const newline = jsonl.indexOf('\n', offset);
    const end = newline < 0 ? jsonl.length : newline;
    const line = jsonl.slice(offset, end);
    offset = end + 1;
    if (!line.trim()) continue;
    if (events.length >= MAX_TRANSCRIPT_EVENTS) throw new Error('Session transcript exceeds the event count limit.');
    let event: unknown;
    try { event = JSON.parse(line); }
    catch { throw new Error('Invalid session transcript JSON.'); }
    const seq = events.length;
    if (!record(event) || event.seq !== seq || !date(event.ts) || !string(event.type)) {
      throw new Error(`Invalid session record at sequence ${seq}.`);
    }
    if (!seq) {
      if (event.type !== 'session/meta' || !string(event.id) || !string(event.title) || !string(event.mode)
        || !string(event.model) || !string(event.cwd) || !date(event.createdAt)) throw new Error('Invalid session metadata.');
      events.push({
        seq, ts: event.ts, type: 'session/meta', id: event.id, title: event.title, mode: event.mode,
        model: event.model, cwd: event.cwd, createdAt: event.createdAt,
      });
    } else if (operational.has(event.type)) {
      events.push({ seq, ts: event.ts, type: 'session/import-note', originalType: event.type });
    } else if (usableEvent(event)) {
      if (event.type === 'context/compaction') event.upToSeq = Math.min(event.upToSeq, seq - 1);
      events.push(event);
    } else {
      throw new Error(`Unsupported or invalid session record at sequence ${seq}.`);
    }
  }
  const meta = events[0] as Meta | undefined;
  if (!meta) throw new Error('Missing session metadata.');
  return { meta, events };
}

function workspace(original: string, selected?: string): string {
  const path = selected ?? original;
  if (!string(path) || !isAbsolute(path) || path.includes('\0') || !statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('IMPORT_WORKSPACE_REQUIRED: Choose an existing absolute workspace on the execution host.');
  }
  return realpathSync(path);
}

/** Validate the owned file before reading and use the same descriptor for the bounded copy. */
function readImage(path: string, mime: string, limit: number): Buffer {
  const owned = ownedAttachment(path);
  if (!owned || imageMime(owned) !== mime) throw new Error('Invalid or unavailable local attachment. Import a portable session bundle instead.');
  const fd = openSync(owned, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > Math.min(limit, BUNDLE_MAX_ATTACHMENT_BYTES)) throw new Error('Session attachment exceeds the import size limit.');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const size = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!size) throw new Error('Session attachment changed while reading.');
      offset += size;
    }
    if (!imageSignature(bytes, mime)) throw new Error('Invalid session attachment image data.');
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function rewriteImages(events: SessionEvent[], rewrite: (image: Image) => Image): void {
  for (const event of events) {
    if (event.type === 'user/message' && event.images) event.images = event.images.map(image => ({ ...image, ...rewrite(image) }));
  }
}

function publish(staging: string, id: string, meta: Meta, events: SessionEvent[]): SessionSummary {
  meta.id = id;
  for (const call of pendingToolCalls(events)) {
    if (events.length >= MAX_TRANSCRIPT_EVENTS) throw new Error('Session transcript exceeds the event count limit.');
    const body: SessionEventBody = {
      type: 'tool/result', callId: call.id, name: call.name, output: '[No result: the imported call was interrupted.]', isError: true,
    };
    events.push({ seq: events.length, ts: events.at(-1)!.ts, ...body });
  }
  meta.importedThrough = events.length - 1;
  writeFileSync(join(staging, 'session.jsonl'), serializeTranscript(events), { mode: 0o600, flush: true });
  if (process.platform !== 'win32') {
    for (const directory of [join(staging, 'attachments'), staging]) {
      if (!lstatSync(directory, { throwIfNoEntry: false })) continue;
      const fd = openSync(directory, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }
  SessionLog.publishImport(id, staging);
  return SessionLog.open(id).summary()!;
}

function serializeTranscript(events: readonly SessionEvent[]): string {
  let size = 0;
  return events.map(event => {
    const line = JSON.stringify(event) + '\n';
    size += Buffer.byteLength(line);
    if (size > BUNDLE_MAX_BYTES) throw new Error('Session transcript exceeds the size limit.');
    return line;
  }).join('');
}

function newStaging(): { id: string; staging: string } {
  return { id: randomUUID(), staging: mkdtempSync(join(SessionLog.dir(), '.import-')) };
}

export function importTranscript(jsonl: string, options: SessionImportOptions = {}): SessionSummary {
  const { meta, events } = parseTranscript(jsonl);
  meta.cwd = workspace(meta.cwd, options?.cwd);
  const { id, staging } = newStaging();
  const copied = new Map<string, Image>();
  let remaining = BUNDLE_MAX_BYTES - Buffer.byteLength(jsonl);
  try {
    rewriteImages(events, image => {
      const previous = copied.get(image.path);
      if (previous) {
        if (previous.mime !== image.mime) throw new Error('Conflicting local attachment types.');
        return previous;
      }
      if (copied.size + 1 >= BUNDLE_MAX_ENTRIES) throw new Error('Too many session attachments.');
      const bytes = readImage(image.path, image.mime, remaining);
      if (image.appshot && !matchesAppshot(bytes, image.mime, image.appshot)) throw new Error('Appshot attachment digest mismatch.');
      remaining -= bytes.length;
      const name = `${copied.size + 1}${extname(image.path).toLowerCase()}`;
      mkdirSync(join(staging, 'attachments'), { recursive: true, mode: 0o700 });
      writeFileSync(join(staging, 'attachments', name), bytes, { flag: 'wx', mode: 0o600, flush: true });
      const installed = { path: resolve(SessionLog.dir(), id, 'attachments', name), mime: image.mime };
      copied.set(image.path, installed);
      return installed;
    });
    return publish(staging, id, meta, events);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function importBundle(input: AsyncIterable<Uint8Array>, options: SessionImportOptions = {}, beforePublish?: () => void): Promise<SessionSummary> {
  const { id, staging } = newStaging();
  try {
    const attachments = await unpackBundle(input, staging);
    const bytes = readFileSync(join(staging, 'session.jsonl'));
    let jsonl: string;
    try { jsonl = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Invalid session bundle transcript encoding.'); }
    const { meta, events } = parseTranscript(jsonl);
    meta.cwd = workspace(meta.cwd, options?.cwd);
    const referenced = new Set<string>();
    rewriteImages(events, image => {
      if (attachments.get(image.path) !== image.mime) throw new Error('Invalid session bundle attachment reference.');
      if (image.appshot && !matchesAppshot(readFileSync(join(staging, image.path)), image.mime, image.appshot)) {
        throw new Error('Appshot attachment digest mismatch.');
      }
      referenced.add(image.path);
      return { path: resolve(SessionLog.dir(), id, image.path), mime: image.mime };
    });
    if (referenced.size !== attachments.size) throw new Error('Unreferenced session bundle attachment.');
    beforePublish?.();
    return publish(staging, id, meta, events);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function exportBundle(events: SessionEvent[]) {
  const payloads = new Map<string, Buffer>([['session.jsonl', Buffer.alloc(0)]]);
  const mapped = new Map<string, Image>();
  let remaining = BUNDLE_MAX_BYTES;
  rewriteImages(events, image => {
    const previous = mapped.get(image.path);
    if (previous) {
      if (previous.mime !== image.mime) throw new Error('Conflicting local attachment types.');
      return previous;
    }
    if (payloads.size >= BUNDLE_MAX_ENTRIES) throw new Error('Too many session attachments.');
    const bytes = readImage(image.path, image.mime, remaining);
    if (image.appshot && !matchesAppshot(bytes, image.mime, image.appshot)) throw new Error('Appshot attachment digest mismatch.');
    remaining -= bytes.length;
    const path = `attachments/${payloads.size}${extname(image.path).toLowerCase()}`;
    const relative = { path, mime: image.mime };
    payloads.set(path, bytes);
    mapped.set(image.path, relative);
    return relative;
  });
  payloads.set('session.jsonl', Buffer.from(serializeTranscript(events)));
  return packBundle(payloads);
}
