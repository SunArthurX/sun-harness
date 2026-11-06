import { localDate } from './util/date.js';
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureDir, homePath } from './paths.js';
import type { RunStatus, SessionEvent, SessionEventBody, SessionSummary } from './types.js';

/**
 * Append-only JSONL session log. One file per session; the file is the source of truth.
 * Everything the model saw can be re-derived from it.
 */
export class SessionLog {
  readonly id: string;
  readonly file: string;
  private events: SessionEvent[] = [];

  private constructor(id: string, file: string) {
    this.id = id;
    this.file = file;
    if (existsSync(file)) {
      const text = readFileSync(file, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // A torn final line (crash mid-write) is ignored; earlier lines stay valid.
        }
      }
    }
  }

  static dir(): string {
    return ensureDir(homePath('sessions'));
  }

  static open(id: string): SessionLog {
    return new SessionLog(id, join(SessionLog.dir(), `${id}.jsonl`));
  }

  static create(meta: { title?: string; mode: string; cwd: string; model: string; parent?: string }): SessionLog {
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
    });
    return log;
  }

  static exists(id: string): boolean {
    return existsSync(join(SessionLog.dir(), `${id}.jsonl`));
  }

  static delete(id: string): void {
    rmSync(join(SessionLog.dir(), `${id}.jsonl`), { force: true });
  }

  static list(): SessionSummary[] {
    const dir = SessionLog.dir();
    const out: SessionSummary[] = [];
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const log = SessionLog.open(f.slice(0, -6));
      const s = log.summary();
      if (s) {
        s.updatedAt = statSync(log.file).mtime.toISOString();
        out.push(s);
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  append(body: SessionEventBody): SessionEvent {
    const event = { seq: this.events.length, ts: new Date().toISOString(), ...body } as SessionEvent;
    appendFileSync(this.file, JSON.stringify(event) + '\n');
    this.events.push(event);
    return event;
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
    };
  }
}
