import { parseCron } from '../schedule.js';

export interface ParsedSchedule {
  cron?: string;
  /** One-shot time, ISO. */
  at?: string;
  /** Human description, e.g. "every weekday at 09:00". */
  description: string;
  /** The prompt with the schedule phrase removed. */
  prompt: string;
  /** The matched phrase. */
  phrase: string;
}

const EN_DAYS: Record<string, number> = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const ZH_DAYS: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const ZH_NUM: Record<string, number> = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/** "9", "十", "十二", "二十三" → number. */
function zhNumber(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === '十') return 10;
  if (s.startsWith('十')) return 10 + (ZH_NUM[s[1]] ?? 0);
  if (s.includes('十')) return (ZH_NUM[s[0]] ?? 0) * 10 + (ZH_NUM[s[2]] ?? 0);
  return ZH_NUM[s] ?? NaN;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** English time of day: "9", "9am", "9:30 pm", "21:00", "noon", "midnight". */
function enTime(s: string | undefined, fallback: [number, number]): [number, number] | undefined {
  if (!s) return fallback;
  const t = s.trim().toLowerCase();
  if (t === 'noon') return [12, 0];
  if (t === 'midnight') return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  const ap = m[3]?.[0];
  if (ap === 'p' && h < 12) h += 12;
  if (ap === 'a' && h === 12) h = 0;
  return h < 24 && mi < 60 ? [h, mi] : undefined;
}

/** Chinese time of day: "早上9点", "下午3点半", "晚上8点15分", "9:30", "十点". */
function zhTime(part: string | undefined, hourS: string | undefined, minS: string | undefined, half: boolean): [number, number] | undefined {
  if (!hourS) {
    if (!part) return undefined;
    return /早|上午/.test(part) ? [9, 0] : /中午/.test(part) ? [12, 0] : /下午/.test(part) ? [15, 0] : /晚/.test(part) ? [20, 0] : undefined;
  }
  let h = zhNumber(hourS);
  const mi = half ? 30 : minS ? zhNumber(minS) : 0;
  if (part && /下午|晚|傍晚/.test(part) && h < 12) h += 12;
  if (part && /中午/.test(part) && h < 11) h += 12;
  return Number.isFinite(h) && h < 24 && mi < 60 ? [h, mi] : undefined;
}

const ZH_TIME = '(早上|上午|中午|下午|傍晚|晚上|今晚)?\\s*(?:(\\d{1,2}|[一二两三四五六七八九十]{1,3})(?:[:：](\\d{2})|点|时)(半|(\\d{1,2}|[一二三四五六七八九十]{1,3})分?)?)?';
const EN_TIME = '(?:\\s+at\\s+(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)?|noon|midnight))?';

/** Bare "daily", "hourly", "monthly" count only at the start or end of the message ("check the logs hourly"). */
function atEdge(t: string, m: RegExpExecArray): boolean {
  return m.index === 0 || /^[\s.!?。！？]*$/.test(t.slice(m.index + m[0].length));
}

function hm(t: [number, number]): string {
  return `${pad(t[0])}:${pad(t[1])}`;
}

function isoAt(d: Date): string {
  return d.toISOString();
}

function clean(text: string, phrase: string): string {
  return text
    .replace(phrase, ' ')
    .replace(/^\s*[,，、:：]?\s*(please\s+|请)?/i, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[,，、\s]+|[,，、\s]+$/g, '')
    .trim();
}

/** Words that turn a one-shot time ("tomorrow at 3") into a scheduling request rather than plain conversation. */
const ONE_SHOT_INTENT = /remind|reminder|schedule|set (?:an? )?(?:alarm|timer)|run|check|send|post|notify|ping me|提醒|定时|安排|执行|运行|检查|发送|通知|叫我|告诉我/i;

/**
 * Extract a schedule from natural language (English and Chinese). Recurring phrases need an explicit recurrence;
 * one-shot phrases also need a scheduling verb, so "the build takes 2 hours" is not an automation.
 */
