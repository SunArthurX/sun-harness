import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homePath } from './paths.js';
import { findProjectRoot } from './rules.js';
import { record } from './settings/schema.js';
import { transactSettingsFile } from './settings/store.js';

export const HOOK_EVENTS = ['sessionStart', 'preToolUse', 'postToolUse', 'stop'] as const;
export type HookEvent = typeof HOOK_EVENTS[number];
export type HookScope = 'user' | 'project';

export interface HookEntry {
  id?: string;
  enabled?: boolean;
  matcher?: string;
  command: string;
  timeoutMs?: number;
  onFailure?: 'ignore' | 'block';
  worktreeSetup?: boolean;
}

export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

export interface HookDefinition {
  id: string;
  explicitId?: string;
  digest: string;
  source: string;
  scope: HookScope;
  event: HookEvent;
  position: number;
  status: 'trusted' | 'untrusted' | 'disabled';
  command: string;
  matcher?: string;
  timeoutMs: number;
  onFailure: 'ignore' | 'block';
  worktreeSetup?: true;
}

type DiagnosticCode = 'INVALID_SOURCE' | 'INVALID_SECTION' | 'UNKNOWN_EVENT' | 'INVALID_ENTRY' | 'INVALID_MATCHER' | 'DUPLICATE_ID' | 'TRUST_STORE_INVALID';

export interface HookDiagnostic {
  source: string;
  scope: HookScope;
  code: DiagnosticCode;
  policy: boolean;
  event?: HookEvent;
  position?: number;
  matcher?: string;
}

export interface HookInspection {
  hooks: HookDefinition[];
  diagnostics: HookDiagnostic[];
}

export interface HookTrustChange {
  id: string;
  digest: string;
  trust: boolean;
}

const MAX_SOURCE = 256 * 1024;
const MAX_TRUST = 512 * 1024;
const MAX_ENTRIES = 128;
const MAX_GRANTS = 3000;
const MAX_COMMAND = 16_384;
const DEFAULT_TIMEOUT = 30_000;
const MAX_TIMEOUT = 120_000;
export const HOOK_TOOL_NAME_LIMIT = 256;
const explicitId = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const hex = /^[a-f0-9]{64}$/;
const entryFields = new Set(['id', 'enabled', 'matcher', 'command', 'timeoutMs', 'onFailure', 'worktreeSetup']);

function sha(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.some(event => event === value);
}

/** A single non-repeated group, at most one quantifier, and no backreferences or assertions besides anchors. */
function validMatcher(value: unknown): value is string {
  if (typeof value !== 'string' || !value.length || value.length > HOOK_TOOL_NAME_LIMIT || /[\r\n\0]/.test(value)) return false;
  let inClass = false;
  let inGroup = false;
  let groups = 0;
  let quantifiers = 0;
  let alternatives = 0;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === '\\') {
      const escaped = value[++i];
      if (!escaped || /[0-9k]/.test(escaped)) return false;
      continue;
    }
    if (inClass) {
      if (char === ']') inClass = false;
      continue;
    }
    if (char === '[') { inClass = true; continue; }
    if (char === '(') {
      if (++groups > 1) return false;
      inGroup = true;
      if (value[i + 1] === '?') {
        if (value[i + 2] !== ':') return false;
        i += 2;
      }
    } else if (char === ')') {
      if (!inGroup) return false;
      inGroup = false;
    } else if ('?*+'.includes(char)) {
      if (++quantifiers > 1 || value[i - 1] === ')') return false;
    } else if (char === '|') {
      if (++alternatives > 15) return false;
    } else if (char === '{' || char === '}') return false;
  }
  if (inClass || inGroup) return false;
  try { new RegExp(value); return true; } catch { return false; }
}

