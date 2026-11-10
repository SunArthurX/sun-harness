import type { NotificationKind, NotificationPreferences, RunStatus, SessionSummary } from '@sun/core';
import { isQuietAt } from '@sun/core/settings-preferences';

const eventKind = (status: RunStatus, prior?: RunStatus): NotificationKind | undefined => {
  if (status === 'awaiting_approval') return 'approval';
  if (status === 'paused') return 'pause';
  if (status === 'error') return 'failure';
  if (status === 'idle' && (prior === 'running' || prior === 'awaiting_approval')) return 'completion';
  return undefined;
};

export class NotificationTracker {
  private readonly seen = new Map<string, { seq: number; status: RunStatus }>();
  private sessions = new Map<string, SessionSummary>();

  /** Snapshots only provide session metadata and the starting status. */
  seed(sessions: SessionSummary[]): void {
    this.sessions = new Map(sessions.map(session => [session.id, session]));
  }

  accept(id: string, seq: number, status: RunStatus, preferences: NotificationPreferences, now: Date): NotificationKind | undefined {
    const prior = this.seen.get(id);
    if (prior && seq <= prior.seq) return;
    const session = this.sessions.get(id);
    this.seen.delete(id);
    this.seen.set(id, { seq, status });
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value!);
    if (session?.parent || prior?.status === status) return;
    const kind = eventKind(status, prior?.status ?? session?.status);
    if (kind && preferences[kind] && !isQuietAt(now, preferences.quietHours)) return kind;
  }

  session(id: string): SessionSummary | undefined {
    return this.sessions.get(id);
  }
}
