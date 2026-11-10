import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

/** `.cursorignore` and `.sunignore` (gitignore-like). The agent must not read matching paths. */
const FILES = ['.cursorignore', '.sunignore'];

function compileGlob(pattern: string): RegExp {
  let src = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') {
        src += '(?:.*/)?';
        i += 2;
      } else {
        src += '.*';
        i += 1;
      }
    } else if (c === '*') src += '[^/]*';
    else if (c === '?') src += '[^/]';
    else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${src}$`);
}

/** A pattern with no slash matches in any directory. A trailing slash matches that directory tree. */
function normalizeIgnore(pattern: string): string {
  const p = pattern.replace(/^\.\//, '');
  const dir = p.endsWith('/') ? `${p}**` : p;
  return dir.includes('/') ? dir : `**/${dir}`;
}

export function pathIgnored(patterns: readonly string[], rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  const candidates = norm.split('/').map((_, i, a) => a.slice(0, i + 1).join('/'));
  let ignored = false;
  for (const raw of patterns) {
    const neg = raw.startsWith('!');
    const body = (neg ? raw.slice(1) : raw).trim();
    if (!body || body.startsWith('#')) continue;
    const re = compileGlob(normalizeIgnore(body));
    if (candidates.some((c) => re.test(c))) ignored = !neg;
  }
  return ignored;
}

export function ignorePatterns(root: string): string[] {
  const out: string[] = [];
  for (const name of FILES) {
    const p = resolve(root, name);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith('#')) out.push(t);
    }
  }
  return out;
}

/** True when `abs` is inside `root` and matches an ignore file. Paths outside the project are not ignored. */
export function isIgnored(root: string, abs: string): boolean {
  const rel = relative(resolve(root), resolve(abs)).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return false;
  return pathIgnored(ignorePatterns(root), rel);
}

/**
 * Cursor rule globs (not gitignore): `*.ts` is the project root only; `**\/*.ts` is every directory.
 * Several patterns are comma-separated.
 */
export function ruleGlobsMatch(globs: string, rel: string): boolean {
  const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return globs.split(',').some((raw) => {
    const p = raw.trim().replace(/^\.\//, '');
    if (!p) return false;
    if (!p.includes('/')) return !norm.includes('/') && compileGlob(p).test(norm);
    return compileGlob(p.endsWith('/') ? `${p}**` : p).test(norm);
  });
}
