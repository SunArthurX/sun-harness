import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { HarnessHost, HybridKB, LocalMarkdownKB, ProviderError, homePath, type EmbedFn } from '../src/index.js';
import { tempHome, testConfig } from './helpers.js';

// Concept embedder: synonyms share a dimension, so "automobile" is close to "car" with no shared token.
const CONCEPTS = [/car|automobile|vehicle|汽车/i, /cook|recipe|braise|红烧/i, /sleep|insomnia|rest/i];
function fakeEmbed(calls: { n: number }): EmbedFn {
  return async (texts) => {
    calls.n += texts.length;
    return texts.map((t) => CONCEPTS.map((re) => (re.test(t) ? 1 : 0)).concat([0.01]));
  };
}

function notes(): string {
  const root = homePath('kb');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'garage.md'), '# Garage\n\nMy car needs new tires before winter.');
  writeFileSync(join(root, 'kitchen.md'), '# Kitchen\n\nBraise pork belly slowly with soy sauce.');
  writeFileSync(join(root, 'health.md'), '# Health\n\nTrouble falling asleep: no screens after 22:00.');
  return root;
}

describe('hybrid knowledge retrieval', () => {
  beforeEach(() => tempHome());

  it('finds semantically related notes that BM25 alone misses', async () => {
    const root = notes();
    const local = new LocalMarkdownKB([root]);
    expect(await local.search('automobile maintenance', 3)).toEqual([]);
    const hybrid = new HybridKB(local, { embed: fakeEmbed({ n: 0 }), model: 'fake/m' });
    const hits = await hybrid.search('automobile maintenance', 2);
    expect(hits[0].source).toContain('garage.md');
  });

  it('fuses lexical and semantic ranks (a note strong in both wins)', async () => {
    const root = notes();
    writeFileSync(join(root, 'cars-cooking.md'), '# Road trip\n\nCook dinner on the car trip: a simple recipe.');
    const hybrid = new HybridKB(new LocalMarkdownKB([root]), { embed: fakeEmbed({ n: 0 }), model: 'fake/m' });
    const hits = await hybrid.search('recipe', 3);
    expect(hits.map((h) => h.source.split('/').pop())).toEqual(expect.arrayContaining(['cars-cooking.md', 'kitchen.md']));
    expect(hits[0].source).toContain('cars-cooking.md');
  });

  it('caches embeddings by content and only re-embeds changed chunks', async () => {
    const root = notes();
    const calls = { n: 0 };
    const local = new LocalMarkdownKB([root]);
    const hybrid = new HybridKB(local, { embed: fakeEmbed(calls), model: 'fake/m' });
    expect(await hybrid.index()).toBe(3);
    expect(await hybrid.index()).toBe(0);
    // A fresh instance reads the disk cache.
    const again = new HybridKB(new LocalMarkdownKB([root]), { embed: fakeEmbed(calls), model: 'fake/m' });
    expect(await again.index()).toBe(0);
    writeFileSync(join(root, 'health.md'), '# Health\n\nRest days matter.');
    expect(await again.index()).toBe(1);
    expect((await again.stats()).embedded).toBe(3);
    // A different model invalidates the cache.
    expect(await new HybridKB(new LocalMarkdownKB([root]), { embed: fakeEmbed(calls), model: 'fake/other' }).index()).toBe(3);
  });

  it('falls back to BM25 when embeddings fail (quota) and reports the reason', async () => {
    const root = notes();
    const failing: EmbedFn = async () => {
      throw new ProviderError('quota', 'HTTP 429: 余额不足', 429);
    };
    const hybrid = new HybridKB(new LocalMarkdownKB([root]), { embed: failing, model: 'fake/m' });
    const hits = await hybrid.search('tires winter', 3);
    expect(hits[0].source).toContain('garage.md');
    expect((await hybrid.stats()).lastError).toContain('余额不足');
  });

  it('the host uses hybrid retrieval only when enabled in config', async () => {
    notes();
    const calls = { n: 0 };
    const off = new HarnessHost({ config: testConfig(), loadPlugins: false, connectMcp: false, shellHooks: false, embedder: fakeEmbed(calls) });
    expect(off.knowledgeProviders()[0].name).toBe('Personal KB');
    expect((await off.kbSearch('automobile', 2)).length).toBe(0);
    const cfg = testConfig();
    const on = new HarnessHost({
      config: { ...cfg, kb: { ...cfg.kb, roots: [homePath('kb')], embeddings: { enabled: true, model: 'qwen/text-embedding-v4' } } },
      loadPlugins: false,
      connectMcp: false,
      shellHooks: false,
      embedder: fakeEmbed(calls),
    });
    expect(on.knowledgeProviders()[0].name).toContain('hybrid');
    expect((await on.kbSearch('automobile', 2))[0].source).toContain('garage.md');
    expect(await on.kbIndex()).toEqual({ embedded: 0, enabled: true });
    expect(calls.n).toBeGreaterThan(0);
  });
});
