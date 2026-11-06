import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { glob as fsGlob } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolveIn } from '../policy.js';
import type { TodoItem } from '../types.js';
import { truncate, type Tool } from './types.js';

const IGNORED = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'coverage', '.venv', '__pycache__']);

const readFile: Tool = {
  name: 'read_file',
  description: 'Read a text file. Returns lines prefixed with line numbers. Use offset/limit (1-based lines) for large files.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the workspace or absolute.' },
      offset: { type: 'number', description: 'First line to read (1-based).' },
      limit: { type: 'number', description: 'Max lines to read (default 2000).' },
    },
    required: ['path'],
  },
  risk: 'read',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path);
    const lines = readFileSync(p, 'utf8').split('\n');
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}|${l}`).join('\n');
    const more = start - 1 + limit < lines.length ? `\n[${lines.length - (start - 1 + limit)} more lines]` : '';
    return truncate(body + more) || '(empty file)';
  },
};

const writeFile: Tool = {
  name: 'write_file',
  description: 'Create or overwrite a file with the given content. Parent directories are created.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
  },
  risk: 'write',
  pathArg: 'path',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path);
    mkdirSync(dirname(p), { recursive: true });
    const existed = existsSync(p);
    writeFileSync(p, String(args.content ?? ''));
    return `${existed ? 'Overwrote' : 'Created'} ${relative(ctx.cwd, p) || p} (${String(args.content ?? '').split('\n').length} lines)`;
  },
};

const editFile: Tool = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. old_string must match exactly once unless replace_all is true. Read the file first to get the exact text.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  risk: 'write',
  pathArg: 'path',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path);
    const text = readFileSync(p, 'utf8');
    const oldS = String(args.old_string);
    if (!oldS) throw new Error('old_string must not be empty; use write_file to create files.');
    const count = text.split(oldS).length - 1;
    if (count === 0) throw new Error('old_string not found in file. Re-read the file and copy the exact text.');
    if (count > 1 && !args.replace_all) throw new Error(`old_string matches ${count} times; add more context or set replace_all.`);
    const next = args.replace_all ? text.split(oldS).join(String(args.new_string)) : text.replace(oldS, () => String(args.new_string));
    writeFileSync(p, next);
    return `Edited ${relative(ctx.cwd, p) || p} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`;
  },
};

const listDir: Tool = {
  name: 'list_dir',
  description: 'List entries of a directory (directories end with /).',
  parameters: { type: 'object', properties: { path: { type: 'string', description: 'Defaults to the workspace root.' } } },
  risk: 'read',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path || '.');
    const entries = readdirSync(p, { withFileTypes: true })
      .filter((e) => !IGNORED.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return entries.join('\n') || '(empty directory)';
  },
};

const globTool: Tool = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "src/**/*.ts"). Ignores node_modules, .git, dist.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] },
  risk: 'read',
  source: 'builtin',
  async execute(args, ctx) {
    const root = resolveIn(ctx.cwd, args.path || '.');
    const out: string[] = [];
    for await (const f of fsGlob(String(args.pattern), {
      cwd: root,
      exclude: (name: any) => IGNORED.has(typeof name === 'string' ? name : name.name),
    })) {
      out.push(String(f));
      if (out.length >= 500) break;
    }
    return out.sort().join('\n') || 'No files matched.';
  },
};

let hasRg: boolean | undefined;

const grep: Tool = {
  name: 'grep',
  description: 'Search file contents with a regular expression. Returns file:line:text matches.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string', description: 'Filter files, e.g. "*.ts".' },
      ignore_case: { type: 'boolean' },
    },
    required: ['pattern'],
  },
  risk: 'read',
  source: 'builtin',
  async execute(args, ctx) {
    const root = resolveIn(ctx.cwd, args.path || '.');
    if (hasRg === undefined) hasRg = spawnSync('rg', ['--version']).status === 0;
    if (hasRg) {
      const a = ['-n', '--no-heading', '--max-count', '50', '-M', '300'];
      if (args.ignore_case) a.push('-i');
      if (args.glob) a.push('--glob', args.glob);
      a.push('-e', args.pattern, root);
      const r = spawnSync('rg', a, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
      const text = (r.stdout || '').split(root + '/').join('');
      return truncate(text.trim()) || 'No matches.';
    }
    const re = new RegExp(args.pattern, args.ignore_case ? 'i' : '');
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (IGNORED.has(e.name) || out.length > 500) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (statSync(full).size < 2_000_000) {
          readFileSync(full, 'utf8')
            .split('\n')
            .forEach((l, i) => re.test(l) && out.push(`${relative(root, full)}:${i + 1}:${l.slice(0, 300)}`));
        }
      }
    };
    statSync(root).isDirectory() ? walk(root) : walk(dirname(root));
    return truncate(out.join('\n')) || 'No matches.';
  },
};

const bash: Tool = {
  name: 'bash',
  description:
    'Run a shell command in the workspace (bash -c). Returns combined stdout/stderr and exit code. Avoid interactive commands. Default timeout 120s.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_ms: { type: 'number' } },
    required: ['command'],
  },
  risk: 'exec',
  source: 'builtin',
  execute(args, ctx) {
    return new Promise((resolvePromise) => {
      const child = spawn('bash', ['-c', String(args.command)], { cwd: ctx.cwd, env: { ...process.env, PAGER: 'cat' } });
      let out = '';
      const onData = (d: Buffer) => {
        if (out.length < 2_000_000) out += d.toString();
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const timeout = Math.min(Number(args.timeout_ms) || 120_000, 30 * 60_000);
      const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
      const onAbort = () => child.kill('SIGKILL');
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code, sig) => {
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);
        const status = sig ? `killed (${sig}${sig === 'SIGKILL' ? ', timeout or abort' : ''})` : `exit code ${code}`;
        resolvePromise(`${truncate(out.trimEnd()) || '(no output)'}\n[${status}]`);
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolvePromise(`Failed to start: ${e.message}`);
      });
    });
  },
};

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

const webFetch: Tool = {
  name: 'web_fetch',
  description: 'Fetch a URL and return readable text (HTML is converted to text). Use for docs, articles, APIs.',
  parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  risk: 'network',
  source: 'builtin',
  async execute(args, ctx) {
    const res = await fetch(String(args.url), {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
      headers: { 'user-agent': 'sun-harness/0.1 (+https://github.com)' },
    });
    const type = res.headers.get('content-type') || '';
    const body = await res.text();
    const text = type.includes('html') ? htmlToText(body) : body;
    return truncate(`[${res.status} ${type}]\n${text}`, 50_000);
  },
};

const webSearch: Tool = {
  name: 'web_search',
  description: 'Search the web (DuckDuckGo). Returns titles, URLs and snippets. Follow up with web_fetch.',
  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  risk: 'network',
  source: 'builtin',
  async execute(args, ctx) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(String(args.query))}`, {
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]),
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh) sun-harness/0.1' },
    });
    const html = await res.text();
    const results: string[] = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) && results.length < 10) {
      let url = m[1];
      const uddg = /uddg=([^&]+)/.exec(url);
      if (uddg) url = decodeURIComponent(uddg[1]);
      results.push(`- ${htmlToText(m[2])}\n  ${url}\n  ${htmlToText(m[3])}`);
    }
    return results.join('\n') || 'No results (search endpoint may be rate limited; try web_fetch on a known URL).';
  },
};

const todoWrite: Tool = {
  name: 'todo_write',
  description:
    'Maintain the task plan for this session. Send the full list each time. Use for multi-step work; keep exactly one item in_progress.',
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'done', 'cancelled'] },
          },
          required: ['id', 'content', 'status'],
        },
      },
    },
    required: ['items'],
  },
  risk: 'read',
  source: 'builtin',
  async execute(args, ctx) {
    const items = (args.items ?? []) as TodoItem[];
    ctx.services.setTodos?.(items);
    return items.map((i) => `[${i.status === 'done' ? 'x' : i.status === 'in_progress' ? '~' : ' '}] ${i.content}`).join('\n') || 'Plan cleared.';
  },
};

export const BUILTIN_TOOLS: Tool[] = [readFile, writeFile, editFile, listDir, globTool, grep, bash, webFetch, webSearch, todoWrite];
