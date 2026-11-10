import { readFileSync, statSync } from 'node:fs';
import { relative } from 'node:path';
import { tokenize } from '../kb/local.js';
import { extractDefinitions, listSourceFiles } from '../repomap.js';
import { findProjectRoot } from '../rules.js';
import { isIgnored } from './ignore.js';

export interface CodeHit {
  path: string;
  line: number;
  text: string;
  score: number;
}

interface Chunk {
  path: string;
  line: number;
  text: string;
  tf: Map<string, number>;
  len: number;
}

const LINES = 40;
const caches = new Map<string, { stamp: string; chunks: Chunk[]; df: Map<string, number> }>();

function chunkFile(rel: string, text: string): Chunk[] {
  const lines = text.split('\n');
  const out: Chunk[] = [];
  for (let i = 0; i < lines.length; i += LINES) {
    const slice = lines.slice(i, i + LINES).join('\n');
    if (!slice.trim()) continue;
    const tf = new Map<string, number>();
    for (const t of tokenize(slice)) tf.set(t, (tf.get(t) ?? 0) + 1);
    out.push({ path: rel, line: i + 1, text: slice.slice(0, 1200), tf, len: Math.max(1, tf.size) });
  }
  return out;
}

function index(root: string): { chunks: Chunk[]; df: Map<string, number> } {
  const files = listSourceFiles(root).filter((f) => !isIgnored(root, f));
  const stamp = files
    .slice(0, 2000)
    .map((f) => {
      try {
        return `${f}:${statSync(f).mtimeMs}`;
      } catch {
        return f;
      }
    })
    .join('|');
  const hit = caches.get(root);
  if (hit && hit.stamp === stamp) return hit;
  const chunks: Chunk[] = [];
  const df = new Map<string, number>();
  for (const abs of files) {
    let text = '';
    try {
      if (statSync(abs).size > 200_000) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    if (text.includes('\u0000')) continue;
    for (const c of chunkFile(relative(root, abs), text)) {
      chunks.push(c);
      for (const t of c.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const next = { stamp, chunks, df };
  caches.set(root, next);
  return next;
}

/** Drop a cached index (tests). */
export function clearCodebaseIndex(root?: string): void {
  if (root) caches.delete(root);
  else caches.clear();
}

/**
 * Local codebase search: BM25 over source chunks, plus exact definition hits when the query is a symbol name.
 * No network and no embeddings; the index is rebuilt when a file's mtime changes.
 */
export function searchCodebase(cwd: string, query: string, k = 8): CodeHit[] {
  const root = findProjectRoot(cwd);
  const { chunks, df } = index(root);
  const hits: CodeHit[] = [];
  if (/^[A-Za-z_$][\w$]*$/.test(query.trim())) {
    const q = query.trim();
    for (const abs of listSourceFiles(root)) {
      if (isIgnored(root, abs)) continue;
      let text = '';
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue;
      }
      const lang = abs.endsWith('.py') ? 'py' : abs.endsWith('.go') ? 'go' : abs.endsWith('.rs') ? 'rs' : abs.endsWith('.java') || abs.endsWith('.kt') ? 'java' : 'js';
      for (const d of extractDefinitions(text, lang)) {
        if (d.name === q || d.name.toLowerCase() === q.toLowerCase()) {
          hits.push({ path: relative(root, abs), line: d.line, text: d.signature, score: 100 });
        }
      }
    }
  }
  if (chunks.length) {
    const N = chunks.length;
    const avg = chunks.reduce((s, c) => s + c.len, 0) / N;
    const terms = [...new Set(tokenize(query))];
    const scored: { c: Chunk; s: number }[] = [];
    for (const c of chunks) {
      let s = 0;
      for (const t of terms) {
        const f = c.tf.get(t);
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
        s += (idf * (f * 2.4)) / (f + 1.4 * (1 - 0.75 + (0.75 * c.len) / avg));
      }
      if (s > 0) scored.push({ c, s });
    }
    scored.sort((a, b) => b.s - a.s);
    for (const { c, s } of scored.slice(0, k)) hits.push({ path: c.path, line: c.line, text: c.text, score: Math.round(s * 100) / 100 });
  }
  const seen = new Set<string>();
  return hits.filter((h) => {
    const key = `${h.path}:${h.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, k + 4);
}
