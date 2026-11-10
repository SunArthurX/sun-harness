import { randomUUID } from 'node:crypto';
import { homePath } from '../paths.js';
import { appendSettingsAudit } from '../settings/service.js';
import { readSettingsFile, transactSettingsFile } from '../settings/store.js';

export type BrowserAction = 'browse' | 'upload' | 'download';
export type BrowserDecision = 'allow' | 'deny' | 'ask';
export type BrowserRule = { origin: string; action: BrowserAction; decision: Exclude<BrowserDecision, 'ask'> };
export type BrowserPermissionRequest = { origin: string; action: BrowserAction; sessionId: string };
export interface BrowserPermissionsSnapshot {
  revision: string;
  rules: BrowserRule[];
  requests: BrowserPermissionRequest[];
}
export interface BrowserPermissionPatch {
  expectedRevision: string;
  origin: string;
  action: BrowserAction;
  decision: BrowserDecision;
}
export type BrowserPermissionResult =
  | { ok: true; snapshot: BrowserPermissionsSnapshot; audit: 'recorded' | 'incomplete' }
  | { ok: false; code: 'CONFLICT' | 'INVALID' | 'BUSY' | 'IO_ERROR' };

const actions = new Set(['browse', 'upload', 'download']);
const decisions = new Set(['allow', 'deny', 'ask']);
const maxRules = 512;

export function browserOrigin(value: string): string {
  if (typeof value !== 'string' || value.length > 8192) throw new Error('BROWSER_INVALID_ORIGIN');
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error('BROWSER_INVALID_ORIGIN'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password) {
    throw new Error('BROWSER_INVALID_ORIGIN: Use an HTTP or HTTPS origin without credentials.');
  }
  return url.origin;
}

function rulesOf(document: Record<string, unknown>): BrowserRule[] {
  if (!Object.keys(document).length) return [];
  if (document.version !== 1 || !Array.isArray(document.rules) || document.rules.length > maxRules) {
    throw new Error('BROWSER_PERMISSIONS_INVALID');
  }
  const rules = document.rules as BrowserRule[];
  const seen = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object' || !actions.has(rule.action) || (rule.decision !== 'allow' && rule.decision !== 'deny')
      || browserOrigin(rule.origin) !== rule.origin) throw new Error('BROWSER_PERMISSIONS_INVALID');
    const key = `${rule.origin}/${rule.action}`;
    if (seen.has(key)) throw new Error('BROWSER_PERMISSIONS_INVALID');
    seen.add(key);
  }
  return rules;
}

export class BrowserPermissions {
  private readonly pending = new Map<string, BrowserPermissionRequest>();
  constructor(private readonly changed: () => void = () => undefined) {}

  private file(): string {
    return homePath('settings', 'browser-permissions.json');
  }

  snapshot(): BrowserPermissionsSnapshot {
    const { revision, document } = readSettingsFile(this.file());
    const rules = rulesOf(document);
    const decided = new Set(rules.map(rule => `${rule.origin}/${rule.action}`));
    for (const [key, request] of this.pending) {
      if (decided.has(`${request.origin}/${request.action}`)) this.pending.delete(key);
    }
    return { revision, rules, requests: [...this.pending.values()] };
  }

  decision(url: string, action: BrowserAction): BrowserDecision {
    const origin = browserOrigin(url);
    const { document } = readSettingsFile(this.file());
    return rulesOf(document).find(rule => rule.origin === origin && rule.action === action)?.decision ?? 'ask';
  }

  require(sessionId: string, url: string, action: BrowserAction): void {
    const origin = browserOrigin(url);
    const decision = this.decision(origin, action);
    if (decision === 'allow') return;
    if (decision === 'deny') throw new Error(`BROWSER_PERMISSION_DENIED: ${action} ${origin}`);
    const key = JSON.stringify([sessionId, origin, action]);
    if (!this.pending.has(key)) {
      if (this.pending.size >= 128) this.pending.delete(this.pending.keys().next().value!);
      this.pending.set(key, { origin, action, sessionId });
      this.changed();
    }
    throw new Error(`BROWSER_PERMISSION_REQUIRED: ${action} ${origin}. Review the origin in Browser settings and retry.`);
  }

  update(input: BrowserPermissionPatch): BrowserPermissionResult {
    if (!input || typeof input.expectedRevision !== 'string' || !/^(missing|[a-f0-9]{64})$/.test(input.expectedRevision)
      || !actions.has(input.action) || !decisions.has(input.decision)) return { ok: false, code: 'INVALID' };
    let origin: string;
    try { origin = browserOrigin(input.origin); }
    catch { return { ok: false, code: 'INVALID' }; }
    const { action, decision } = input;
    const result = transactSettingsFile(this.file(), input.expectedRevision, ({ document }) => {
      const rules = rulesOf(document).filter(rule => rule.origin !== origin || rule.action !== action);
      if (decision !== 'ask') rules.push({ origin, action, decision });
      if (rules.length > maxRules) return { fields: { rules: 'LIMIT' } };
      return { document: { version: 1, generation: randomUUID(), rules } };
    });
    if (!result.ok) return { ok: false, code: result.code };
    for (const [key, item] of this.pending) if (item.origin === origin && item.action === action) this.pending.delete(key);
    let audit: 'recorded' | 'incomplete' = 'recorded';
    try { appendSettingsAudit({ kind: 'browser/permission', origin, action, decision, revision: result.file.revision }); }
    catch { audit = 'incomplete'; }
    this.changed();
    return { ok: true, snapshot: this.snapshot(), audit };
  }
}
