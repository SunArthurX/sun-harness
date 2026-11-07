import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { homePath } from '../paths.js';
import { findProjectRoot } from '../rules.js';

export interface CustomCommand {
  /** Invoked as /name; files in sub-folders become /folder:name. */
  name: string;
  description: string;
  argumentHint?: string;
  /** Run the expanded prompt in this mode or with this model (switches the session first). */
  mode?: string;
  model?: string;
  body: string;
  source: string;
  scope: 'project' | 'user' | 'compat';
}

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([\w-]+)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

function scan(dir: string, scope: CustomCommand['scope'], out: Map<string, CustomCommand>): void {
  if (!existsSync(dir)) return;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const name = relative(dir, full).replace(/\.md$/, '').split(/[\\/]/).join(':');
        const { meta, body } = parseFrontmatter(readFileSync(full, 'utf8'));
        const firstLine = body.trim().split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) ?? '';
        out.set(name, {
          name,
          description: meta.description || firstLine,
          argumentHint: meta['argument-hint'] || undefined,
          mode: meta.mode || undefined,
          model: meta.model || undefined,
          body,
          source: full,
          scope,
        });
      }
    }
  };
  try {
    if (statSync(dir).isDirectory()) walk(dir);
  } catch {
    // unreadable folder
  }
}

/** Commands from (lowest to highest precedence) ~/.claude/commands, ~/.sun/commands, <project>/.claude/commands, <project>/.sun/commands. */
export function loadCommands(cwd: string): CustomCommand[] {
  const out = new Map<string, CustomCommand>();
  const root = findProjectRoot(cwd) ?? cwd;
  scan(join(homedir(), '.claude', 'commands'), 'compat', out);
  scan(homePath('commands'), 'user', out);
  scan(join(root, '.claude', 'commands'), 'compat', out);
  scan(join(root, '.sun', 'commands'), 'project', out);
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Split shell-style: quoted strings stay together. */
export function splitArgs(s: string): string[] {
  return [...s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** `/name args` → the command's prompt with $ARGUMENTS and $1…$9 filled in; undefined if it is not a custom command. */
export function expandCommand(text: string, commands: CustomCommand[]): { prompt: string; command: CustomCommand } | undefined {
  const m = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return undefined;
  const command = commands.find((c) => c.name === m[1]);
  if (!command) return undefined;
  const raw = (m[2] ?? '').trim();
  const args = splitArgs(raw);
  let prompt = command.body.replace(/\$ARGUMENTS/g, raw).replace(/\$([1-9])/g, (_x, n: string) => args[Number(n) - 1] ?? '');
  if (!/\$ARGUMENTS|\$[1-9]/.test(command.body) && raw) prompt = `${prompt.trimEnd()}\n\n${raw}`;
  return { prompt: prompt.trim(), command };
}
