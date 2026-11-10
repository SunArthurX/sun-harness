import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { resolveIn } from '../policy.js';
import { findProjectRoot, loadProjectContext } from '../rules.js';
import { searchCodebase } from './codebase.js';
import { isIgnored } from './ignore.js';

const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const MAX_FILE = 200_000;

export function imageMime(path: string): string | undefined {
  return IMAGE_MIME[extname(path).toLowerCase()];
}

export interface MentionResult {
  /** The message with attached file contents appended. */
  text: string;
  /** Mentioned image files, attached as images instead of text. */
  images: string[];
  files: string[];
}

/**
 * Cursor/Claude Code-style @mentions: `@src/app.ts` attaches the file, `@src/` a listing, `@shot.png` the image.
 * Only tokens that resolve to an existing path inside cwd count; emails and @handles are left alone.
 */
function gitContext(cwd: string): string {
  const status = spawnSync('git', ['status', '-sb'], { cwd, encoding: 'utf8' });
  if (status.status !== 0) return '<attached git>(not a git repository)</attached>';
  const diff = spawnSync('git', ['diff', '--stat'], { cwd, encoding: 'utf8' });
  const body = [status.stdout.trim(), diff.stdout.trim()].filter(Boolean).join('\n').slice(0, 8000);
  return `<attached git>\n${body || '(clean)'}\n</attached>`;
}

function ruleContext(cwd: string, name: string): string {
  const ctx = loadProjectContext(cwd);
  const all = [...ctx.fileRules, ...ctx.manualRules, ...ctx.rules.map((r) => ({ source: r.source, text: r.text, globs: undefined as string | undefined }))];
  const hit = all.find((r) => basename(r.source).replace(/\.(mdc|md)$/, '') === name || r.source.endsWith(`/${name}`) || r.source.endsWith(`/${name}.md`) || r.source.endsWith(`/${name}.mdc`));
  return hit ? `<attached rule="${hit.source}">\n${hit.text}\n</attached>` : `<attached rule="${name}">(no rule named ${name})</attached>`;
}

function codebaseContext(cwd: string, query: string): string {
  const q = query.trim();
  if (!q) return '<attached codebase>(write a query after @codebase)</attached>';
  const hits = searchCodebase(cwd, q, 6);
  if (!hits.length) return `<attached codebase query="${q}">(no matches)</attached>`;
  return `<attached codebase query="${q}">\n${hits.map((h) => `${h.path}:${h.line}\n${h.text}`).join('\n---\n')}\n</attached>`;
}

/**
 * Cursor-style mentions that are not files: `@git`, `@codebase <query>`, `@rule <name>`.
 * Returns the text with those tokens removed and the attached blocks.
 */
export function expandCursorMentions(text: string, cwd: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const next = text.replace(/(^|\s)@(git)\b|(^|\s)@(rule)\s+([\w.-]+)|(^|\s)@(codebase)\s+([^\n]+)/g, (full, _a, git, _b, rule, ruleName, _c, codebase, query) => {
    const lead = full.match(/^\s*/)?.[0] ?? '';
    if (git) blocks.push(gitContext(cwd));
    else if (rule) blocks.push(ruleContext(cwd, ruleName));
    else if (codebase) blocks.push(codebaseContext(cwd, query));
    return lead;
  });
  return { text: next, blocks };
}

export function expandMentions(text: string, cwd: string): MentionResult {
  const special = expandCursorMentions(text, cwd);
  const files: string[] = [];
  const images: string[] = [];
  const blocks: string[] = [...special.blocks];
  const root = findProjectRoot(cwd);
  for (const m of special.text.matchAll(/(?:^|\s)@((?:[\w.~-]+\/)*[\w.~-]+\/?)/g)) {
    // Sentence punctuation right after a path ("see @src/a.ts.") is not part of it.
    let rel = m[1];
    if (!existsSync(resolveIn(cwd, rel))) rel = rel.replace(/[.,;:!?]+$/, '');
    const abs = resolveIn(cwd, rel);
    if (!existsSync(abs) || relative(cwd, abs).startsWith('..') || files.includes(abs) || images.includes(abs)) continue;
    if (isIgnored(root, abs)) {
      blocks.push(`<attached file="${rel}">(ignored by .cursorignore or .sunignore)</attached>`);
      files.push(abs);
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      const list = readdirSync(abs, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
        .slice(0, 200)
        .map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
      blocks.push(`<attached dir="${rel}">\n${list.join('\n')}\n</attached>`);
      files.push(abs);
    } else if (imageMime(abs)) {
      images.push(abs);
    } else if (st.size <= MAX_FILE) {
      const body = readFileSync(abs, 'utf8');
      if (body.includes('\u0000')) continue;
      blocks.push(`<attached file="${rel}">\n${body}\n</attached>`);
      files.push(abs);
    } else {
      blocks.push(`<attached file="${rel}">(${Math.round(st.size / 1000)} kB — too large to attach; read the parts you need with read_file)</attached>`);
      files.push(abs);
    }
  }
  return { text: blocks.length ? `${special.text.trimEnd()}\n\n${blocks.join('\n\n')}` : special.text, images, files };
}

/** Path completion for the composer: tracked files (git) or a bounded walk, filtered by a fuzzy prefix. */
export function completePaths(cwd: string, query: string, limit = 20): string[] {
  let all: string[] = [];
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (git.status === 0) all = git.stdout.split('\n').filter(Boolean);
  else {
    const walk = (d: string, depth: number) => {
      if (depth > 6 || all.length > 5000) return;
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p, depth + 1);
        else all.push(relative(cwd, p));
      }
    };
    try {
      walk(cwd, 0);
    } catch {
      // unreadable
    }
  }
  const dirs = new Set<string>();
  for (const f of all) {
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/') + '/');
  }
  const q = query.toLowerCase();
  const score = (p: string) => {
    const l = p.toLowerCase();
    if (l.startsWith(q)) return 0;
    const base = l.split('/').filter(Boolean).pop() ?? l;
    if (base.startsWith(q)) return 1;
    if (l.includes(q)) return 2;
    // subsequence match ("srcapp" → src/app.ts)
    let i = 0;
    for (const ch of l) if (ch === q[i]) i++;
    return i === q.length ? 3 : 9;
  };
  return [...dirs, ...all]
    .map((p) => ({ p, s: score(p) }))
    .filter((x) => x.s < 9)
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length)
    .slice(0, limit)
    .map((x) => x.p);
}
