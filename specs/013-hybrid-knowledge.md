# 013 — Hybrid knowledge retrieval

Status: implemented (iteration 6). Extends `specs/003-knowledge-memory.md` (ADR 0003 said embeddings would arrive as another provider without changing the seam).
Code: `packages/core/src/kb/hybrid.ts`, `host.ts` (`makeHybrid`, `kbIndex`), CLI `sun kb index`, desktop Settings / Knowledge.

## Behavior

- Off by default: `kb.embeddings = { enabled: false, model: "qwen/text-embedding-v4", dimensions? }`. Enabling it sends note chunks to the embedding provider (an explicit owner decision).
- `model` is `provider/model`; the provider must be an OpenAI-compatible entry in `providers` (its base URL and key are reused). Request: `POST {baseUrl}/embeddings {model, input[], dimensions?}`.
- When enabled, the personal provider becomes `HybridKB` over the same `LocalMarkdownKB`:
  1. BM25 ranks a pool of `max(5k, 30)` chunks.
  2. Embeddings rank chunks by cosine similarity to the query embedding.
  3. Reciprocal rank fusion: `score = Σ 1/(60 + rank)` over both lists; top `k` returned.
- Embeddings are cached on disk (`~/.sun/kb-index/embeddings.json`), keyed by `sha1(model + chunk text)`, stored as base64 Float32. Only new or changed chunks are embedded (batches of 10); removed chunks are pruned; a model change invalidates the cache.
- Indexing happens lazily on search, or explicitly with `sun kb index`.
- Failure (quota, auth, network): the search returns BM25 results and records `lastError`, shown in `kbStats` and on the Knowledge screen. Retrieval never fails because embeddings did.

## Why fusion instead of replacing BM25

Lexical search is exact for names, code identifiers and rare words; embeddings recall paraphrases and cross-lingual matches (an English question finds a Chinese note). Rank fusion keeps both without tuning score scales.
