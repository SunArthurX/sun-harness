import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { resolveIn } from '../policy.js';
import { diagnosticsNote } from '../diagnostics.js';
import { unifiedDiff } from '../ux/diff.js';
import type { Tool, ToolContext } from './types.js';

// ---------------- tolerant search/replace ----------------

export interface ReplaceResult {
  text: string;
  /** How the match was found: exact, after newline normalization, or ignoring whitespace. */
  how: 'exact' | 'newlines' | 'whitespace';
  count: number;
}

const leading = (l: string) => /^[ \t]*/.exec(l)![0];

/** Re-indent `lines` so their first non-empty line starts with `target` instead of `source`. */
function reindent(lines: string[], source: string, target: string): string[] {
  if (source === target) return lines;
  return lines.map((l) => {
    if (!l.trim()) return l;
    if (target.startsWith(source)) return target.slice(source.length) + l;
    if (source.startsWith(target) && l.startsWith(source.slice(target.length))) return l.slice(source.length - target.length);
    return l;
  });
}

/** Line windows of `file` equal to `old` when both are compared line-by-line with whitespace trimmed. */
function whitespaceWindows(fileLines: string[], oldLines: string[]): number[] {
  const want = oldLines.map((l) => l.trim());
  const out: number[] = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (fileLines[i + j].trim() !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function trimBlankEdges(lines: string[]): string[] {
  let a = 0;
  let b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/** Best-effort "closest region" for an error message: the window with the most whitespace-equal lines. */
export function closestRegion(text: string, old: string): string {
  const fileLines = text.split('\n');
  const oldLines = trimBlankEdges(old.replace(/\r\n/g, '\n').split('\n'));
  if (!oldLines.length) return '';
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < fileLines.length; i++) {
    let score = 0;
    for (let j = 0; j < oldLines.length && i + j < fileLines.length; j++) if (fileLines[i + j].trim() === oldLines[j].trim()) score++;
    if (score > bestScore) (bestScore = score), (best = i);
  }
  if (best < 0) return '';
  const from = Math.max(0, best - 2);
  const to = Math.min(fileLines.length, best + oldLines.length + 2);
  return `Closest region (lines ${from + 1}-${to}, ${bestScore}/${oldLines.length} lines match):\n` + fileLines.slice(from, to).map((l, k) => `${String(from + k + 1).padStart(6)}|${l}`).join('\n');
}

/**
 * Replace `oldS` with `newS`: exact match first, then with CRLF normalized, then ignoring indentation and
 * trailing whitespace line-by-line (the replacement is re-indented to the file's indentation).
 */
export function tolerantReplace(text: string, oldS: string, newS: string, replaceAll = false): ReplaceResult {
  if (!oldS) throw new Error('old_string must not be empty; use write_file to create files.');
  const exact = text.split(oldS).length - 1;
  if (exact === 1 || (exact > 1 && replaceAll)) {
    return { text: replaceAll ? text.split(oldS).join(newS) : text.replace(oldS, () => newS), how: 'exact', count: replaceAll ? exact : 1 };
  }
  if (exact > 1) throw new Error(`old_string matches ${exact} times; add surrounding lines to make it unique, or set replace_all.`);

  const crlf = text.includes('\r\n');
  const norm = text.replace(/\r\n/g, '\n');
  const oldN = oldS.replace(/\r\n/g, '\n');
  const newN = newS.replace(/\r\n/g, '\n');
  const back = (t: string) => (crlf ? t.replace(/\n/g, '\r\n') : t);
  const nl = norm.split(oldN).length - 1;
  if (nl === 1 || (nl > 1 && replaceAll)) {
    return { text: back(replaceAll ? norm.split(oldN).join(newN) : norm.replace(oldN, () => newN)), how: 'newlines', count: replaceAll ? nl : 1 };
  }

  const fileLines = norm.split('\n');
  const oldLines = trimBlankEdges(oldN.split('\n'));
  if (oldLines.length) {
    const wins = whitespaceWindows(fileLines, oldLines);
    if (wins.length === 1 || (wins.length > 1 && replaceAll)) {
      const newLines = trimBlankEdges(newN.split('\n'));
      const firstOld = oldLines.find((l) => l.trim()) ?? '';
      let out = fileLines;
      for (const start of [...wins].reverse()) {
        const firstFile = out.slice(start, start + oldLines.length).find((l) => l.trim()) ?? '';
        const repl = reindent(newLines, leading(firstOld), leading(firstFile));
        out = [...out.slice(0, start), ...repl, ...out.slice(start + oldLines.length)];
      }
      return { text: back(out.join('\n')), how: 'whitespace', count: wins.length };
    }
    if (wins.length > 1) {
      throw new Error(`old_string matches ${wins.length} places when whitespace is ignored (lines ${wins.map((w) => w + 1).join(', ')}); include more surrounding lines.`);
    }
  }
  const hint = closestRegion(norm, oldN);
  throw new Error(`old_string not found in the file.${hint ? `\n${hint}\nCopy the exact text from the current file (read_file) and retry.` : ' Re-read the file and copy the exact text.'}`);
}

// ---------------- read-before-edit bookkeeping ----------------

/** Files the session has seen, by absolute path → content fingerprint at that time. */
export class FileState {
  private seen = new Map<string, string>();
  private misses = new Map<string, number>();

  /** Count a failed anchored edit on a file; returns how many in a row (reset by a successful write). */
  miss(path: string): number {
    const n = (this.misses.get(path) ?? 0) + 1;
    this.misses.set(path, n);
    return n;
  }

  private fp(content: string): string {
    // Length + cheap rolling hash: enough to detect changes, no crypto needed.
    let h = 0;
    for (let i = 0; i < content.length; i++) h = (h * 31 + content.charCodeAt(i)) | 0;
    return `${content.length}:${h}`;
  }

  note(path: string, content: string): void {
    this.misses.delete(path);
    this.seen.set(path, this.fp(content));
  }

  /**
   * Throws a model-actionable error if the file changed since it was last read or written, or — with requireRead
   * (whole-file overwrites) — if it was never read. Anchored edits may target unread files: their old text must match.
   */
  assertFresh(path: string, displayPath: string, requireRead = true): void {
    if (!existsSync(path)) return;
    const prev = this.seen.get(path);
    if (!prev && !requireRead) return;
    const current = readFileSync(path, 'utf8');
    if (prev === this.fp(current)) return;
    // Refuse this call, but hand over the current content (now counted as read) so the next call is informed.
    this.note(path, current);
    const why = prev
      ? `${displayPath} changed since you last read it (a command, another edit, or someone else modified it).`
      : `${displayPath} exists and was not read in this session, so it was not overwritten.`;
    const lines = current.split('\n');
    const body = lines.length <= 400 ? lines.map((l, i) => `${String(i + 1).padStart(6)}|${l}`).join('\n') : '(long file: read the parts you need with read_file)';
    throw new Error(`${why} Its current content is below and now counts as read: check that your change still fits, then call the tool again.\n${body}`);
  }
}

// ---------------- apply_patch (Codex-style) ----------------

export interface PatchOp {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo?: string;
  /** add: full content; update: hunks. */
  content?: string;
  hunks?: { anchor?: string; lines: string[] }[];
}

export function parsePatch(patch: string): PatchOp[] {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  let i = lines.findIndex((l) => l.trim() === '*** Begin Patch');
  if (i < 0) throw new Error('Patch must start with "*** Begin Patch".');
  i++;
  const ops: PatchOp[] = [];
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '*** End Patch') return ops;
    let m: RegExpExecArray | null;
    if ((m = /^\*\*\* Add File: (.+)$/.exec(l))) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('*** ')) {
        if (!lines[i].startsWith('+')) throw new Error(`Add File lines must start with "+": ${lines[i]}`);
        body.push(lines[i].slice(1));
        i++;
      }
      ops.push({ kind: 'add', path: m[1].trim(), content: body.join('\n') + '\n' });
    } else if ((m = /^\*\*\* Delete File: (.+)$/.exec(l))) {
      ops.push({ kind: 'delete', path: m[1].trim() });
      i++;
    } else if ((m = /^\*\*\* Update File: (.+)$/.exec(l))) {
      const op: PatchOp = { kind: 'update', path: m[1].trim(), hunks: [] };
      i++;
      if (lines[i] && (m = /^\*\*\* Move to: (.+)$/.exec(lines[i]))) {
        op.moveTo = m[1].trim();
        i++;
      }
      let cur: { anchor?: string; lines: string[] } | undefined;
      while (i < lines.length && !/^\*\*\* (Add File|Delete File|Update File|End Patch)/.test(lines[i])) {
        const x = lines[i];
        if (x.startsWith('@@')) {
          cur = { anchor: x.slice(2).trim() || undefined, lines: [] };
          op.hunks!.push(cur);
        } else if (x === '*** End of File') {
          // marker only
        } else if (/^[ +-]/.test(x) || x === '') {
          if (!cur) {
            cur = { lines: [] };
            op.hunks!.push(cur);
          }
          cur.lines.push(x === '' ? ' ' : x);
        } else throw new Error(`Unexpected patch line in ${op.path}: ${x}`);
        i++;
      }
      ops.push(op);
    } else if (!l.trim()) {
      i++;
    } else throw new Error(`Unexpected patch line: ${l}`);
  }
  throw new Error('Patch must end with "*** End Patch".');
}

