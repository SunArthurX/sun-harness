export interface StoragePreferences {
  trashDays: number;
  autoCleanupDays: number;
}
export const DEFAULT_STORAGE: StoragePreferences = { trashDays: 7, autoCleanupDays: 0 };

export const USER_PROFILE_MAX = 1375;

export const DEFAULT_MODE_IDS = ['coding', 'plan', 'agent', 'assistant'] as const;
export type DefaultMode = typeof DEFAULT_MODE_IDS[number];

export const NOTIFICATION_KINDS = ['completion', 'pause', 'failure', 'approval'] as const;
export type NotificationKind = typeof NOTIFICATION_KINDS[number];

export interface QuietHours {
  enabled: boolean;
  timeZone: string;
  start: string;
  end: string;
}

export type NotificationPreferences = Record<NotificationKind, boolean> & { quietHours: QuietHours };

export const SHORTCUT_IDS = ['palette', 'newChat', 'mini', 'appshot'] as const;
export type ShortcutId = typeof SHORTCUT_IDS[number];
export type ShortcutBindings = Record<ShortcutId, string>;
export const DEFAULT_SHORTCUTS: ShortcutBindings = { palette: 'Primary+K', newChat: 'Primary+N', mini: '', appshot: '' };

export interface UiPreferences {
  language: 'system' | 'en' | 'zh-CN';
  theme: 'system' | 'light' | 'dark';
  textScale: number;
  reducedMotion: 'system' | 'reduce' | 'full';
  startPage: 'chat' | 'settings';
  readAloud: boolean;
  mini: boolean;
  appshots: boolean;
  notifications: NotificationPreferences;
  shortcuts: ShortcutBindings;
}

export function defaultUiPreferences(): UiPreferences {
  return {
    language: 'system', theme: 'system', textScale: 1, reducedMotion: 'system',
    startPage: 'chat', readAloud: false, mini: false, appshots: false,
    notifications: {
      completion: true, pause: true, failure: true, approval: true,
      quietHours: { enabled: false, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', start: '22:00', end: '07:00' },
    },
    shortcuts: { ...DEFAULT_SHORTCUTS },
  };
}

export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 100 || /^[+-]/.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const isClockTime = (value: unknown): value is string => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

export function isQuietAt(now: Date, interval: QuietHours): boolean {
  if (!interval.enabled || interval.start === interval.end) return false;
  const local = new Intl.DateTimeFormat('en-GB', {
    timeZone: interval.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(now);
  return interval.start < interval.end
    ? local >= interval.start && local < interval.end
    : local >= interval.start || local < interval.end;
}

export function isShortcut(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > 40) return false;
  const parts = value.split('+');
  const key = parts.pop()!;
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2]))$/.test(key)) return false;
  const mods = new Set(parts);
  return parts.length > 0 && parts.length === mods.size && parts.every(mod => ['Primary', 'Ctrl', 'Alt', 'Shift', 'Meta'].includes(mod))
    && !(mods.has('Primary') && (mods.has('Ctrl') || mods.has('Meta')));
}

export function shortcutSignature(binding: string, platform: 'mac' | 'other'): string {
  const parts = binding.split('+');
  const key = parts.pop()!;
  const modifiers = parts.map(part => part === 'Primary' ? platform === 'mac' ? 'Meta' : 'Ctrl' : part);
  return [...modifiers.sort(), key].join('+');
}

const reserved = new Set(['Meta+Q', 'Meta+W', 'Meta+H', 'Meta+M', 'Ctrl+Q', 'Ctrl+W', 'Alt+F4']);

export function shortcutIssues(bindings: ShortcutBindings): Record<string, string> {
  const issues: Record<string, string> = {};
  for (const platform of ['mac', 'other'] as const) {
    const seen = new Map<string, ShortcutId>();
    for (const id of SHORTCUT_IDS) {
      const value = bindings[id];
      if (!value) continue;
      const signature = shortcutSignature(value, platform);
      if (reserved.has(signature)) issues[`ui.shortcuts.${id}`] = 'SHORTCUT_RESERVED';
      const prior = seen.get(signature);
      if (prior) {
        issues[`ui.shortcuts.${prior}`] ??= 'SHORTCUT_CONFLICT';
        issues[`ui.shortcuts.${id}`] ??= 'SHORTCUT_CONFLICT';
      } else seen.set(signature, id);
    }
  }
  return issues;
}
