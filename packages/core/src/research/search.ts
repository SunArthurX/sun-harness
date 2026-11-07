import { decodeEntities } from './readable.js';

export interface SearchConfig {
  /** auto: the first provider with a key (tavily, brave, serper, bocha), then searxng, then bing, then duckduckgo. */
  provider: 'auto' | 'bing' | 'duckduckgo' | 'tavily' | 'brave' | 'serper' | 'bocha' | 'searxng';
  /** Bing host: cn.bing.com works in mainland China; www.bing.com elsewhere. */
  bingBase: string;
  searxngUrl?: string;
  keys: { tavily: string; brave: string; serper: string; bocha: string };
}

export const DEFAULT_SEARCH: SearchConfig = {
  provider: 'auto',
  bingBase: 'https://cn.bing.com',
  keys: { tavily: 'TAVILY_API_KEY', brave: 'BRAVE_API_KEY', serper: 'SERPER_API_KEY', bocha: 'BOCHA_API_KEY' },
};

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const strip = (s: string) => decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

/** Bing wraps result links in /ck/a?...&u=a1<base64url>; unwrap them. */
export function unwrapBing(href: string): string {
  const h = decodeEntities(href);
  const u = /[?&]u=a1([^&]+)/.exec(h)?.[1];
  if (!u) return h;
  try {
    return Buffer.from(u.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return h;
  }
}

export function parseBing(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  for (const m of html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)) {
    const a = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(m[0]);
    if (!a) continue;
    const snippet = /<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/.exec(m[0])?.[1] ?? /<p[^>]*>([\s\S]*?)<\/p>/.exec(m[0])?.[1] ?? '';
    out.push({ title: strip(a[2]), url: unwrapBing(a[1]), snippet: strip(snippet) });
  }
  return out;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(re)) {
    let url = m[1];
    const uddg = /uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    out.push({ title: strip(m[2]), url, snippet: strip(m[3]) });
  }
  return out;
}

type Provider = SearchConfig['provider'];

export function pickProvider(cfg: SearchConfig, env: NodeJS.ProcessEnv = process.env): Exclude<Provider, 'auto'> {
  if (cfg.provider !== 'auto') return cfg.provider;
  for (const p of ['tavily', 'brave', 'serper', 'bocha'] as const) if (env[cfg.keys[p]]) return p;
  if (cfg.searxngUrl) return 'searxng';
  return 'bing';
}

async function getJson(url: string, init: RequestInit, signal: AbortSignal): Promise<any> {
  const r = await fetch(url, { ...init, signal });
  if (!r.ok) throw new Error(`search provider answered ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

export async function webSearch(query: string, cfg: SearchConfig, opts: { limit?: number; signal?: AbortSignal } = {}): Promise<{ provider: string; results: SearchResult[] }> {
  const limit = opts.limit ?? 8;
  const signal = AbortSignal.any([opts.signal ?? new AbortController().signal, AbortSignal.timeout(20_000)]);
  const provider = pickProvider(cfg);
  const key = (p: keyof SearchConfig['keys']) => {
    const k = process.env[cfg.keys[p]];
    if (!k) throw new Error(`${p} search needs ${cfg.keys[p]} in the environment.`);
    return k;
  };
  let results: SearchResult[] = [];
  if (provider === 'tavily') {
    const j = await getJson('https://api.tavily.com/search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key('tavily')}` }, body: JSON.stringify({ query, max_results: limit }) }, signal);
    results = (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  } else if (provider === 'brave') {
    const j = await getJson(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`, { headers: { accept: 'application/json', 'x-subscription-token': key('brave') } }, signal);
    results = (j.web?.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: strip(r.description ?? '') }));
  } else if (provider === 'serper') {
    const j = await getJson('https://google.serper.dev/search', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key('serper') }, body: JSON.stringify({ q: query, num: limit }) }, signal);
    results = (j.organic ?? []).map((r: any) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '' }));
  } else if (provider === 'bocha') {
    const j = await getJson('https://api.bochaai.com/v1/web-search', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key('bocha')}` }, body: JSON.stringify({ query, count: limit, summary: true }) }, signal);
    results = (j.data?.webPages?.value ?? []).map((r: any) => ({ title: r.name, url: r.url, snippet: r.summary ?? r.snippet ?? '' }));
  } else if (provider === 'searxng') {
    const j = await getJson(`${cfg.searxngUrl!.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}&format=json`, {}, signal);
    results = (j.results ?? []).map((r: any) => ({ title: r.title, url: r.url, snippet: r.content ?? '' }));
  } else if (provider === 'duckduckgo') {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA }, signal });
    results = parseDuckDuckGo(await r.text());
  } else {
    const r = await fetch(`${cfg.bingBase.replace(/\/$/, '')}/search?q=${encodeURIComponent(query)}`, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8,zh-CN;q=0.6' }, signal });
    results = parseBing(await r.text());
  }
  return { provider, results: results.filter((r) => r.url && r.title).slice(0, limit) };
}

const probes = new Map<string, { ok: boolean; at: number }>();

/** Whether the configured search provider answers (cached 10 minutes). */
export async function searchAvailable(cfg: SearchConfig): Promise<boolean> {
  const provider = pickProvider(cfg);
  if (['tavily', 'brave', 'serper', 'bocha'].includes(provider)) return true;
  const key = `${provider}:${cfg.bingBase}:${cfg.searxngUrl ?? ''}`;
  const hit = probes.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.ok;
  let ok = false;
  try {
    const url = provider === 'searxng' ? `${cfg.searxngUrl}/search?q=test&format=json` : provider === 'duckduckgo' ? 'https://html.duckduckgo.com/html/?q=test' : `${cfg.bingBase}/search?q=test`;
    ok = (await fetch(url, { signal: AbortSignal.timeout(4000), headers: { 'user-agent': UA } })).ok;
  } catch {
    ok = false;
  }
  probes.set(key, { ok, at: Date.now() });
  return ok;
}