function findBlock(fileLines: string[], block: string[], from: number): number {
  const tries: ((a: string, b: string) => boolean)[] = [(a, b) => a === b, (a, b) => a.trimEnd() === b.trimEnd(), (a, b) => a.trim() === b.trim()];
  for (const eq of tries) {
    const hits: number[] = [];
    for (let i = from; i + block.length <= fileLines.length; i++) {
      if (block.every((b, j) => eq(fileLines[i + j], b))) hits.push(i);
    }
    if (hits.length) return hits[0];
  }
  return -1;
}

/** Apply one update op's hunks to text (context-matched, tolerant to whitespace). */
export function applyHunks(text: string, hunks: NonNullable<PatchOp['hunks']>, path: string): string {
  let fileLines = text.replace(/\r\n/g, '\n').split('\n');
  let cursor = 0;
  for (const h of hunks) {
    if (h.anchor) {
      const a = fileLines.findIndex((l, k) => k >= cursor && l.trim() === h.anchor!.trim());
      if (a >= 0) cursor = a;
    }
    const oldBlock = h.lines.filter((l) => !l.startsWith('+')).map((l) => l.slice(1));
    const newBlock = h.lines.filter((l) => !l.startsWith('-')).map((l) => l.slice(1));
    if (!oldBlock.length) {
      fileLines = [...fileLines.slice(0, cursor), ...newBlock, ...fileLines.slice(cursor)];
      cursor += newBlock.length;
      continue;
    }
    const at = findBlock(fileLines, oldBlock, cursor);
    if (at < 0) {
      throw new Error(`Hunk does not apply to ${path}: context/removed lines not found:\n${oldBlock.slice(0, 6).join('\n')}\n${closestRegion(fileLines.join('\n'), oldBlock.join('\n'))}`);
    }
    fileLines = [...fileLines.slice(0, at), ...newBlock, ...fileLines.slice(at + oldBlock.length)];
    cursor = at + newBlock.length;
  }
  return fileLines.join('\n');
}

