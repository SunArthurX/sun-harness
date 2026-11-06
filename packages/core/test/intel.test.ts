import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { analyzeIntelDay, launchdPlist, listIntelReports, listProposals, markdownToHtml, parseChangelog, parseFeed, runIntel, type IntelSource } from '../src/index.js';
import { tempHome } from './helpers.js';

const sources: IntelSource[] = [
  { id: 'codex', name: 'Codex', kind: 'github-releases', target: 'openai/codex' },
  { id: 'cc', name: 'Claude Code', kind: 'github-changelog', target: 'anthropics/claude-code', path: 'CHANGELOG.md' },
  { id: 'feed', name: 'Blog', kind: 'rss', target: 'https://example.com/feed.xml' },
  { id: 'broken', name: 'Broken', kind: 'page', target: 'https://example.com/404' },
];

const now = new Date('2026-11-07T09:00:00Z');

function fakeFetch(releases: any[]): typeof fetch {
  return (async (url: string) => {
    const u = String(url);
    if (u.includes('api.github.com')) return new Response(JSON.stringify(releases));
    if (u.includes('raw.githubusercontent.com')) return new Response('# Changelog\n\n## 2.1.0\n- Added hooks\n\n## 2.0.9\n- Fix\n');
    if (u.endsWith('feed.xml'))
      return new Response('<rss><channel><item><title>Agents &amp; MCP</title><link>https://example.com/a</link><guid>a1</guid><pubDate>Thu, 05 Nov 2026 10:00:00 GMT</pubDate><description><![CDATA[<p>New MCP features</p>]]></description></item></channel></rss>');
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('intel', () => {
  beforeEach(() => tempHome());

  it('parses changelogs and feeds', () => {
    expect(parseChangelog('## [1.2.0] - 2026\n- a\n## 1.1.0\n- b').map((s) => s.version)).toEqual(['1.2.0', '1.1.0']);
    expect(parseFeed('<feed><entry><title>T</title><link href="https://x"/><id>i</id><updated>2026-01-01</updated><summary>S</summary></entry></feed>')[0]).toMatchObject({ title: 'T', url: 'https://x', id: 'i' });
  });

  it('fetches, dedupes across runs, analyzes, and files proposals', async () => {
    const releases = [{ tag_name: 'v0.50', name: 'v0.50', html_url: 'https://gh/r', published_at: '2026-11-06T00:00:00Z', body: 'Adds sandbox profiles' }];
    let prompt = '';
    const complete = async (_s: string, u: string) => {
      prompt = u;
      return '# Harness Intel — 2026-11-07\n## TL;DR\n- Codex adds sandbox profiles\n\n```json\n[{"title":"Sandbox profiles","content":"Add named sandbox profiles","rationale":"Codex v0.50","priority":"P1"}]\n```';
    };
    const r1 = await runIntel({ sources, complete, fetchImpl: fakeFetch(releases), now });
    expect(r1.items.map((i) => `${i.sourceId}:${i.id}`).sort()).toEqual(['cc:2.0.9', 'cc:2.1.0', 'codex:v0.50', 'feed:a1']);
    expect(r1.errors.map((e) => e.source)).toEqual(['broken']);
    expect(r1.analyzed).toBe(true);
    expect(prompt).toContain('Adds sandbox profiles');
    expect(readFileSync(r1.htmlPath, 'utf8')).toContain('<h1>Harness Intel');
    expect(listProposals('pending').map((p) => p.title)).toEqual(['Sandbox profiles']);

    const r2 = await runIntel({ sources, complete, fetchImpl: fakeFetch(releases), now });
    expect(r2.items).toHaveLength(0);

    const r3 = await runIntel({ sources, complete, fetchImpl: fakeFetch([{ ...releases[0], tag_name: 'v0.51', body: 'New' }, ...releases]), now });
    expect(r3.items.map((i) => i.id)).toEqual(['v0.51']);
  });

  it('keeps raw items when analysis fails (quota) and can analyze later', async () => {
    const r = await runIntel({
      sources: sources.slice(0, 1),
      complete: async () => {
        throw new Error('HTTP 402: Insufficient Balance');
      },
      fetchImpl: fakeFetch([{ tag_name: 'v1', name: 'v1', html_url: 'u', published_at: '2026-11-06T00:00:00Z', body: 'b' }]),
      now,
    });
    expect(r.analyzed).toBe(false);
    expect(readFileSync(r.reportPath, 'utf8')).toContain('Analysis pending');
    expect(listIntelReports()[0]).toMatchObject({ date: '2026-11-07', pending: true });
    const again = await analyzeIntelDay('2026-11-07', async () => '# Harness Intel\nAnalyzed now.');
    expect(again.analyzed).toBe(true);
    expect(listIntelReports()[0].pending).toBe(false);
  });

  it('renders markdown with mermaid and builds a launchd plist', () => {
    const html = markdownToHtml('# T\n\n```mermaid\nflowchart LR\nA-->B\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n- x');
    expect(html).toContain('<pre class="mermaid">');
    expect(html).toContain('<td>1</td>');
    const { xml } = launchdPlist({ nodePath: '/usr/bin/node', cliPath: '/x/cli.js', hour: 9, minute: 5 });
    expect(xml).toContain('<integer>9</integer>');
    expect(xml).toContain('intel run');
    expect(xml).not.toContain('API_KEY');
  });
});
