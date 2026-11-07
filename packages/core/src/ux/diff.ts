/** Unified diff of two texts (line LCS; context 3), for showing edits to humans. */
export function unifiedDiff(before: string, after: string, path: string, context = 3): string {
  // A final newline ends the last line; it is not an extra empty line.
  const lines = (s: string) => (s === '' ? [] : (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n'));
  const a = lines(before);
  const b = lines(after);
  // Trim the common prefix/suffix first: edits are usually small, LCS stays cheap.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length && !midB.length) return '';
  const ops: { t: ' ' | '-' | '+'; s: string }[] = [];
  if (midA.length * midB.length > 4_000_000) {
    for (const s of midA) ops.push({ t: '-', s });
    for (const s of midB) ops.push({ t: '+', s });
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ t: ' ', s: midA[i++] });
        j++;
      } else if (j < m && (i >= n || dp[i][j + 1] > dp[i + 1][j])) ops.push({ t: '+', s: midB[j++] });
      else ops.push({ t: '-', s: midA[i++] });
    }
  }
  const all = [...a.slice(Math.max(0, start - context), start).map((s) => ({ t: ' ' as const, s })), ...ops, ...a.slice(endA, endA + context).map((s) => ({ t: ' ' as const, s }))];
  const firstA = Math.max(0, start - context) + 1;
  const firstB = Math.max(0, start - context) + 1;
  const lenA = all.filter((o) => o.t !== '+').length;
  const lenB = all.filter((o) => o.t !== '-').length;
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${firstA},${lenA} +${firstB},${lenB} @@`, ...all.map((o) => o.t + o.s)].join('\n');
}

export function diffStats(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return { added, removed };
}
