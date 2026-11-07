# Knowledge and memory

## Personal knowledge base

Any folder of Markdown or text files. Default `~/.sun/kb`; add more folders (an Obsidian vault, a docs repo) in Settings or config:

```json
{ "kb": { "roots": ["/Users/me/.sun/kb", "/Users/me/Notes"] } }
```

- Agents search with `kb_search`; you search on the Knowledge screen or with `sun kb search <query>`.
- Ranking is BM25 over heading-sized chunks; Chinese/Japanese/Korean text is indexed with character bigrams.
- New files are picked up automatically (incremental by modification time).
- Add a note: Knowledge screen, `sun kb add "<title>" file.md`, or ask the agent ("save this as a note").

## Hybrid retrieval (optional)

Keyword search (BM25) finds exact words. Turn on embeddings to also find notes that mean the same thing in other words, or in another language:

```json
{ "kb": { "embeddings": { "enabled": true, "model": "qwen/text-embedding-v4" } } }
```

Or tick **Hybrid retrieval** in Settings. The model is `provider/model` from your configured providers (DashScope `text-embedding-v4`, OpenAI `text-embedding-3-small`, Ollama `nomic-embed-text`, …). Note text is sent to that provider, which is why it is off by default.

- `sun kb index` embeds every note now; otherwise indexing happens on the first search. Only new or changed notes are embedded again (cache in `~/.sun/kb-index/`).
- Results combine both rankings. Example: the question "how can I sleep better at night" finds a Chinese note titled 失眠 ("insomnia") that keyword search alone cannot.
- If the embedding provider fails (no balance, offline), search falls back to keywords and the Knowledge screen shows why.

## Company knowledge base (reserved)

Point sun-harness at an HTTP search endpoint:

```json
{ "kb": { "company": { "enabled": true, "name": "Acme KB", "baseUrl": "https://kb.acme.internal/api", "tokenEnv": "COMPANY_KB_TOKEN" } } }
```

Contract: `POST <baseUrl>/search` with `{"query": "...", "k": 6}` and `Authorization: Bearer $COMPANY_KB_TOKEN`; respond `{"hits": [{"title", "text", "source", "score"}]}`. Results merge with personal hits. For richer integrations (vector DB, Confluence, Notion), write a plugin that calls `api.registerKnowledgeProvider`.

## Memory

`~/.sun/memory/MEMORY.md` is part of every system prompt. The agent adds facts with `memory_save` ("remember that I prefer pnpm"); evolution can add facts from reflection. Edit it freely — it is plain Markdown:

```markdown
# Memory
## Profile
- Name: Arthur; software engineer.
## Preferences
- Prefers pnpm and TypeScript strict mode.
```
