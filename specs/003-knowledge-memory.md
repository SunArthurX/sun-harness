# 003 — Knowledge and memory

Status: implemented (M2). Code: `packages/core/src/kb/*`, `memory.ts`.

## Knowledge seam

```ts
interface KnowledgeProvider {
  id: string; name: string;
  search(query: string, k: number): Promise<KnowledgeHit[]>; // {title, text, source, score}
  add?(title: string, text: string): Promise<string>;
  stats?(): Promise<{ documents: number; chunks: number }>;
}
```

Providers are merged by score in `kb_search`; a failing provider returns an error hit instead of failing the search.

## Personal KB (local)

- Roots: `kb.roots` (default `~/.sun/kb`). Any folder of Markdown works (an Obsidian vault included; `.obsidian`, `.git`, `node_modules` are skipped).
- Files `.md .markdown .mdx .txt` are chunked by heading (≤ ~1800 chars, long sections split with overlap) and ranked with BM25.
- Tokenizer: ASCII words plus CJK character bigrams, so Chinese and Japanese notes are searchable without a segmenter.
- The index is in memory and refreshed incrementally by file mtime on every search.
- `kb_add_note` writes `<root>/notes/<date>-<slug>.md`.

Decision: BM25 before embeddings. It is deterministic, offline, and needs no model; embeddings can arrive later as another provider (plugin) without changing the seam.

## Company KB (reserved)

- Enabled with `kb.company = { enabled: true, baseUrl, tokenEnv, name }`.
- Contract: `POST {baseUrl}/search` with `{ "query": string, "k": number }` and `Authorization: Bearer $<tokenEnv>`; response `{ "hits": [{ "title", "text"|"content", "source"|"url", "score" }] }`.
- Any internal search (Elastic, Confluence, a RAG service) can be adapted with a thin HTTP shim, or a plugin can register a richer provider.

## Memory

- One file: `~/.sun/memory/MEMORY.md`, sections as `## Heading`, facts as `- bullet`. Included in every system prompt (last 12k chars).
- `memory_save(fact, section)` appends under the section, de-duplicated. Editable in the desktop Knowledge page.
