import { labels } from './locale.mjs';

export function render(status, locale) {
  if (status === 'unavailable') return { state: status, label: labels[locale].unavailable, actionEnabled: false };
  return { state: 'available', label: labels[locale].available, actionEnabled: true };
}

export async function capture(adapter, locale) {
  const state = render(adapter.status(), locale);
  if (!state.actionEnabled) return state;
  await adapter.capture();
  return state;
}
