import type { KnowledgeHit, KnowledgeProvider } from './types.js';

/**
 * Reserved company knowledge provider (see specs/003-knowledge-memory.md).
 * Contract: POST {baseUrl}/search  body {query, k}  → {hits: [{title, text, source|url, score}]}
 * Auth: "Authorization: Bearer <token>" from the configured env var.
 */
export class HttpKnowledgeProvider implements KnowledgeProvider {
  constructor(
    readonly id: string,
    readonly name: string,
    private readonly baseUrl: string,
    private readonly token?: string,
  ) {}

  async search(query: string, k: number): Promise<KnowledgeHit[]> {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: JSON.stringify({ query, k }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status}`);
    const data = (await res.json()) as { hits?: any[] };
    return (data.hits ?? []).map((h) => ({
      title: String(h.title ?? ''),
      text: String(h.text ?? h.content ?? ''),
      source: String(h.source ?? h.url ?? ''),
      score: Number(h.score ?? 0),
    }));
  }
}
