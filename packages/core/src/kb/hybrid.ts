import { createHash } from 'node:crypto';
import { withStorageLock } from '../settings/storage-lock.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureDir, homePath } from '../paths.js';
import { classifyHttpError } from '../providers/types.js';
import type { LocalMarkdownKB } from './local.js';
import type { KnowledgeHit, KnowledgeProvider } from './types.js';

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/** OpenAI-compatible POST {baseUrl}/embeddings (OpenAI, DashScope, GLM, Gemini compat, Ollama, …). */
export function openAIEmbedder(opts: { baseUrl: string; apiKey?: string; model: string; dimensions?: number }): EmbedFn {
  return async (texts) => {
    const res = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, input: texts, ...(opts.dimensions ? { dimensions: opts.dimensions } : {}) }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw classifyHttpError(res.status, await res.text().catch(() => ''));
    const data = (await res.json()) as { data: { embedding: number[]; index?: number }[] };
    return [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((d) => d.embedding);
  };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

const toB64 = (v: number[] | Float32Array) => Buffer.from(new Float32Array(v).buffer).toString('base64');
const fromB64 = (s: string) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

/** Content-addressed embedding cache on disk: re-indexing only embeds chunks whose text changed. */
class EmbeddingCache {
  private entries: Record<string, string> = {};
  private dirty = false;
  constructor(
    private readonly file: string,
    readonly model: string,
  ) {
    if (existsSync(file)) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'));
        if (data.model === model) this.entries = data.entries ?? {};
      } catch {
        // corrupt cache: rebuild
      }
    }
  }
  key(text: string): string {
    return createHash('sha1').update(`${this.model}\n${text}`).digest('hex');
  }
  get(key: string): Float32Array | undefined {
    const v = this.entries[key];
    return v ? fromB64(v) : undefined;
  }
  set(key: string, v: number[]): void {
    this.entries[key] = toB64(v);
    this.dirty = true;
  }
  prune(keep: Set<string>): void {
    for (const k of Object.keys(this.entries)) if (!keep.has(k)) (delete this.entries[k], (this.dirty = true));
  }
  save(): void {
    if (!this.dirty) return;
    ensureDir(homePath('kb-index'));
    withStorageLock(() => writeFileSync(this.file, JSON.stringify({ model: this.model, entries: this.entries })));
    this.dirty = false;
  }
  size(): number {
    return Object.keys(this.entries).length;
  }
}

export interface HybridOptions {
  embed: EmbedFn;
  model: string;
  batch?: number;
  /** Reciprocal rank fusion constant. */
  rrfK?: number;
  cacheFile?: string;
}

/**
 * Hybrid retrieval over the personal KB: BM25 ranks and embedding (cosine) ranks fused with
 * reciprocal rank fusion. If embeddings fail (quota, network), it degrades to BM25 and reports why.
 */
export class HybridKB implements KnowledgeProvider {
  readonly id: string;
  readonly name: string;
  private cache: EmbeddingCache;
  lastError?: string;

  constructor(
    private readonly kb: LocalMarkdownKB,
    private readonly opts: HybridOptions,
  ) {
    this.id = kb.id;
    this.name = `${kb.name} (hybrid)`;
    this.cache = new EmbeddingCache(opts.cacheFile ?? homePath('kb-index', 'embeddings.json'), opts.model);
  }

  private chunkText(c: { title: string; text: string }): string {
    return `${c.title}\n${c.text}`;
  }

  /** Embed every chunk that is not cached yet. Returns how many were embedded. */
  async index(): Promise<number> {
    const chunks = this.kb.allChunks();
    const keys = new Set<string>();
    const missing: { key: string; text: string }[] = [];
    for (const c of chunks) {
      const text = this.chunkText(c);
      const key = this.cache.key(text);
      keys.add(key);
      if (!this.cache.get(key) && !missing.some((m) => m.key === key)) missing.push({ key, text });
    }
    const batch = this.opts.batch ?? 10;
    for (let i = 0; i < missing.length; i += batch) {
      const part = missing.slice(i, i + batch);
      const vecs = await this.opts.embed(part.map((m) => m.text.slice(0, 6000)));
      part.forEach((m, j) => this.cache.set(m.key, vecs[j]));
      this.cache.save();
    }
    this.cache.prune(keys);
    this.cache.save();
    return missing.length;
  }

  async search(query: string, k: number): Promise<KnowledgeHit[]> {
    const pool = Math.max(k * 5, 30);
    const lexical = await this.kb.search(query, pool);
    let semantic: { hit: KnowledgeHit; s: number }[] = [];
    try {
      await this.index();
      const [qv] = await this.opts.embed([query]);
      const q = new Float32Array(qv);
      semantic = this.kb
        .allChunks()
        .map((c) => {
          const v = this.cache.get(this.cache.key(this.chunkText(c)));
          return { hit: { title: c.title, text: c.text, source: c.source, score: 0 }, s: v ? cosine(q, v) : -1 };
        })
        .filter((x) => x.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, pool);
      this.lastError = undefined;
    } catch (e) {
      this.lastError = (e as Error).message.slice(0, 300);
      return lexical.slice(0, k);
    }
    const K = this.opts.rrfK ?? 60;
    const id = (h: KnowledgeHit) => `${h.source}\u0000${h.title}\u0000${h.text}`;
    const fused = new Map<string, { hit: KnowledgeHit; score: number }>();
    const addRanks = (list: KnowledgeHit[]) =>
      list.forEach((h, rank) => {
        const cur = fused.get(id(h)) ?? { hit: h, score: 0 };
        cur.score += 1 / (K + rank + 1);
        fused.set(id(h), cur);
      });
    addRanks(lexical);
    addRanks(semantic.map((x) => x.hit));
    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ hit, score }) => ({ ...hit, score: Math.round(score * 10_000) / 100 }));
  }

  async add(title: string, text: string): Promise<string> {
    return this.kb.add(title, text);
  }

  async stats() {
    const base = await this.kb.stats();
    return { ...base, embedded: this.cache.size(), model: this.opts.model, lastError: this.lastError };
  }
}