export function parseSchedule(text: string, now = new Date(), opts: { explicit?: boolean } = {}): ParsedSchedule | undefined {
  const t = text.trim();
  let m: RegExpExecArray | null;

  // ---- English recurring ----
  if ((m = new RegExp(`\\bevery\\s+(\\d+)\\s*(minutes?|mins?|hours?|hrs?)\\b`, 'i').exec(t))) {
    const n = Number(m[1]);
    const unit = /^h/i.test(m[2]) ? 'hour' : 'minute';
    if (n < 1 || (unit === 'minute' && n > 59) || (unit === 'hour' && n > 23)) return undefined;
    const cron = unit === 'minute' ? `*/${n} * * * *` : `0 */${n} * * *`;
    return { cron, description: `every ${n} ${unit}${n > 1 ? 's' : ''}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = /\bevery\s+(hour|minute)\b|\bhourly\b/i.exec(t)) && (/every/i.test(m[0]) || atEdge(t, m))) {
    const minute = /minute/i.test(m[0]);
    return { cron: minute ? '* * * * *' : '0 * * * *', description: minute ? 'every minute' : 'every hour', prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = new RegExp(`\\b(?:every\\s+(weekday|working day|business day|day|morning|evening|night)s?|(daily|weekdays))${EN_TIME}`, 'i').exec(t))) {
    const kind = (m[1] ?? m[2]).toLowerCase();
    // A bare "daily" inside a sentence ("fix the daily report") is an adjective, not a schedule.
    if (m[2] && !m[3] && !atEdge(t, m)) return undefined;
    const def: [number, number] = /evening|night/.test(kind) ? [18, 0] : [9, 0];
    const time = enTime(m[3], def);
    if (!time) return undefined;
    const weekdays = /weekday|working|business/.test(kind);
    return { cron: `${time[1]} ${time[0]} * * ${weekdays ? '1-5' : '*'}`, description: `every ${weekdays ? 'weekday' : 'day'} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = new RegExp(`\\b(?:every month|monthly)(?:\\s+on\\s+the\\s+(\\d{1,2})(?:st|nd|rd|th)?)?${EN_TIME}`, 'i').exec(t))) {
    if (/^monthly/i.test(m[0]) && !m[1] && !m[2] && !atEdge(t, m)) return undefined;
    const day = Number(m[1] ?? 1);
    const time = enTime(m[2], [9, 0]);
    if (!time || day < 1 || day > 31) return undefined;
    return { cron: `${time[1]} ${time[0]} ${day} * *`, description: `monthly on day ${day} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }

  if ((m = new RegExp(`\\b(?:every|each)\\s+((?:(?:mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?s?\\b(?:\\s*(?:,|and|&)\\s*)?)+)${EN_TIME}`, 'i').exec(t))) {
    const days = [...m[1].toLowerCase().matchAll(/(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?/g)].map((x) => EN_DAYS[x[1]] ?? EN_DAYS[x[1].slice(0, 3)]);
    const time = enTime(m[2], [9, 0]);
    if (days.length && time) {
      const uniq = [...new Set(days)].sort();
      return { cron: `${time[1]} ${time[0]} * * ${uniq.join(',')}`, description: `every ${uniq.map((d) => DAY_NAMES[d]).join(', ')} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
    }
  }
  // ---- Chinese recurring ----
  if ((m = /每(?:隔)?\s*(\d+|[一二两三四五六七八九十]{1,3})\s*(分钟|个?小时)/.exec(t))) {
    const n = zhNumber(m[1]);
    const hour = /时/.test(m[2]);
    if (!(n >= 1) || (!hour && n > 59) || (hour && n > 23)) return undefined;
    return { cron: hour ? `0 */${n} * * *` : `*/${n} * * * *`, description: `every ${n} ${hour ? 'hour' : 'minute'}${n > 1 ? 's' : ''}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = /每(?:个)?小时/.exec(t))) return { cron: '0 * * * *', description: 'every hour', prompt: clean(t, m[0]), phrase: m[0] };
  if ((m = new RegExp(`每(?:个)?(天|日|工作日)${ZH_TIME}`).exec(t))) {
    const time = zhTime(m[2], m[3], m[5] ?? m[6], m[5] === '半') ?? (m[2] || m[3] ? undefined : [9, 0]);
    if (!time) return undefined;
    const weekdays = m[1] === '工作日';
    return { cron: `${time[1]} ${time[0]} * * ${weekdays ? '1-5' : '*'}`, description: `every ${weekdays ? 'weekday' : 'day'} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = new RegExp(`每(?:个)?(?:周|星期|礼拜)([一二三四五六日天](?:[、,，和及]?[一二三四五六日天])*)${ZH_TIME}`).exec(t))) {
    const days = [...new Set([...m[1]].filter((c) => c in ZH_DAYS).map((c) => ZH_DAYS[c]))].sort();
    const time = zhTime(m[2], m[3], m[5] ?? m[6], m[5] === '半') ?? (m[2] || m[3] ? undefined : [9, 0]);
    if (!days.length || !time) return undefined;
    return { cron: `${time[1]} ${time[0]} * * ${days.join(',')}`, description: `every ${days.map((d) => DAY_NAMES[d]).join(', ')} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  if ((m = new RegExp(`每(?:个)?月\\s*(\\d{1,2}|[一二三四五六七八九十]{1,3})\\s*[号日]${ZH_TIME}`).exec(t))) {
    const day = zhNumber(m[1]);
    const time = zhTime(m[2], m[3], m[5] ?? m[6], m[5] === '半') ?? (m[2] || m[3] ? undefined : [9, 0]);
    if (!time || !(day >= 1 && day <= 31)) return undefined;
    return { cron: `${time[1]} ${time[0]} ${day} * *`, description: `monthly on day ${day} at ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }

  // ---- One-shot (needs a scheduling verb) ----
  if (!opts.explicit && !ONE_SHOT_INTENT.test(t)) return undefined;
  if ((m = /\bin\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\b/i.exec(t)) || (m = /(\d+|[一二两三四五六七八九十]{1,3})\s*(分钟|个?小时|天)(?:之|以)?后/.exec(t))) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : zhNumber(m[1]);
    const unit = /^h|时/i.test(m[2]) ? 3600_000 : /^d|天/i.test(m[2]) ? 86_400_000 : 60_000;
    if (!(n >= 1)) return undefined;
    const at = new Date(now.getTime() + n * unit);
    at.setSeconds(0, 0);
    return { at: isoAt(at), description: `once in ${n} ${unit === 60_000 ? 'minute' : unit === 3600_000 ? 'hour' : 'day'}${n > 1 ? 's' : ''} (${at.toLocaleString('en-GB')})`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  const oneShotDay = (offset: number, time: [number, number], phrase: string): ParsedSchedule => {
    const at = new Date(now);
    at.setDate(at.getDate() + offset);
    at.setHours(time[0], time[1], 0, 0);
    if (offset === 0 && at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return { at: isoAt(at), description: `once at ${at.toLocaleDateString('en-GB')} ${hm(time)}`, prompt: clean(t, phrase), phrase };
  };
  if ((m = new RegExp(`\\b(tomorrow|today|tonight)${EN_TIME}`, 'i').exec(t))) {
    const word = m[1].toLowerCase();
    const time = enTime(m[2], word === 'tonight' ? [20, 0] : [9, 0]);
    if (time) return oneShotDay(word === 'tomorrow' ? 1 : 0, time, m[0]);
  }
  if ((m = new RegExp(`(明天|后天|今天|今晚)${ZH_TIME}`).exec(t))) {
    const time = zhTime(m[1] === '今晚' ? '晚上' : m[2], m[3], m[5] ?? m[6], m[5] === '半') ?? [9, 0];
    return oneShotDay(m[1] === '明天' ? 1 : m[1] === '后天' ? 2 : 0, time, m[0]);
  }
  if ((m = /\bon\s+(\d{4}-\d{2}-\d{2})(?:\s+at\s+(\d{1,2}(?::\d{2})?\s*(?:am|pm)?))?/i.exec(t)) || (m = /(\d{4}-\d{2}-\d{2})\s*(\d{1,2}:\d{2})?/.exec(t))) {
    const time = enTime(m[2], [9, 0]);
    if (!time) return undefined;
    const at = new Date(`${m[1]}T${hm(time)}:00`);
    if (Number.isNaN(at.getTime())) return undefined;
    return { at: isoAt(at), description: `once at ${m[1]} ${hm(time)}`, prompt: clean(t, m[0]), phrase: m[0] };
  }
  return undefined;
}

/** Next occurrences of a cron expression after `from` (minute steps, bounded to one year). */
export function nextRuns(cron: string, from = new Date(), count = 3): Date[] {
  const match = parseCron(cron);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const out: Date[] = [];
  for (let i = 0; i < 366 * 24 * 60 && out.length < count; i++) {
    if (match(d)) out.push(new Date(d));
    d.setMinutes(d.getMinutes() + 1);
  }
  return out;
}

/** The latest scheduled minute in (after, before]; used to catch up runs missed while the machine slept. */
export function missedRun(cron: string, after: Date, before: Date, windowMs = 24 * 3600_000): Date | undefined {
  const match = parseCron(cron);
  const start = Math.max(after.getTime(), before.getTime() - windowMs);
  const d = new Date(before);
  d.setSeconds(0, 0);
  while (d.getTime() > start) {
    if (match(d)) return new Date(d);
    d.setMinutes(d.getMinutes() - 1);
  }
  return undefined;
}

export function describeCron(cron: string): string {
  const [mi, h, dom, mon, dow] = cron.split(/\s+/);
  const time = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${pad(Number(h))}:${pad(Number(mi))}` : undefined;
  if (mi.startsWith('*/') && h === '*') return `every ${mi.slice(2)} minutes`;
  if (mi === '0' && h.startsWith('*/')) return `every ${h.slice(2)} hours`;
  if (mi === '0' && h === '*') return 'every hour';
  if (time && dom === '*' && mon === '*' && dow === '*') return `every day at ${time}`;
  if (time && dom === '*' && mon === '*' && dow === '1-5') return `every weekday at ${time}`;
  if (time && dom === '*' && mon === '*' && /^[\d,]+$/.test(dow)) return `every ${dow.split(',').map((d) => DAY_NAMES[Number(d) % 7]).join(', ')} at ${time}`;
  if (time && /^\d+$/.test(dom) && mon === '*' && dow === '*') return `monthly on day ${dom} at ${time}`;
  return `cron ${cron}`;
}
