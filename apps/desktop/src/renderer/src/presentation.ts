import type { UiPreferences } from '@sun/core';
import { shortcutSignature } from '@sun/core/settings-preferences';

export function watchAppearance(preferences: Pick<UiPreferences, 'theme' | 'textScale' | 'reducedMotion'>): () => void {
  const color = matchMedia('(prefers-color-scheme: light)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const apply = () => {
    const root = document.documentElement;
    root.dataset.theme = preferences.theme === 'system' ? color.matches ? 'light' : 'dark' : preferences.theme;
    root.dataset.motion = preferences.reducedMotion === 'system' ? motion.matches ? 'reduce' : 'full' : preferences.reducedMotion;
    root.style.fontSize = `${16 * preferences.textScale}px`;
  };
  apply();
  color.addEventListener('change', apply);
  motion.addEventListener('change', apply);
  return () => {
    color.removeEventListener('change', apply);
    motion.removeEventListener('change', apply);
  };
}

export function matchesShortcut(event: KeyboardEvent, binding: string, platform: 'mac' | 'other'): boolean {
  if (!binding || event.repeat || event.isComposing) return false;
  const key = event.code.match(/^(?:Key|Digit)([A-Z0-9])$/)?.[1] ?? event.key.toUpperCase();
  const modifiers = [event.altKey && 'Alt', event.ctrlKey && 'Ctrl', event.metaKey && 'Meta', event.shiftKey && 'Shift'].filter(Boolean);
  return [...modifiers, key].join('+') === shortcutSignature(binding, platform);
}
