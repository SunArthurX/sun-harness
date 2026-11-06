import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { KnowledgeHit, KnowledgeProvider } from './types.js';

const EXTS = new Set(['.md', '.markdown', '.mdx', '.txt']);
const SKIP = new Set(['.git', 'node_modules', '.obsidian', '.trash', '.vault-meta']);
const CHUNK = 1200;

/** ASCII words + CJK character bigrams, so Chinese/Japanese notes are searchable without a segmenter. */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const lower = text.toLowerCase();
  for (const m of lower.matchAll(/[a-z0-9_]{2,}/g)) out.push(m[0]);
  for (const run of lower.match(/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g) ?? []) {
    if (run.length === 1) out.push(run);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

interface Chunk {
  file: string;
  title: string;
  text: string;
  tf: Map<string, number>;
  len: number;
}

export function chunkMarkdown(file: string, text: string): { title: string; text: string }[] {
  const docTitle = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? basename(file, extname(file));
  const sections: { title: string; text: string }[] = [];
  let cur = { title: docTitle, lines: [] as string[] };
  for (const line of text.split('\n')) {
    const h = /^#{1,4}\s+(.+)$/.exec(line);
    if (h && cur.lines.join('\n').trim()) {
      sections.push({ title: cur.title, text: cur.lines.join('\n').trim() });
      cur = { title: `${docTitle} › ${h[1].trim()}`, lines: [line] };
    } else {
      if (h) cur.title = h[1].trim() === docTitle ? docTitle : `${docTitle} › ${h[1].trim()}`;
      cur.lines.push(line);
    }
  }
  if (cur.lines.join('\n').trim()) sections.push({ title: cur.title, text: cur.lines.join('\n').trim() });
  const out: { title: string; text: string }[] = [];
  for (const s of sections) {
    if (s.text.length <= CHUNK * 1.5) out.push(s);
    else for (let i = 0; i < s.text.length; i += CHUNK - 150) out.push({ title: s.title, text: s.text.slice(i, i + CHUNK) });
  }
  return out;
}

/** Local markdown knowledge base with an in-memory BM25 index, refreshed incrementally by mtime. */
export class LocalMarkdownKB implements KnowledgeProvider {
  readonly id: string;
  readonly name: string;
  private files = new Map<string, { mtime: number; chunks: Chunk[] }>();
  private df = new Map<string, number>();

  constructor(
    private readonly roots: string[],
    opts: { id?: string; name?: string } = {},
  ) {
    this.id = opts.id ?? 'personal';
    this.name = opts.name ?? 'Personal KB';
  }

  private walk(dir: string, out: string[]): void {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) this.walk(full, out);
      else if (EXTS.has(extname(e.name).toLowerCase())) out.push(full);
    }
  }

  refresh(): void {
    const present: string[] = [];
    for (const r of this.roots) this.walk(r, present);
    const set = new Set(present);
    let changed = false;
    for (const f of [...this.files.keys()]) if (!set.has(f)) (this.files.delete(f), (changed = true));
    for (const f of present) {
      const st = statSync(f);
      if (st.size > 5_000_000) continue;
      const prev = this.files.get(f);
      if (prev && prev.mtime === st.mtimeMs) continue;
      const chunks = chunkMarkdown(f, readFileSync(f, 'utf8')).map((c) => {
        const toks = tokenize(`${c.title} ${c.text}`);
        const tf = new Map<string, number>();
        for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { file: f, title: c.title, text: c.text, tf, len: toks.length };
      });
      this.files.set(f, { mtime: st.mtimeMs, chunks });
      changed = true;
    }
    if (changed) {
      this.df.clear();
      for (const { chunks } of this.files.values()) for (const c of chunks) for (const t of c.tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
  }

  async search(query: string, k = 6): Promise<KnowledgeHit[]> {
    this.refresh();
    const all = [...this.files.values()].flatMap((f) => f.chunks);
    if (!all.length) return [];
    const N = all.length;
    const avg = all.reduce((s, c) => s + c.len, 0) / N;
    const q = [...new Set(tokenize(query))];
    const k1 = 1.4;
    const b = 0.75;
    const scored: { c: Chunk; s: number }[] = [];
    for (const c of all) {
      let s = 0;
      for (const t of q) {
        const f = c.tf.get(t);
        if (!f) continue;
        const df = this.df.get(t) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += (idf * (f * (k1 + 1))) / (f + k1 * (1 - b + (b * c.len) / avg));
      }
      if (s > 0) scored.push({ c, s });
    }
    return scored
      .sort((a, b2) => b2.s - a.s)
      .slice(0, k)
      .map(({ c, s }) => ({ title: c.title, text: c.text.slice(0, 1500), source: c.file, score: Math.round(s * 100) / 100 }));
  }

  async add(title: string, text: string): Promise<string> {
    const dir = join(this.roots[0], 'notes');
    mkdirSync(dir, { recursive: true });
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9\u3400-\u9fff]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60) || 'note';
    const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${slug}.md`);
    writeFileSync(file, `# ${title}\n\n${text.trim()}\n`);
    return file;
  }

  async stats(): Promise<{ documents: number; chunks: number }> {
    this.refresh();
    let chunks = 0;
    for (const f of this.files.values()) chunks += f.chunks.length;
    return { documents: this.files.size, chunks };
  }
}
