import { SETTINGS_PROTOCOL_MISMATCH } from '@sun/core/settings-protocol';
import type { SettingsWriteResult } from '@sun/core';
import { t } from './i18n';

export function settingsFeedback(result: SettingsWriteResult): string {
  if (result.ok) {
    if (result.audit === 'incomplete') return t('Settings were saved, but the audit record could not be completed.');
    if (result.durability === 'uncertain') return t('Settings were saved, but disk synchronization could not be confirmed.');
    if (result.apply === 'restart') return t('Settings saved. Reinstall the managed schedule to apply the new time.');
    return t('Saved');
  }
  switch (result.code) {
    case 'CONFLICT': return t('Settings changed elsewhere. Reload the latest values before applying your edit.');
    case 'BUSY': return t('The settings host is busy. Wait for active work to finish and try again.');
    case 'IO_ERROR': return t('Settings could not be written. Check the configuration directory and try again.');
    case 'INVALID':
      if (Object.values(result.fields ?? {}).includes('SHORTCUT_UNAVAILABLE')) return t('The operating system rejected the shortcut. The previous binding is still active.');
      if (Object.values(result.fields ?? {}).includes('SHORTCUT_RESERVED')) return t('This shortcut is reserved by the app or operating system.');
      if (Object.values(result.fields ?? {}).includes('SHORTCUT_CONFLICT')) return t('Two actions use the same shortcut. Assign different shortcuts.');
      if (Object.values(result.fields ?? {}).includes('MODEL_IN_USE')) return t('A removed model is still selected as a default or fallback.');
      return t('This setting has an invalid value.');
  }
}

export function settingsLoadError(error?: unknown): string {
  if (error instanceof Error && (error.message.includes(SETTINGS_PROTOCOL_MISMATCH) || /Unknown method getSettings/.test(error.message))) {
    return t('The app and settings host use different protocol versions. Update both and reconnect.');
  }
  return t('Settings could not be loaded. Check the configuration file and the gateway version.');
}
