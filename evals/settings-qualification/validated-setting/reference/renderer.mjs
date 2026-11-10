export const labels = {
  pageSize: { en: 'Page size', zh: '每页数量' },
  verbose: { en: 'Verbose logging', zh: '详细日志' },
};

export function form(snapshot, locale) {
  return Object.entries(labels).map(([key, translations]) => ({
    key, label: translations[locale], value: snapshot.values[key],
  }));
}
