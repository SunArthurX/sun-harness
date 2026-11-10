import { zhCN } from './locale-zh-CN';

export type Lang = 'en' | 'zh-CN';
export type LangSetting = Lang | 'system';

let current: Lang = 'en';
const listeners = new Set<(l: Lang) => void>();

/** Re-render on language changes; returns the unsubscribe function. */
export function onLangChange(fn: (l: Lang) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** System → the browser/OS language (Chinese variants → zh-CN, everything else → en). */
export function resolveLang(setting: LangSetting | undefined): Lang {
  if (setting === 'en' || setting === 'zh-CN') return setting;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return /^zh/i.test(nav) ? 'zh-CN' : 'en';
}

export function setLang(l: Lang): void {
  const changed = current !== l;
  current = l;
  if (typeof document !== 'undefined') document.documentElement.lang = l;
  if (changed) for (const fn of listeners) fn(l);
}

export function getLang(): Lang {
  return current;
}

/**
 * Translate an English source string. Keys are the English text (gettext-style), so a missing translation falls
 * back to English. `{name}` placeholders are filled from vars in both languages.
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const s = current === 'zh-CN' ? (zhCN[key] ?? key) : key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Locale for dates and numbers. */
export function locale(): string {
  return current === 'zh-CN' ? 'zh-CN' : 'en-US';
}

export const fmtDate = (d: string | number | Date) => new Date(d).toLocaleString(locale());

const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** A cron expression in words, in the current language (mirrors core describeCron). */
export function describeSchedule(a: { cron?: string; at?: string; description?: string }): string {
  if (a.at && !a.cron) return t('once at {time}', { time: fmtDate(a.at) });
  if (!a.cron) return a.description ?? '';
  const [mi, h, dom, mon, dow] = a.cron.split(/\s+/);
  const pad = (n: string) => n.padStart(2, '0');
  const time = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${pad(h)}:${pad(mi)}` : undefined;
  const zh = current === 'zh-CN';
  if (mi.startsWith('*/') && h === '*') return t('every {n} minutes', { n: mi.slice(2) });
  if (mi === '0' && h.startsWith('*/')) return t('every {n} hours', { n: h.slice(2) });
  if (mi === '0' && h === '*') return t('every hour');
  if (time && dom === '*' && mon === '*' && dow === '*') return t('every day at {time}', { time });
  if (time && dom === '*' && mon === '*' && dow === '1-5') return t('every weekday at {time}', { time });
  if (time && dom === '*' && mon === '*' && /^[\d,]+$/.test(dow)) {
    const days = dow.split(',').map((d) => (zh ? DAY_ZH : DAY_EN)[Number(d) % 7]);
    return t('every {days} at {time}', { days: days.join(zh ? '、' : ', '), time });
  }
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return t('monthly on day {day} at {time}', { day: dom, time });
  return a.description ?? `cron ${a.cron}`;
}

/** Marks a module-level English string for translation; render it later with t(value). */
export const tk = (key: string): string => key;

/** Runtime enum values the UI passes to t() (status, risk, file change, …). Keep in sync with core types. */
void [
  tk('idle'),
  tk('running'),
  tk('awaiting_approval'),
  tk('paused'),
  tk('error'),
  tk('aborted'),
  tk('quota'),
  tk('auth'),
  tk('rate_limit'),
  tk('network'),
  tk('max_steps'),
  tk('interrupted'),
  tk('read'),
  tk('write'),
  tk('exec'),
  tk('added'),
  tk('modified'),
  tk('deleted'),
  tk('done'),
  tk('failed'),
  tk('killed'),
  tk('lost'),
  tk('merged'),
  tk('discarded'),
  tk('fact'),
  tk('preference'),
  tk('person'),
  tk('project'),
  tk('lesson'),
  tk('episode'),
  tk('core'),
  tk('connecting'),
  tk('ready'),
  tk('disabled'),
  tk('loaded'),
  tk('pending'),
  tk('accepted'),
  tk('rejected'),
  tk('memory'),
  tk('skill'),
  tk('rule'),
  tk('feature'),
  tk('user'),
  tk('compat'),
  tk('plugin'),
  tk('in_progress'),
  tk('cancelled'),
];
