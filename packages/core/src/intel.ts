import { isCalendarDate, localDate, requireCalendarDate } from './util/date.js';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IntelSource } from './config.js';
import { addProposal, type Complete } from './evolution.js';
import { ensureDir, homePath } from './paths.js';
import { htmlToText } from './tools/builtin.js';
import { extractJson } from './util/json.js';
import { htmlPage, markdownToHtml } from './util/markdown.js';

export interface IntelItem {
  sourceId: string;
  sourceName: string;
  /** Stable id: tag, version, or content hash. */
  id: string;
  title: string;
  url: string;
  publishedAt?: string;
  body: string;
}

export interface IntelRunResult {
  date: string;
  items: IntelItem[];
  errors: { source: string; error: string }[];
  reportPath: string;
  htmlPath: string;
  analyzed: boolean;
  analysisError?: string;
  proposals: number;
}

type Fetch = typeof fetch;

let cachedToken: string | null | undefined;
export function githubToken(): string | undefined {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (cachedToken === undefined) {
    const r = spawnSync('gh', ['auth', 'token'], { encoding: 'utf8', timeout: 5000 });
    cachedToken = r.status === 0 ? r.stdout.trim() || null : null;
  }
  return cachedToken ?? undefined;
}

function ghHeaders(): Record<string, string> {
  const t = githubToken();
  return { accept: 'application/vnd.github+json', 'user-agent': 'sun-harness-intel', ...(t ? { authorization: `Bearer ${t}` } : {}) };
}

/** Split a CHANGELOG.md into version sections ("## 1.2.3" or "## [1.2.3]"). */
export function parseChangelog(md: string, max = 6): { version: string; body: string }[] {
  const out: { version: string; body: string }[] = [];
  const re = /^##\s+\[?([^\]\s]+)\]?.*$/gm;
  const heads: { version: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) heads.push({ version: m[1], start: m.index, end: m.index + m[0].length });
  for (let i = 0; i < heads.length && out.length < max; i++) {
    out.push({ version: heads[i].version, body: md.slice(heads[i].end, heads[i + 1]?.start ?? md.length).trim() });
  }
  return out;
}

export function parseFeed(xml: string, max = 8): { id: string; title: string; url: string; date?: string; body: string }[] {
  const items: { id: string; title: string; url: string; date?: string; body: string }[] = [];
  const pick = (block: string, tag: string) => {
    const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)?.[1] ?? '';
    return r.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  };
  for (const block of xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) ?? []) {
    const link = pick(block, 'link') || /<link[^>]*href="([^"]+)"/i.exec(block)?.[1] || '';
    const title = htmlToText(pick(block, 'title'));
    items.push({
      id: pick(block, 'guid') || pick(block, 'id') || link || title,
      title,
      url: link,
      date: pick(block, 'pubDate') || pick(block, 'updated') || pick(block, 'published') || undefined,
      body: htmlToText(pick(block, 'description') || pick(block, 'content') || pick(block, 'summary')).slice(0, 4000),
    });
    if (items.length >= max) break;
  }
  return items;
}