function readBounded(file: string, size: number, privateFile = false): Buffer | undefined {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > size
      || (privateFile && process.platform !== 'win32' && ((info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()))) {
      throw new Error('Invalid hook file.');
    }
    const raw = Buffer.alloc(info.size + 1);
    let offset = 0;
    while (offset < raw.length) {
      const read = readSync(fd, raw, offset, raw.length - offset, offset);
      if (!read) break;
      offset += read;
    }
    if (offset !== info.size) throw new Error('Hook file changed while reading.');
    return raw.subarray(0, offset);
  } finally { closeSync(fd); }
}

function trustFile(): string {
  const file = homePath('settings', 'hook-trust.json');
  const directory = lstatSync(dirname(file), { throwIfNoEntry: false });
  if (directory && !directory.isDirectory()) throw new Error('Invalid hook trust directory.');
  return file;
}

function grantsOf(document: Record<string, unknown>): Record<string, string> {
  if (!Object.keys(document).length) return {};
  if (document.version !== 1 || !record(document.grants)) throw new Error('Invalid hook trust document.');
  const grants = Object.entries(document.grants);
  if (grants.length > MAX_GRANTS || grants.some(([id, digest]) => !hex.test(id) || typeof digest !== 'string' || !hex.test(digest))) {
    throw new Error('Invalid hook trust grants.');
  }
  return Object.fromEntries(grants) as Record<string, string>;
}

function readGrants(): Record<string, string> {
  const raw = readBounded(trustFile(), MAX_TRUST, true);
  if (!raw) return {};
  const data: unknown = JSON.parse(raw.toString('utf8'));
  if (!record(data)) throw new Error('Invalid hook trust document.');
  return grantsOf(data);
}

function entryValid(entry: Record<string, unknown>, event: HookEvent): boolean {
  return Object.keys(entry).every(key => entryFields.has(key))
    && (entry.id === undefined || (typeof entry.id === 'string' && explicitId.test(entry.id)))
    && (entry.enabled === undefined || typeof entry.enabled === 'boolean')
    && (entry.worktreeSetup === undefined || (event === 'sessionStart' && typeof entry.worktreeSetup === 'boolean'))
    && typeof entry.command === 'string' && !!entry.command.trim() && entry.command.length <= MAX_COMMAND && !entry.command.includes('\0')
    && (entry.timeoutMs === undefined || (typeof entry.timeoutMs === 'number' && Number.isSafeInteger(entry.timeoutMs)
      && entry.timeoutMs >= 1 && entry.timeoutMs <= MAX_TIMEOUT))
    && (entry.onFailure === undefined || (event === 'preToolUse' && (entry.onFailure === 'ignore' || entry.onFailure === 'block')));
}

