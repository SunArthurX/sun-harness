import { labels } from './locale.mjs';

export function render(status, locale) {
  if (status === 'denied') return { state: status, label: labels[locale].denied, actionEnabled: false };
  if (status === 'unavailable') return { state: status, label: labels[locale].unavailable, actionEnabled: false };
  return { state: 'available', label: labels[locale].available, actionEnabled: true };
}

export async function capture(adapter, locale) {
  const state = render(adapter.status(), locale);
  if (!state.actionEnabled) return state;
  try { await adapter.capture(); } catch (error) {
    if (error.code === 'PERMISSION_DENIED') return render('denied', locale);
    throw error;
  }
  return state;
}
