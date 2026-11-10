import { existsSync, readFileSync } from 'node:fs';
import { intelReportFile } from '../intel.js';
import { homePath } from '../paths.js';
import { requireCalendarDate } from '../util/date.js';

export interface BriefingConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  /** Bot chats that receive the briefing, as "platform:chatId" (e.g. "telegram:12345"). */
  chats: string[];
  /** Extra instructions appended to the briefing prompt (e.g. "include the weather in Shanghai"). */
  extra?: string;
}

export const DEFAULT_BRIEFING: BriefingConfig = { enabled: false, hour: 8, minute: 30, chats: [] };

export function briefingFile(date: string): string {
  return homePath('briefings', `${requireCalendarDate(date)}.md`);
}

/** The prompt for one day's briefing; sections are skipped when their source is missing. */
export function briefingPrompt(date: string, o: { dingtalk: boolean; intelDate?: string; extra?: string }): string {
  const intel = o.intelDate ? intelReportFile(o.intelDate) : undefined;
  const parts = [
    `Prepare my daily briefing for ${date}. Be brief and concrete; lead with what needs my attention today.`,
    '',
    'Sections (skip any with nothing to report):',
    o.dingtalk
      ? '1. Today: my calendar and meetings (dingtalk_read: calendar), open and overdue todos (todo), pending approvals (oa), and unread messages that need a reply (chat).'
      : '1. Today: reminders and scheduled tasks you know about (my memory and schedules).',
    '2. Follow-ups: open items from my memory (projects, promises, people waiting on me).',
    intel && existsSync(intel) ? `3. Industry: the three most important points from ${intel} (read it with read_file).` : '',
    '4. Suggested focus: at most three priorities for today, each with the first concrete step.',
    o.extra ? `\nAlso: ${o.extra}` : '',
    '',
    'Answer in Markdown with short bullet points. Do not take actions or send messages; this is read-only.',
  ];
  return parts.filter((x) => x !== '').join('\n');
}

export function readBriefing(date: string): string | undefined {
  const f = briefingFile(date);
  return existsSync(f) ? readFileSync(f, 'utf8') : undefined;
}
