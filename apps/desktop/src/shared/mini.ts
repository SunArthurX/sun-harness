import type { SessionSummary, UiPreferences } from '@sun/core';

export type MiniSession = Pick<SessionSummary, 'id' | 'title' | 'status'>;
export type MiniAppearance = Pick<UiPreferences, 'language' | 'theme' | 'textScale' | 'reducedMotion'>;
export interface MiniSnapshot {
  session?: MiniSession;
  appearance: MiniAppearance;
}

export function activeMiniSession(sessions: SessionSummary[]): MiniSession | undefined {
  let active: SessionSummary | undefined;
  for (const session of sessions) {
    if (session.parent || session.archived || (session.status !== 'running' && session.status !== 'awaiting_approval')) continue;
    if (!active || session.updatedAt > active.updatedAt || (session.updatedAt === active.updatedAt && session.id < active.id)) active = session;
  }
  return active && { id: active.id, title: active.title, status: active.status };
}
