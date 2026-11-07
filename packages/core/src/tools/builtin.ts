import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { glob as fsGlob } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { resolveIn } from '../policy.js';
import type { TodoItem } from '../types.js';
import { truncate, type Tool } from './types.js';
import { applyPatchTool, editFileTool, writeFileTool } from './edit.js';

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
    const full = readFileSync(p, 'utf8');
    ctx.services.fileState?.note(p, full);
    const lines = full.split('\n');
    const start = Math.max(1, Number(args.offset) || 1);
    const limit = Math.max(1, Number(args.limit) || 2000);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const body = slice.map((l, i) => `${String(start + i).padStart(6)}|${l}`).join('\n');
    const more = start - 1 + limit < lines.length ? `\n[${lines.length - (start - 1 + limit)} more lines]` : '';
    return truncate(body + more) || '(empty file)';
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
    'Run a shell command in the workspace (bash -c). Returns combined stdout/stderr and exit code. Avoid interactive commands. Default timeout 120s. Set background: true for long tasks (test suites, builds, dev servers): it returns a job id immediately and the result is delivered to you when the job ends.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string' }, timeout_ms: { type: 'number' }, background: { type: 'boolean' } },
    required: ['command'],
  },
  risk: 'exec',
  source: 'builtin',
  execute(args, ctx) {
    if (args.background && ctx.services.startJob) return Promise.resolve(ctx.services.startJob(String(args.command), ctx.cwd));
    return new Promise((resolvePromise) => {
      const sb = ctx.services.sandbox;
      const command = sb ? sb.shell(String(args.command), ctx.cwd) : String(args.command);
      const child = spawn('bash', ['-c', command], { cwd: ctx.cwd, env: sb ? sb.env(process.env) : { ...process.env, PAGER: 'cat' } });
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

/** web_fetch and web_search are configured per host (search provider, readability, PDF): see research/tools.ts. */
export const BUILTIN_TOOLS: Tool[] = [readFile, writeFileTool, editFileTool, applyPatchTool, listDir, globTool, grep, bash, todoWrite];
