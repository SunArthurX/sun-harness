import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tokenize } from '../kb/local.js';
import { ensureDir, homePath } from '../paths.js';

export type MemoryKind = 'fact' | 'preference' | 'person' | 'project' | 'lesson' | 'episode';

export interface MemoryItem {
  id: string;
  text: string;
  kind: MemoryKind;
  created: string;
  /** Session the memory came from. */
  source?: string;
  uses: number;
  lastUsed?: string;
}

export interface MemoryConfig {
  /** Modes whose user messages get relevant long-term memories attached. */
  recallModes: string[];
  /** Modes whose finished runs are mined for new memories by a background model call. */
  extractModes: string[];
  autoExtract: boolean;
  recallK: number;
}

export const DEFAULT_MEMORY: MemoryConfig = { recallModes: ['assistant', 'agent'], extractModes: ['assistant'], autoExtract: true, recallK: 4 };

/** Function words carry no topic; with a small memory they would otherwise dominate BM25 (high IDF). */
const STOP = new Set(
  'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its me my no not of on or our she so than that the their them then there these they this to up us was we were what when where which who why will with would you your am also just about over out all any some more most very too only own same such both each few other its'.split(' '),
);
/** Light English stemming so "trains" finds "train" and "booked" finds "booking"; CJK bigrams pass through. */
function stem(t: string): string {
  if (!/^[a-z]+$/.test(t) || t.length <= 4) return t;
  return t.replace(/(ies)$/, 'y').replace(/(ing|ed|es|s)$/, '');
}
const terms = (s: string) => tokenize(s).filter((t) => !STOP.has(t)).map(stem);

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return A.size + B.size ? inter / (A.size + B.size - inter) : 0;
}

/**
 * Long-term memory layer: one JSON line per item in ~/.sun/memory/items.jsonl. The core layer (MEMORY.md) is always in
 * the prompt; items are recalled by relevance (BM25 over words and CJK bigrams, with a small recency/usage prior).
 */
export class MemoryStore {
  private file(): string {
    ensureDir(homePath('memory'));
    return homePath('memory', 'items.jsonl');
  }

  list(): MemoryItem[] {
    const f = this.file();
    if (!existsSync(f)) return [];
    const byId = new Map<string, MemoryItem | null>();
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MemoryItem & { deleted?: boolean };
        byId.set(r.id, r.deleted ? null : r);
      } catch {
        // skip a torn line
      }
    }
    return [...byId.values()].filter((x): x is MemoryItem => !!x);
  }

  private write(item: object): void {
    appendFileSync(this.file(), JSON.stringify(item) + '\n');
  }

  /** Add unless a near-duplicate exists (same normalized text, or ≥ 80% token overlap). */
  add(text: string, kind: MemoryKind = 'fact', source?: string): { item: MemoryItem; duplicate: boolean } {
    const clean = text.trim().replace(/\s+/g, ' ');
    const toks = tokenize(clean);
    const dup = this.list().find((m) => m.kind === kind && (norm(m.text) === norm(clean) || jaccard(tokenize(m.text), toks) >= 0.8));
    if (dup) return { item: dup, duplicate: true };
    const item: MemoryItem = { id: `m_${randomUUID().slice(0, 8)}`, text: clean, kind, created: new Date().toISOString(), source, uses: 0 };
    this.write(item);
    return { item, duplicate: false };
  }

  remove(id: string): boolean {
    if (!this.list().some((m) => m.id === id)) return false;
    this.write({ id, deleted: true });
    return true;
  }

  /** Mark items as used (recency/usage prior for later recall). */
  touch(ids: string[]): void {
    const now = new Date().toISOString();
    for (const m of this.list()) if (ids.includes(m.id)) this.write({ ...m, uses: m.uses + 1, lastUsed: now });
  }

  search(query: string, k = 5, minScore = 0.2): { item: MemoryItem; score: number }[] {
    const items = this.list();
    if (!items.length) return [];
    const docs = items.map((m) => {
      const toks = terms(m.text);
      const tf = new Map<string, number>();
      for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
      return { m, tf, len: toks.length };
    });
    const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const q = [...new Set(terms(query))];
    const N = docs.length;
    const now = Date.now();
    return docs
      .map((d) => {
        let s = 0;
        for (const t of q) {
          const f = d.tf.get(t);
          if (!f) continue;
          const idf = Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
          s += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (d.len / avg)));
        }
        if (s > 0) {
          const ageDays = (now - Date.parse(d.m.lastUsed ?? d.m.created)) / 86_400_000;
          s *= 1 + 0.15 * Math.exp(-ageDays / 30) + 0.05 * Math.min(d.m.uses, 10);
        }
        return { item: d.m, score: s };
      })
      .filter((r) => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  replaceAll(items: MemoryItem[]): void {
    writeFileSync(this.file(), items.map((i) => JSON.stringify(i)).join('\n') + (items.length ? '\n' : ''));
  }
}

export const EXTRACT_SYSTEM = `You maintain the long-term memory of a personal assistant. From the conversation excerpt, extract only durable information worth remembering for future conversations: stable facts about the user (role, location, family, tools), preferences (style, language, schedule habits), people and their relation to the user, ongoing projects, and lessons (what worked or failed). Only record what the user said or confirmed — never the assistant's own suggestions, plans or offers, and never guesses ("may want…"). Do not store one-off requests, secrets, passwords, or anything already listed under "Known" (not even rephrased).
Answer with JSON only: {"memories": [{"text": "...", "kind": "fact|preference|person|project|lesson", "core": false}], "episode": "one line: what happened in this conversation"}
Set "core": true only for identity-level facts that matter in almost every conversation (name, language, time zone). Use an empty list when nothing qualifies. Write memories in the user's language, one fact each, under 25 words.`;

export function parseExtraction(text: string): { memories: { text: string; kind: MemoryKind; core: boolean }[]; episode?: string } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  if (!json) return { memories: [] };
  try {
    const j = JSON.parse(json);
    const kinds = new Set(['fact', 'preference', 'person', 'project', 'lesson']);
    const memories = (Array.isArray(j.memories) ? j.memories : [])
      .filter((m: any) => typeof m?.text === 'string' && m.text.trim().length > 3 && m.text.length < 400)
      .map((m: any) => ({ text: m.text.trim(), kind: (kinds.has(m.kind) ? m.kind : 'fact') as MemoryKind, core: m.core === true }));
    return { memories, episode: typeof j.episode === 'string' && j.episode.trim() ? j.episode.trim().slice(0, 300) : undefined };
  } catch {
    return { memories: [] };
  }
}

export function formatRecall(hits: { item: MemoryItem }[]): string {
  return `[Relevant memories — recalled automatically; use them if they help, ignore them if not]\n${hits.map((h) => `- (${h.item.kind}, ${h.item.created.slice(0, 10)}) ${h.item.text}`).join('\n')}`;
}
