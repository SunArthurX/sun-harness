import { localDate } from './util/date.js';
import { appendFileSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withStorageLock } from './settings/storage-lock.js';
import { ensureDir, homePath } from './paths.js';
import type { RunStatus, SessionEvent, SessionEventBody, SessionSummary } from './types.js';
import type { WorktreeInfo } from './worktree.js';

/**
 * Append-only JSONL session log. One file per session; the file is the source of truth.
 * Everything the model saw can be re-derived from it.
 */
export class SessionLog {
  readonly id: string;
  readonly file: string;
  private events: SessionEvent[] = [];
  private bytes = 0;

  private constructor(id: string, file: string) {
    this.id = id;
    this.file = file;
    if (existsSync(file)) this.reload();
  }

  private reload(): void {
    const raw = readFileSync(this.file);
    this.bytes = raw.length;
    this.events = [];
    const text = raw.toString('utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        this.events.push(JSON.parse(line));
      } catch {
        // A torn final line (crash mid-write) is ignored; earlier lines stay valid.
      }
    }
  }

  static dir(): string {
    return ensureDir(homePath('sessions'));
  }

  private static path(id: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) throw new Error('Invalid session ID.');
    const dir = SessionLog.dir();
    const installed = join(dir, id);
    return lstatSync(installed, { throwIfNoEntry: false })?.isDirectory()
      ? join(installed, 'session.jsonl')
      : join(dir, `${id}.jsonl`);
  }

  static open(id: string): SessionLog {
    return new SessionLog(id, SessionLog.path(id));
  }

  static publishImport(id: string, staging: string): void {
    withStorageLock(() => {
      const target = join(SessionLog.dir(), id);
      if (SessionLog.exists(id) || lstatSync(target, { throwIfNoEntry: false })) throw new Error('Session ID already exists.');
      renameSync(staging, target);
      if (process.platform === 'win32') return;
      try {
        const fd = openSync(SessionLog.dir(), 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      } catch {
        // Publication already committed. Some filesystems do not support directory synchronization.
      }
    });
  }

  attachmentDir(): string {
    return this.file === join(SessionLog.dir(), this.id, 'session.jsonl')
      ? join(SessionLog.dir(), this.id, 'attachments')
      : homePath('attachments', this.id);
  }

  static create(meta: { title?: string; mode: string; cwd: string; model: string; parent?: string; worktree?: WorktreeInfo; approval?: 'suggest' | 'auto-edit' | 'full-auto'; sandbox?: 'off' | 'auto' | 'seatbelt' | 'bwrap' | 'docker'; forkOf?: { session: string; seq: number }; importedThrough?: number }): SessionLog {
    const id = `${localDate().replace(/-/g, '')}-${randomUUID().slice(0, 8)}`;
    const log = SessionLog.open(id);
    log.append({
      type: 'session/meta',
      id,
      title: meta.title || 'New session',
      mode: meta.mode,
      cwd: meta.cwd,
      model: meta.model,
      createdAt: new Date().toISOString(),
      ...(meta.parent ? { parent: meta.parent } : {}),
      ...(meta.worktree ? { worktree: meta.worktree } : {}),
      ...(meta.approval ? { approval: meta.approval } : {}),
      ...(meta.sandbox ? { sandbox: meta.sandbox } : {}),
      ...(meta.forkOf ? { forkOf: meta.forkOf } : {}),
      ...(meta.importedThrough === undefined ? {} : { importedThrough: meta.importedThrough }),
    });
    return log;
  }

  static exists(id: string): boolean {
    return existsSync(SessionLog.path(id));
  }

  static delete(id: string): void {
    withStorageLock(() => rmSync(SessionLog.path(id), { force: true }));
  }

  static list(): SessionSummary[] {
    const dir = SessionLog.dir();
    const out: SessionSummary[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const id = entry.isDirectory() ? entry.name : entry.isFile() && entry.name.endsWith('.jsonl') ? entry.name.slice(0, -6) : '';
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) continue;
      if (entry.isDirectory() && !lstatSync(join(dir, id, 'session.jsonl'), { throwIfNoEntry: false })?.isFile()) continue;
      const log = SessionLog.open(id);
      const s = log.summary();
      if (s) {
        s.updatedAt = statSync(log.file).mtime.toISOString();
        out.push(s);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  append(body: SessionEventBody, flush = false): SessionEvent {
    return withStorageLock(() => {
      const current = statSync(this.file, { throwIfNoEntry: false });
      if (body.type !== 'session/meta' && !current) throw new Error('Session is no longer available.');
      if (current && current.size !== this.bytes) this.reload();
      const event = { seq: this.events.length, ts: new Date().toISOString(), ...body } as SessionEvent;
      const line = JSON.stringify(event) + '\n';
      appendFileSync(this.file, line, { flush });
      this.bytes += Buffer.byteLength(line);
      this.events.push(event);
      return event;
    });
  }

  all(): readonly SessionEvent[] {
    return this.events;
  }

  last<T extends SessionEvent['type']>(type: T): Extract<SessionEvent, { type: T }> | undefined {
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i].type === type) return this.events[i] as Extract<SessionEvent, { type: T }>;
    }
    return undefined;
  }

  meta(): Extract<SessionEvent, { type: 'session/meta' }> | undefined {
    return this.events.find((e) => e.type === 'session/meta') as Extract<SessionEvent, { type: 'session/meta' }> | undefined;
  }

  currentModel(): string {
    return this.last('model/switch')?.to ?? this.meta()?.model ?? '';
  }

  currentMode(): string {
    return this.last('mode/switch')?.to ?? this.meta()?.mode ?? 'coding';
  }

  status(): { status: RunStatus; reason?: string; detail?: string } {
    const s = this.last('run/status');
    return s ? { status: s.status, reason: s.reason, detail: s.detail } : { status: 'idle' };
  }

  summary(): SessionSummary | undefined {
    const meta = this.meta();
    if (!meta) return undefined;
    const st = this.status();
    return {
      id: meta.id,
      title: this.last('session/title')?.title ?? meta.title,
      mode: this.currentMode(),
      cwd: meta.cwd,
      model: this.currentModel(),
      createdAt: meta.createdAt,
      updatedAt: this.events.at(-1)?.ts ?? meta.createdAt,
      status: st.status,
      statusReason: st.reason,
      statusDetail: st.detail,
      parent: meta.parent,
      worktree: meta.worktree ? { repo: meta.worktree.repo, branch: meta.worktree.branch, closed: this.last('worktree/closed')?.action } : undefined,
      ...(() => {
        const f = this.last('session/flags');
        return f ? { ...(f.pinned ? { pinned: true } : {}), ...(f.archived ? { archived: true } : {}) } : {};
      })(),
      ...(() => {
        const u = this.last('assistant/message')?.usage;
        return u ? { contextTokens: u.inputTokens + u.outputTokens } : {};
      })(),
    };
  }
}