export function patchPaths(patch: string): string[] {
  try {
    return parsePatch(patch).flatMap((o) => (o.moveTo ? [o.path, o.moveTo] : [o.path]));
  } catch {
    return [];
  }
}

// ---------------- tools ----------------

function fresh(ctx: ToolContext, abs: string, requireRead: boolean): void {
  ctx.services.fileState?.assertFresh(abs, relative(ctx.cwd, abs) || abs, requireRead);
}

function written(ctx: ToolContext, abs: string, content: string | null): void {
  if (content !== null) ctx.services.fileState?.note(abs, content);
}

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Create a new file, or overwrite an existing one you have read in this session. Parent directories are created. Prefer edit_file / apply_patch for changes to existing files.',
  parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  risk: 'write',
  pathArg: 'path',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path);
    const existed = existsSync(p);
    if (existed) fresh(ctx, p, true);
    ctx.services.checkpoint?.([p]);
    mkdirSync(dirname(p), { recursive: true });
    const content = String(args.content ?? '');
    if (ctx.display) ctx.display.diff = unifiedDiff(existed ? readFileSync(p, 'utf8') : '', content, relative(ctx.cwd, p) || p);
    writeFileSync(p, content);
    written(ctx, p, content);
    return `${existed ? 'Overwrote' : 'Created'} ${relative(ctx.cwd, p) || p} (${content.split('\n').length} lines)` + (await diagnosticsNote(ctx.cwd, [p], ctx.services.lsp));
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Replace text in a file. old_string should be copied from the file and match once (include surrounding lines if needed); set replace_all to change every occurrence. Small whitespace/indentation differences are tolerated.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
    required: ['path', 'old_string', 'new_string'],
  },
  risk: 'write',
  pathArg: 'path',
  source: 'builtin',
  async execute(args, ctx) {
    const p = resolveIn(ctx.cwd, args.path);
    if (!existsSync(p)) throw new Error(`${args.path} does not exist; use write_file to create it.`);
    fresh(ctx, p, false);
    const before = readFileSync(p, 'utf8');
    let r: ReturnType<typeof tolerantReplace>;
    try {
      r = tolerantReplace(before, String(args.old_string), String(args.new_string ?? ''), !!args.replace_all);
    } catch (e) {
      // Weak models re-send the same wrong old_string from memory; from the second miss, show the whole file.
      const misses = ctx.services.fileState?.miss(p) ?? 1;
      if (misses < 2 || !/not found/.test((e as Error).message)) throw e;
      const lines = before.split('\n');
      const shown = lines.length <= 400 ? lines.map((l, i) => `${String(i + 1).padStart(6)}|${l}`).join('\n') : '(file too long to show; read the relevant range with read_file)';
      throw new Error(
        `old_string not found in ${args.path} (miss ${misses} in a row on this file). Your old_string does not match the file; it is not what the file contains. Current content:\n${shown}\n\nCopy old_string exactly from the lines above (without the line-number prefix), or replace the whole file with write_file.`,
      );
    }
    ctx.services.checkpoint?.([p]);
    writeFileSync(p, r.text);
    written(ctx, p, r.text);
    if (ctx.display) ctx.display.diff = unifiedDiff(before, r.text, relative(ctx.cwd, p) || p);
    const note = r.how === 'exact' ? '' : r.how === 'newlines' ? ' (matched after normalizing line endings)' : ' (matched ignoring whitespace; replacement re-indented)';
    return `Edited ${relative(ctx.cwd, p) || p}: ${r.count} replacement${r.count > 1 ? 's' : ''}${note}` + (await diagnosticsNote(ctx.cwd, [p], ctx.services.lsp));
  },
};

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: `Apply a multi-file patch atomically (all files or none). Format:
*** Begin Patch
*** Update File: src/a.ts
@@ optional anchor line (e.g. a function signature)
 unchanged context line
-removed line
+added line
*** Add File: src/new.ts
+full content line
*** Delete File: src/old.ts
*** End Patch
Use a few context lines around each change. "*** Move to: path" after Update File renames. Files must not have changed since you last read them.`,
  parameters: { type: 'object', properties: { patch: { type: 'string' } }, required: ['patch'] },
  risk: 'write',
  paths: (args) => patchPaths(String(args?.patch ?? '')),
  source: 'builtin',
  async execute(args, ctx) {
    const ops = parsePatch(String(args.patch ?? ''));
    if (!ops.length) throw new Error('Empty patch.');
    // Validate and compute everything first; write only if every operation applies.
    const writes: { abs: string; content: string | null; from?: string }[] = [];
    for (const op of ops) {
      const abs = resolveIn(ctx.cwd, op.path);
      if (op.kind === 'add') {
        if (existsSync(abs)) throw new Error(`Add File: ${op.path} already exists (use Update File).`);
        writes.push({ abs, content: op.content! });
      } else if (op.kind === 'delete') {
        if (!existsSync(abs)) throw new Error(`Delete File: ${op.path} does not exist.`);
        writes.push({ abs, content: null });
      } else {
        if (!existsSync(abs)) throw new Error(`Update File: ${op.path} does not exist.`);
        fresh(ctx, abs, false);
        const updated = applyHunks(readFileSync(abs, 'utf8'), op.hunks!, op.path);
        if (op.moveTo) {
          writes.push({ abs: resolveIn(ctx.cwd, op.moveTo), content: updated, from: abs });
        } else writes.push({ abs, content: updated });
      }
    }
    ctx.services.checkpoint?.(writes.flatMap((w) => (w.from ? [w.from, w.abs] : [w.abs])));
    if (ctx.display) {
      ctx.display.diff = writes
        .map((w) => {
          const src = w.from ?? w.abs;
          return unifiedDiff(existsSync(src) ? readFileSync(src, 'utf8') : '', w.content ?? '', relative(ctx.cwd, w.abs) || w.abs);
        })
        .filter(Boolean)
        .join('\n');
    }
    for (const w of writes) {
      if (w.content === null) rmSync(w.abs, { force: true });
      else {
        mkdirSync(dirname(w.abs), { recursive: true });
        if (w.from) renameSync(w.from, w.abs);
        writeFileSync(w.abs, w.content);
        written(ctx, w.abs, w.content);
      }
    }
    const summary = ops.map((o) => `${o.kind === 'add' ? 'A' : o.kind === 'delete' ? 'D' : o.moveTo ? 'R' : 'M'} ${o.moveTo ? `${o.path} -> ${o.moveTo}` : o.path}`).join('\n');
    return summary + (await diagnosticsNote(ctx.cwd, writes.filter((w) => w.content !== null).map((w) => w.abs), ctx.services.lsp));
  },
};
