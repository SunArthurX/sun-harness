# 0003 — BM25 with CJK bigrams before embeddings

## Context

The personal knowledge base must work offline, instantly, and for Chinese and English notes.

## Decision

In-memory BM25 over heading-sized chunks, tokenized as ASCII words plus CJK character bigrams, refreshed incrementally by mtime. Retrieval sits behind the `KnowledgeProvider` seam.

## Consequences

No model or key needed for search. Semantic recall is weaker than embeddings; a vector provider can be added as a plugin later without changing callers.
