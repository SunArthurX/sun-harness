export interface KnowledgeHit {
  title: string;
  text: string;
  /** file path or URL */
  source: string;
  score: number;
}

/**
 * Knowledge seam. Personal (local markdown) today; company KB, vector stores, Notion, etc. plug in here.
 */
export interface KnowledgeProvider {
  id: string;
  name: string;
  search(query: string, k: number): Promise<KnowledgeHit[]>;
  /** Optional: providers that accept new documents. */
  add?(title: string, text: string): Promise<string>;
  stats?(): Promise<{ documents: number; chunks: number }>;
}
