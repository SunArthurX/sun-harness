export function parseCSV(text) {
  return text.split('\n').map((l) => l.split(','));
}
