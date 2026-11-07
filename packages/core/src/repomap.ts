import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', 'coverage', '.next', 'target', '.venv', 'venv', '__pycache__', 'vendor', '.sun', '.eval-hidden']);
const LANG: Record<string, 'js' | 'py' | 'go' | 'rs' | 'java'> = {
  '.js': 'js', '.mjs': 'js', '.cjs': 'js', '.jsx': 'js', '.ts': 'js', '.tsx': 'js', '.mts': 'js', '.cts': 'js',
  '.py': 'py', '.go': 'go', '.rs': 'rs', '.java': 'java', '.kt': 'java',
};

const PATTERNS: Record<string, RegExp[]> = {
  js: [
    /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/,
    /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
    /^\s*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/,
    /^\s*export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/,
    /^(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/,
    /^class\s+([A-Za-z_$][\w$]*)/,
    /^\s{2,4}(?:async\s+|static\s+|public\s+|private\s+|protected\s+)*([A-Za-z_$][\w$]*)\s*(\([^)]*\))\s*(?::[^{]+)?\{\s*$/,
  ],
  py: [/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/, /^class\s+([A-Za-z_]\w*)/, /^\s{4}(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/],
  go: [/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*(\([^)]*\))?/, /^type\s+([A-Za-z_]\w*)/],
  rs: [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)\s*(\([^)]*\))?/, /^\s*(?:pub\s+)?(?:struct|enum|trait)\s+([A-Za-z_]\w*)/],
  java: [/^\s*(?:public|protected|private)?\s*(?:static\s+)?(?:final\s+)?(?:class|interface|enum|record)\s+([A-Za-z_]\w*)/, /^\s*(?:public|protected|private)\s+(?:static\s+)?[\w<>[\], ]+\s+([A-Za-z_]\w*)\s*(\([^)]*\))/],
};

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'constructor', 'else', 'do', 'try']);

export interface Definition {
  name: string;
  signature: string;
  line: number;
}

export interface FileEntry {
  path: string;
  defs: Definition[];
  score: number;
}

export function listSourceFiles(root: string, max = 3000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    if (out.length >= max) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= max) return;
      if (SKIP.has(e.name) || (e.name.startsWith('.') && e.isDirectory())) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (LANG[extname(e.name)] && !/\.min\.js$|\.d\.ts$/.test(e.name)) out.push(full);
    }
  };
  walk(root);
  return out;
}

export function extractDefinitions(text: string, lang: string): Definition[] {
  const defs: Definition[] = [];
  const seen = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const re of PATTERNS[lang] ?? []) {
      const m = re.exec(line);
      if (!m || KEYWORDS.has(m[1])) continue;
      const key = `${m[1]}:${i}`;
      if (seen.has(key)) break;
      seen.add(key);
      defs.push({ name: m[1], signature: line.trim().replace(/\s*\{\s*$/, '').slice(0, 120), line: i + 1 });
      break;
    }
  });
  return defs;
}

/**
 * Aider-style repository map: definitions per file, files ranked by how often other files reference their
 * definitions (a cheap stand-in for PageRank over the reference graph), rendered within a character budget.
 */
export function buildRepoMap(root: string, opts: { budget?: number; focus?: string; query?: string } = {}): { text: string; files: FileEntry[]; totalFiles: number } {
  const budget = opts.budget ?? 6000;
  const paths = listSourceFiles(root);
  const files: (FileEntry & { idents: Map<string, number>; text: string })[] = [];
  for (const p of paths) {
    let text: string;
    try {
      if (statSync(p).size > 400_000) continue;
      text = readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    const idents = new Map<string, number>();
    for (const m of text.matchAll(/[A-Za-z_$][\w$]{2,}/g)) idents.set(m[0], (idents.get(m[0]) ?? 0) + 1);
    files.push({ path: relative(root, p), defs: extractDefinitions(text, LANG[extname(p)]), score: 0, idents, text });
  }
  // Reference counts: how often each defined name appears in *other* files.
  const definedIn = new Map<string, number>();
  for (const f of files) for (const d of f.defs) definedIn.set(d.name, (definedIn.get(d.name) ?? 0) + 1);
  for (const f of files) {
    let score = 0;
    for (const d of f.defs) {
      let refs = 0;
      for (const g of files) if (g !== f) refs += g.idents.get(d.name) ?? 0;
      // Common names defined in many files (e.g. "index", "get") carry less signal.
      score += refs / (definedIn.get(d.name) ?? 1);
    }
    if (/(^|\/)(index|main|app|server|cli)\.[a-z]+$/.test(f.path)) score += 2;
    f.score = score + f.defs.length * 0.1;
  }
  let selected = files.filter((f) => f.defs.length);
  if (opts.focus) selected = selected.filter((f) => f.path.startsWith(opts.focus!.replace(/^\.\//, '')));
  if (opts.query) {
    const q = opts.query.toLowerCase();
    selected = selected
      .map((f) => ({ ...f, defs: f.defs.filter((d) => d.name.toLowerCase().includes(q)) }))
      .filter((f) => f.defs.length || f.path.toLowerCase().includes(q));
  }
  selected.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  const out: string[] = [];
  let used = 0;
  let shown = 0;
  for (const f of selected) {
    const block = [`${f.path}:`, ...f.defs.slice(0, 12).map((d) => `  ${d.line}: ${d.signature}`), ...(f.defs.length > 12 ? [`  … ${f.defs.length - 12} more`] : [])].join('\n');
    if (used + block.length > budget) break;
    out.push(block);
    used += block.length + 1;
    shown++;
  }
  const rest = selected.length - shown;
  const text = out.join('\n') + (rest > 0 ? `\n… ${rest} more files with definitions (use repo_map with a query or path).` : '');
  return { text, files: selected.map(({ path, defs, score }) => ({ path, defs, score })), totalFiles: paths.length };
}