export async function fetchSource(src: IntelSource, f: Fetch = fetch): Promise<IntelItem[]> {
  const base = { sourceId: src.id, sourceName: src.name };
  const timeout = AbortSignal.timeout(30_000);
  if (src.kind === 'github-releases') {
    const res = await f(`https://api.github.com/repos/${src.target}/releases?per_page=6`, { headers: ghHeaders(), signal: timeout });
    if (!res.ok) throw new Error(`GitHub ${res.status} for ${src.target}`);
    const data = (await res.json()) as any[];
    return data
      .filter((r) => !r.draft)
      .map((r) => ({
        ...base,
        id: String(r.tag_name),
        title: `${src.name} ${r.name || r.tag_name}${r.prerelease ? ' (pre-release)' : ''}`,
        url: r.html_url,
        publishedAt: r.published_at,
        body: String(r.body ?? '').slice(0, 6000),
      }));
  }
  if (src.kind === 'github-changelog') {
    // The contents API works where raw.githubusercontent.com is blocked; raw is the fallback.
    const file = src.path ?? 'CHANGELOG.md';
    let text: string | undefined;
    try {
      const api = await f(`https://api.github.com/repos/${src.target}/contents/${file}`, {
        headers: { ...ghHeaders(), accept: 'application/vnd.github.raw' },
        signal: timeout,
      });
      if (api.ok) text = await api.text();
    } catch {
      // fall through to raw
    }
    if (text === undefined) {
      const res = await f(`https://raw.githubusercontent.com/${src.target}/HEAD/${file}`, { signal: timeout });
      if (!res.ok) throw new Error(`Changelog ${res.status} for ${src.target}`);
      text = await res.text();
    }
    return parseChangelog(text).map((s) => ({
      ...base,
      id: s.version,
      title: `${src.name} ${s.version}`,
      url: `https://github.com/${src.target}/blob/HEAD/${src.path ?? 'CHANGELOG.md'}`,
      body: s.body.slice(0, 6000),
    }));
  }
  const res = await f(src.target, { headers: { 'user-agent': 'Mozilla/5.0 sun-harness-intel' }, signal: timeout });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${src.target}`);
  const text = await res.text();
  if (src.kind === 'rss') return parseFeed(text).map((i) => ({ ...base, id: i.id, title: i.title, url: i.url, publishedAt: i.date, body: i.body }));
  const plain = htmlToText(text).slice(0, 12_000);
  return [
    {
      ...base,
      id: createHash('sha256').update(plain).digest('hex').slice(0, 16),
      title: `${src.name} (page snapshot)`,
      url: src.target,
      publishedAt: new Date().toISOString(),
      body: plain.slice(0, 6000),
    },
  ];
}

interface IntelState {
  seen: Record<string, string[]>;
  lastRun?: string;
}

function stateFile(): string {
  return homePath('intel', 'state.json');
}

export function loadIntelState(): IntelState {
  if (!existsSync(stateFile())) return { seen: {} };
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {
    return { seen: {} };
  }
}

const ANALYSIS_SYSTEM = `You are a research analyst tracking AI coding harnesses and agent tools (Claude Code, Codex, Gemini CLI, OpenCode, DeepSeek Harness, Cline, Aider, Goose, Qwen Code, OpenHands, Hermes, Cursor, MCP).
You write a daily briefing for the owner of "sun-harness", a personal harness (desktop + CLI) with: append-only session log, multi-provider models, tools, approvals, skills, MCP, plugins, hooks, knowledge base, memory, modes (coding/agent/assistant), quota pause/resume, daily intel, and self-evolution.

Write the report in English Markdown with these sections:
# Harness Intel — <date>
## TL;DR  (3-6 bullets: the most important changes)
## Changes by harness  (for each harness with news: ### Name version — then bullets: **What changed**, **Mechanism / principle** (how it likely works underneath and why it works), **Why it matters**)
## Trends  (cross-cutting patterns, with evidence)
## Ideas for sun-harness  (numbered; each: idea, which principle it applies, priority P1-P3, effort S/M/L)
Be concrete and skeptical; do not invent features that are not in the source notes. Cite versions.
At the very end output a fenced json block: [{"title":"...","content":"...","rationale":"...","priority":"P1|P2|P3"}] with the ideas.`;

function rawListing(items: IntelItem[]): string {
  return items
    .map((i) => `### ${i.title}\n- Source: ${i.url}${i.publishedAt ? `\n- Published: ${i.publishedAt}` : ''}\n\n${i.body.slice(0, 1500)}`)
    .join('\n\n');
}

const MAX_IDEAS_PER_RUN = 8;

/** Turn the report's trailing JSON ideas into evolution proposals (highest priority first) and strip the block from the report. */
export function fileIdeas(raw: string, date: string): { report: string; proposals: number } {
  const at = raw.lastIndexOf('```json');
  if (at < 0) return { report: raw, proposals: 0 };
  const ideas = extractJson<{ title: string; content: string; rationale?: string; priority?: string }[]>(raw.slice(at));
  const rank = (p?: string) => ({ P1: 1, P2: 2, P3: 3 })[p as 'P1'] ?? 4;
  const picked = (Array.isArray(ideas) ? ideas : [])
    .filter((i) => i?.title)
    .sort((a, b) => rank(a.priority) - rank(b.priority))
    .slice(0, MAX_IDEAS_PER_RUN);
  for (const idea of picked) {
    addProposal({
      type: 'feature',
      title: idea.title,
      content: `${idea.content ?? ''}${idea.priority ? `\n\nPriority: ${idea.priority}` : ''}`,
      rationale: idea.rationale ?? 'From daily harness intel.',
      source: { kind: 'intel', ref: date },
    });
  }
  return { report: raw.slice(0, at).trimEnd() + '\n', proposals: picked.length };
}

export interface IntelOptions {
  sources: IntelSource[];
  complete?: Complete;
  fetchImpl?: Fetch;
  /** On first sight of a source, only keep items newer than this many days. */
  firstRunDays?: number;
  now?: Date;
  /** Re-analyze even if nothing is new (uses latest items per source). */
  force?: boolean;
}

