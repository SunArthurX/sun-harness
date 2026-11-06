/** Extract the first JSON value from model output (fenced ```json block preferred). */
export function extractJson<T = unknown>(text: string): T | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  const candidates: string[] = [];
  while ((m = fenced.exec(text))) candidates.push(m[1]);
  for (const open of ['[', '{']) {
    const i = text.indexOf(open);
    const j = text.lastIndexOf(open === '[' ? ']' : '}');
    if (i >= 0 && j > i) candidates.push(text.slice(i, j + 1));
  }
  for (const c of candidates) {
    try {
      return JSON.parse(c.trim()) as T;
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