export function inspectHooks(cwd: string): HookInspection {
  const hooks: HookDefinition[] = [];
  const diagnostics: HookDiagnostic[] = [];
  let grants: Record<string, string> = {};
  try { grants = readGrants(); }
  catch { diagnostics.push({ source: homePath('settings', 'hook-trust.json'), scope: 'user', code: 'TRUST_STORE_INVALID', policy: false }); }

  const files: [HookScope, string][] = [
    ['user', resolve(homePath('hooks.json'))],
    ['project', join(findProjectRoot(cwd), '.sun', 'hooks.json')],
  ];
  const sources = new Set<string>();
  for (const [scope, path] of files) {
    let data: unknown;
    let source = path;
    let revision: string;
    try {
      const directory = lstatSync(dirname(path), { throwIfNoEntry: false });
      if (scope === 'project' && directory && !directory.isDirectory()) throw new Error('Invalid project hook directory.');
      const raw = readBounded(path, MAX_SOURCE);
      if (!raw) continue;
      source = realpathSync(path);
      if (sources.has(source)) continue;
      sources.add(source);
      revision = sha(raw);
      data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      if (!record(data)) throw new Error('Invalid hook file.');
    } catch {
      diagnostics.push({ source, scope, code: 'INVALID_SOURCE', policy: true });
      continue;
    }
    for (const [event, entries] of Object.entries(data)) {
      if (!hookEvent(event)) {
        diagnostics.push({ source, scope, code: 'UNKNOWN_EVENT', policy: false });
        continue;
      }
      if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
        diagnostics.push({ source, scope, event, code: 'INVALID_SECTION', policy: event === 'preToolUse' });
        continue;
      }
      const counts = new Map<string, number>();
      for (const entry of entries) {
        if (record(entry) && typeof entry.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
      }
      for (const [position, value] of entries.entries()) {
        const entry = record(value) ? value : {};
        const policy = event === 'preToolUse' && entry.enabled !== false && entry.onFailure === 'block';
        const matcher = validMatcher(entry.matcher) ? entry.matcher : undefined;
        const issue = (code: DiagnosticCode) => diagnostics.push({ source, scope, event, position, code, policy, matcher });
        if (!entryValid(entry, event)) { issue('INVALID_ENTRY'); continue; }
        if (entry.matcher !== undefined && (!matcher || (event !== 'preToolUse' && event !== 'postToolUse'))) {
          issue('INVALID_MATCHER');
          continue;
        }
        const named = typeof entry.id === 'string' ? entry.id : undefined;
        if (named && (counts.get(named) ?? 0) > 1) { issue('DUPLICATE_ID'); continue; }
        const id = sha(JSON.stringify([source, event, named ? ['id', named] : ['position', position]]));
        const command = entry.command as string;
        const timeoutMs = (entry.timeoutMs as number | undefined) ?? DEFAULT_TIMEOUT;
        const onFailure = entry.onFailure === 'block' ? 'block' : 'ignore';
        const enabled = entry.enabled !== false;
        const digest = sha(JSON.stringify([id, revision, scope, event, command, matcher, timeoutMs, onFailure, enabled]));
        hooks.push({
          id, explicitId: named, digest, source, scope, event, position, command, matcher, timeoutMs, onFailure,
          ...(entry.worktreeSetup === true && { worktreeSetup: true as const }),
          status: !enabled ? 'disabled' : grants[id] === digest ? 'trusted' : 'untrusted',
        });
      }
    }
  }
  return { hooks, diagnostics };
}

export function reviewHookTrust(cwd: string, changes: HookTrustChange[]): HookInspection {
  if (!Array.isArray(changes) || !changes.length || changes.length > 2 * HOOK_EVENTS.length * MAX_ENTRIES
    || changes.some(change => !change || typeof change.id !== 'string' || !hex.test(change.id)
      || typeof change.digest !== 'string' || !hex.test(change.digest) || typeof change.trust !== 'boolean')
    || new Set(changes.map(change => change.id)).size !== changes.length) throw new Error('HOOK_REVIEW_INVALID: Invalid hook review.');
  const file = trustFile();
  readBounded(file, MAX_TRUST, true);
  const result = transactSettingsFile(file, undefined, ({ document }) => {
    let grants: Record<string, string>;
    try { grants = grantsOf(document); } catch { return { fields: { hooks: 'INVALID_STORE' } }; }
    const current = new Map(inspectHooks(cwd).hooks.map(hook => [hook.id, hook]));
    for (const change of changes) {
      const hook = current.get(change.id);
      if (!hook || hook.digest !== change.digest || (change.trust && hook.status === 'disabled')) return { fields: { hooks: 'STALE' } };
      if (change.trust) grants[change.id] = change.digest;
      else delete grants[change.id];
    }
    if (Object.keys(grants).length > MAX_GRANTS) return { fields: { hooks: 'LIMIT' } };
    return { document: { version: 1, grants } };
  });
  if (!result.ok) {
    const reason = result.fields?.hooks ?? result.code;
    throw new Error(`HOOK_REVIEW_${reason}: Hook review could not be saved.`);
  }
  return inspectHooks(cwd);
}

export function hookMatches(matcher: string | undefined, tool: string): boolean {
  return !matcher || (tool.length <= HOOK_TOOL_NAME_LIMIT && new RegExp(matcher).test(tool));
}
