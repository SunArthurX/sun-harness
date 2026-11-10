export function edit(host, key, raw) {
  if (key === 'verbose' && (raw === 'true' || raw === 'false')) {
    return host.update(host.get().revision, { [key]: raw === 'true' });
  }
  return { ok: false, code: 'INVALID', key };
}
