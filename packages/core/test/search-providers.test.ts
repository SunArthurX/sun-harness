import { afterEach, expect, it, vi } from 'vitest';
import { DEFAULT_SEARCH, searchAvailable, webSearch, type SearchConfig } from '../src/research/search.js';

const query = '光伏 & sources';
const item = { title: 'Fixture result', url: 'https://example.test/result', snippet: 'Fixture text' };
const key = 'fixture-only';
const codedQuery = encodeURIComponent(query);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { provider: 'tavily', host: 'api.tavily.com', path: '/search', header: 'authorization', value: `Bearer ${key}`, body: { query, max_results: 1 }, payload: { results: [{ title: item.title, url: item.url, content: item.snippet }] } },
  { provider: 'brave', host: 'api.search.brave.com', path: `/res/v1/web/search?q=${codedQuery}&count=1`, header: 'x-subscription-token', value: key, payload: { web: { results: [{ title: item.title, url: item.url, description: '<b>Fixture</b> text' }] } } },
  { provider: 'serper', host: 'google.serper.dev', path: '/search', header: 'x-api-key', value: key, body: { q: query, num: 1 }, payload: { organic: [{ title: item.title, link: item.url, snippet: item.snippet }] } },
  { provider: 'bocha', host: 'api.bochaai.com', path: '/v1/web-search', header: 'authorization', value: `Bearer ${key}`, body: { query, count: 1, summary: true }, payload: { data: { webPages: { value: [{ name: item.title, url: item.url, summary: item.snippet }] } } } },
] as const)('$provider uses the configured credential and normalizes the vendor response', async (testCase) => {
  const { provider, host, path, header, value, payload } = testCase;
  const config = { ...DEFAULT_SEARCH, provider };
  vi.stubEnv(config.keys[provider], key);
  const fetcher = vi.fn(async (_url: string, _init: RequestInit) => Response.json(payload));
  vi.stubGlobal('fetch', fetcher);
  expect(await webSearch(query, config, { limit: 1 })).toEqual({ provider, results: [item] });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, init] = fetcher.mock.calls[0];
  expect(url).toBe(`https://${host}${path}`);
  expect(new Headers(init.headers).get(header)).toBe(value);
  if ('body' in testCase) {
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(testCase.body);
  } else {
    expect(init.body).toBeUndefined();
  }
  vi.stubEnv(config.keys[provider], undefined);
  await expect(webSearch(query, config)).rejects.toThrow(config.keys[provider]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('normalizes SearXNG, Bing, and DuckDuckGo responses and honors the query limit', async () => {
  const searx = { ...DEFAULT_SEARCH, provider: 'searxng', searxngUrl: 'http://fixture.test/' } satisfies SearchConfig;
  const bing = { ...DEFAULT_SEARCH, provider: 'bing', bingBase: 'https://fixture.test/' } satisfies SearchConfig;
  const duckduckgo = { ...DEFAULT_SEARCH, provider: 'duckduckgo' } satisfies SearchConfig;
  const redirected = `/ck/a?u=a1${Buffer.from(item.url).toString('base64url')}`;
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('http://fixture.test/')) {
      expect(url).toBe(`http://fixture.test/search?q=${codedQuery}&format=json`);
      return Response.json({ results: [{ title: '', url: item.url }, { title: item.title, url: item.url, content: item.snippet }, { title: 'Second', url: item.url }] });
    }
    if (url.startsWith('https://fixture.test/')) {
      expect(url).toBe(`https://fixture.test/search?q=${codedQuery}`);
      return new Response(`<li class="b_algo"><h2><a href="${redirected}">${item.title}</a></h2><p>${item.snippet}</p></li>`);
    }
    expect(url).toBe(`https://html.duckduckgo.com/html/?q=${codedQuery}`);
    return new Response(`<a class="result__a" href="/l/?uddg=${encodeURIComponent(item.url)}">${item.title}</a><a class="result__snippet">${item.snippet}</a>`);
  });
  vi.stubGlobal('fetch', fetcher);
  for (const config of [searx, bing, duckduckgo]) {
    expect(await webSearch(query, config, { limit: 1 })).toEqual({ provider: config.provider, results: [item] });
  }
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it('surfaces provider HTTP failures and caches an unavailable keyless probe', async () => {
  const config = { ...DEFAULT_SEARCH, provider: 'searxng', searxngUrl: 'http://unavailable.fixture.test' } satisfies SearchConfig;
  const fetcher = vi.fn(async () => new Response('fixture unavailable', { status: 503 }));
  vi.stubGlobal('fetch', fetcher);
  await expect(webSearch(query, config)).rejects.toThrow('503: fixture unavailable');
  expect(await searchAvailable(config)).toBe(false);
  expect(await searchAvailable(config)).toBe(false);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
