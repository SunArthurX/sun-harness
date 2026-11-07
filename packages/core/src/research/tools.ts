import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tool } from '../tools/types.js';
import { formatCell, type PythonKernel } from './python.js';
import { extractReadable } from './readable.js';
import { searchAvailable, webSearch, type SearchConfig } from './search.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 sun-harness';
const PAGE = 30_000;

/** PDF bytes → text with poppler's pdftotext (layout preserved); undefined when pdftotext is missing. */
export function pdfToText(bytes: Uint8Array): string | undefined {
  const dir = mkdtempSync(join(tmpdir(), 'sun-pdf-'));
  try {
    const f = join(dir, 'doc.pdf');
    writeFileSync(f, bytes);
    const r = spawnSync('pdftotext', ['-layout', '-enc', 'UTF-8', f, '-'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
    if (r.error || r.status !== 0) return undefined;
    return r.stdout.replace(/\f/g, '\n\n--- page ---\n\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function page(text: string, start: number): string {
  const chunk = text.slice(start, start + PAGE);
  const rest = text.length - (start + chunk.length);
  return rest > 0 ? `${chunk}\n\n… ${rest} more characters: call web_fetch again with start=${start + chunk.length}.` : chunk;
}

export function createResearchTools(o: { search: () => SearchConfig; kernel: (sessionId: string, cwd: string) => PythonKernel }): Tool[] {
  const webFetch: Tool = {
    name: 'web_fetch',
    description:
      'Fetch a URL and return its main content as Markdown (boilerplate removed; PDFs converted to text; JSON and plain text as is). Long documents are paged: pass start to continue. Use browser_navigate for pages that need JavaScript or a login.',
    parameters: { type: 'object', properties: { url: { type: 'string' }, start: { type: 'number' }, raw: { type: 'boolean', description: 'return the HTML source instead' } }, required: ['url'] },
    risk: 'network',
    source: 'builtin',
    untrusted: true,
    async execute(args, ctx) {
      const url = String(args.url);
      const res = await fetch(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(45_000)]), headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/pdf,application/json;q=0.9,*/*;q=0.8' }, redirect: 'follow' });
      const type = res.headers.get('content-type') ?? '';
      const head = `[${res.status} ${type.split(';')[0]}] ${res.url !== url ? `(redirected to ${res.url}) ` : ''}`;
      if (/pdf/i.test(type) || /\.pdf($|\?)/i.test(res.url)) {
        const text = pdfToText(new Uint8Array(await res.arrayBuffer()));
        if (text === undefined) return `${head}\nThis is a PDF and pdftotext is not installed (brew install poppler / apt install poppler-utils).`;
        return `${head}PDF, ${text.length} characters\n\n${page(text, Number(args.start) || 0)}`;
      }
      const body = await res.text();
      if (!/html/i.test(type) || args.raw) return `${head}\n${page(body, Number(args.start) || 0)}`;
      const r = extractReadable(body, res.url);
      const text = `${r.title ? `# ${r.title}\n\n` : ''}${r.description ? `> ${r.description}\n\n` : ''}${r.text}`;
      return `${head}\n${page(text, Number(args.start) || 0)}`;
    },
  };

  const search: Tool = {
    name: 'web_search',
    description: 'Search the web. Returns titles, URLs and snippets; follow up with web_fetch on the best sources. Run several focused queries rather than one broad one.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
    risk: 'network',
    source: 'builtin',
    untrusted: true,
    available: () => searchAvailable(o.search()),
    async execute(args, ctx) {
      const { provider, results } = await webSearch(String(args.query), o.search(), { limit: Math.min(Number(args.limit) || 8, 20), signal: ctx.signal });
      if (!results.length) return `No results from ${provider}. Rephrase the query, or web_fetch a known URL.`;
      return `[${provider}]\n` + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
    },
  };

  const python: Tool = {
    name: 'python',
    description:
      'Run Python in a persistent session (variables and imports survive between calls, like a notebook). The value of the last expression is shown. matplotlib figures are saved to figures/*.png in the workspace. Use for data analysis, calculations, charts, and file conversion. restart: true clears the state.',
    parameters: { type: 'object', properties: { code: { type: 'string' }, restart: { type: 'boolean' }, timeout_ms: { type: 'number' } }, required: ['code'] },
    risk: 'exec',
    source: 'builtin',
    available: async () => spawnSync('python3', ['--version']).status === 0,
    async execute(args, ctx) {
      const k = o.kernel(ctx.sessionId, ctx.cwd);
      if (args.restart) k.restart();
      const r = await k.run(String(args.code ?? ''), Math.min(Number(args.timeout_ms) || 120_000, 30 * 60_000), ctx.signal);
      return formatCell(r);
    },
  };

  return [webFetch, search, python];
}