export async function runIntel(opts: IntelOptions): Promise<IntelRunResult> {
  const now = opts.now ?? new Date();
  const date = localDate(now);
  const state = loadIntelState();
  const errors: IntelRunResult['errors'] = [];
  const fresh: IntelItem[] = [];
  const cutoff = now.getTime() - (opts.firstRunDays ?? 21) * 86_400_000;

  const results = await Promise.all(
    opts.sources.map(async (s) => {
      try {
        return { s, items: await fetchSource(s, opts.fetchImpl) };
      } catch (e) {
        errors.push({ source: s.id, error: (e as Error).message });
        return { s, items: [] as IntelItem[] };
      }
    }),
  );
  for (const { s, items } of results) {
    const seen = new Set(state.seen[s.id] ?? []);
    const firstSight = !state.seen[s.id];
    let news = items.filter((i) => !seen.has(i.id));
    if (firstSight) news = news.filter((i) => !i.publishedAt || Date.parse(i.publishedAt) >= cutoff).slice(0, 3);
    if (opts.force && !news.length) news = items.slice(0, 1);
    fresh.push(...news);
    if (items.length) state.seen[s.id] = [...new Set([...(state.seen[s.id] ?? []), ...items.map((i) => i.id)])].slice(-200);
  }

  ensureDir(homePath('intel', 'raw'));
  ensureDir(homePath('intel', 'reports'));
  writeFileSync(homePath('intel', 'raw', `${date}.json`), JSON.stringify({ date, items: fresh, errors }, null, 2));

  let report = '';
  let analyzed = false;
  let analysisError: string | undefined;
  let proposals = 0;
  if (!fresh.length) {
    report = `# Harness Intel — ${date}\n\nNo new releases or changelog entries since the last run.\n`;
  } else if (opts.complete) {
    try {
      const notes = fresh.map((i) => `=== ${i.title}\nURL: ${i.url}\nDate: ${i.publishedAt ?? 'n/a'}\n${i.body.slice(0, 3500)}`).join('\n\n');
      const raw = await opts.complete(ANALYSIS_SYSTEM, `Date: ${date}\n\nSource notes (${fresh.length} items):\n\n${notes.slice(0, 120_000)}`);
      analyzed = true;
      ({ report, proposals } = fileIdeas(raw, date));
    } catch (e) {
      analysisError = (e as Error).message;
    }
  }
  if (fresh.length && !analyzed) {
    report = `# Harness Intel — ${date}\n\n> Analysis pending${analysisError ? `: ${analysisError.slice(0, 300)}` : ''}. Run \`sun intel analyze ${date}\` after the model quota is restored or the model is changed.\n\n## Raw items\n\n${rawListing(fresh)}\n`;
  }
  if (errors.length) report += `\n\n## Fetch errors\n\n${errors.map((e) => `- ${e.source}: ${e.error}`).join('\n')}\n`;

  const reportPath = intelReportFile(date);
  const htmlPath = homePath('intel', 'reports', `${date}.html`);
  writeFileSync(reportPath, report);
  writeFileSync(htmlPath, htmlPage(`Harness Intel ${date}`, markdownToHtml(report)));
  state.lastRun = now.toISOString();
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
  return { date, items: fresh, errors, reportPath, htmlPath, analyzed, analysisError, proposals };
}

/** Re-run analysis for a day whose raw items were saved but not analyzed (e.g. quota ran out). */
export async function analyzeIntelDay(date: string, complete: Complete): Promise<IntelRunResult> {
  const reportPath = intelReportFile(date);
  const raw = JSON.parse(readFileSync(homePath('intel', 'raw', `${date}.json`), 'utf8')) as { items: IntelItem[]; errors: IntelRunResult['errors'] };
  const items = raw.items;
  const notes = items.map((i) => `=== ${i.title}\nURL: ${i.url}\nDate: ${i.publishedAt ?? 'n/a'}\n${i.body.slice(0, 3500)}`).join('\n\n');
  const answer = items.length ? await complete(ANALYSIS_SYSTEM, `Date: ${date}\n\nSource notes (${items.length} items):\n\n${notes.slice(0, 120_000)}`) : `# Harness Intel — ${date}\n\nNo items.\n`;
  const { report, proposals } = fileIdeas(answer, date);
  const htmlPath = homePath('intel', 'reports', `${date}.html`);
  writeFileSync(reportPath, report);
  writeFileSync(htmlPath, htmlPage(`Harness Intel ${date}`, markdownToHtml(report)));
  return { date, items, errors: raw.errors ?? [], reportPath, htmlPath, analyzed: true, proposals };
}

export function listIntelReports(): { date: string; path: string; html: string; pending: boolean }[] {
  const d = ensureDir(homePath('intel', 'reports'));
  return readdirSync(d, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && isCalendarDate(entry.name.slice(0, -3)))
    .map(({ name: f }) => {
      const p = join(d, f);
      return { date: f.slice(0, -3), path: p, html: p.replace(/\.md$/, '.html'), pending: readFileSync(p, 'utf8').includes('> Analysis pending') };
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function intelReportFile(date: string): string {
  return homePath('intel', 'reports', `${requireCalendarDate(date)}.md`);
}

export function readIntelReport(date: string): string {
  return readFileSync(intelReportFile(date), 'utf8');
}

/**
 * macOS LaunchAgent that runs `sun intel run` daily. Node runs directly (no shell); the CLI imports
 * credential env vars itself (see env.ts), so no secrets are copied into the plist.
 */
export function launchdPlist(opts: { nodePath: string; cliPath: string; hour: number; minute: number; label?: string; path?: string }): { label: string; xml: string } {
  const label = opts.label ?? 'com.sun-harness.intel';
  const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const PATH = opts.path ?? `${dirname(opts.nodePath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(opts.nodePath)}</string>
    <string>${x(opts.cliPath)}</string>
    <string>intel</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${x(PATH)}</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>${opts.hour}</integer><key>Minute</key><integer>${opts.minute}</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>${homePath('intel', 'launchd.log')}</string>
  <key>StandardErrorPath</key><string>${homePath('intel', 'launchd.log')}</string>
</dict>
</plist>
`;
  return { label, xml };
}
