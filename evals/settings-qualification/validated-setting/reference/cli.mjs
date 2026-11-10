export function edit(host, key, raw) {
  if (key === 'pageSize' && /^[0-9]+$/.test(raw)) return host.update(host.get().revision, { pageSize: Number(raw) });
  if (key === 'verbose' && (raw === 'true' || raw === 'false')) {
    return host.update(host.get().revision, { [key]: raw === 'true' });
  }
  return { ok: false, code: 'INVALID', key };
}
