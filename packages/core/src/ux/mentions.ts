import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { resolveIn } from '../policy.js';

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
export function expandMentions(text: string, cwd: string): MentionResult {
  const files: string[] = [];
  const images: string[] = [];
  const blocks: string[] = [];
  for (const m of text.matchAll(/(?:^|\s)@((?:[\w.~-]+\/)*[\w.~-]+\/?)/g)) {
    const rel = m[1];
    const abs = resolveIn(cwd, rel);
    if (!existsSync(abs) || relative(cwd, abs).startsWith('..') || files.includes(abs) || images.includes(abs)) continue;
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
  return { text: blocks.length ? `${text}\n\n${blocks.join('\n\n')}` : text, images, files };
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
