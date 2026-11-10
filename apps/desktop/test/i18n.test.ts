import { describe, expect, it } from 'vitest';
import { scan, sourceFiles } from '../scripts/i18n.mjs';
import { describeSchedule, resolveLang, setLang, t } from '../src/renderer/src/i18n';
import { zhCN } from '../src/renderer/src/locale-zh-CN';

/** Identifiers, product names, and examples that stay the same in both languages. */
const KEEP_ENGLISH = new Set([
  'HTML',
  'Markdown',
  'Markdown…',
  'Harness',
  'sun-harness',
  'https://kb.company.internal/api',
  'qwen/text-embedding-v4',
  'telegram:12345, dingtalk:cid…',
]);

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('desktop UI i18n (specs/028)', () => {
  const files = sourceFiles().map((f) => scan(f));
  const keys = [...new Set(files.flatMap((r) => r.keys.map((k) => k.key)))].sort();

  it('wraps every user-visible renderer string in t() / tk()', () => {
    const violations = files.flatMap((r) => r.violations.map((v) => `${r.file.split('/').pop()}:${v.line} ${v.kind} ${JSON.stringify(v.text).slice(0, 80)}`));
    expect(violations).toEqual([]);
  });

  it('has a Simplified Chinese string for every English key, with the same placeholders', () => {
    const missing = keys.filter((k) => !zhCN[k]);
    const extra = Object.keys(zhCN).filter((k) => !keys.includes(k));
    const ph = keys.filter((k) => zhCN[k] && placeholders(k).join() !== placeholders(zhCN[k]).join());
    expect({ missing, extra, ph }).toEqual({ missing: [], extra: [], ph: [] });
  });

  it('translates real UI copy into Chinese (not a copy of the English)', () => {
    const copied = keys.filter((k) => !KEEP_ENGLISH.has(k) && zhCN[k] === k);
    const noHan = keys.filter((k) => !KEEP_ENGLISH.has(k) && zhCN[k] !== k && !/[\u4e00-\u9fff]/.test(zhCN[k]));
    expect({ copied, noHan }).toEqual({ copied: [], noHan: [] });
  });

  it('resolves system / en / zh-CN and interpolates placeholders', () => {
    expect(resolveLang('en')).toBe('en');
    expect(resolveLang('zh-CN')).toBe('zh-CN');
    expect(resolveLang('system')).toBe('en');
    setLang('en');
    expect(t('Always allow {tool}', { tool: 'bash' })).toBe('Always allow bash');
    setLang('zh-CN');
    expect(t('Always allow {tool}', { tool: 'bash' })).toBe('始终允许 bash');
    expect(t('no such key')).toBe('no such key');
    setLang('en');
  });

  it('describes schedules in the current language', () => {
    setLang('en');
    expect(describeSchedule({ cron: '0 9 * * *' })).toBe('every day at 09:00');
    expect(describeSchedule({ cron: '0 9 * * 1-5' })).toBe('every weekday at 09:00');
    setLang('zh-CN');
    expect(describeSchedule({ cron: '0 9 * * *' })).toBe('每天 09:00');
    expect(describeSchedule({ cron: '0 9 * * 1-5' })).toBe('每个工作日 09:00');
    expect(describeSchedule({ cron: '0 * * * *' })).toBe('每小时');
    setLang('en');
  });
});
