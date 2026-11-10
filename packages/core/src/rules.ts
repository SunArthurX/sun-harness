import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { homePath } from './paths.js';
import { ruleGlobsMatch } from './ux/ignore.js';

export interface RuleSection {
  source: string;
  text: string;
  /** Budget layer: global (~/.sun) or project (repo files). */
  scope: 'global' | 'project';
}

/** Separate budgets so a large project AGENTS.md cannot evict global rules (and vice versa). */
export interface RuleBudgets {
  globalMaxChars: number;
  projectMaxChars: number;
}

export const DEFAULT_RULE_BUDGETS: RuleBudgets = { globalMaxChars: 12_000, projectMaxChars: 40_000 };

/** Fill each layer in order; whatever exceeds the layer budget is cut with a pointer to the full file. */
export function applyRuleBudgets(rules: RuleSection[], budgets: RuleBudgets): RuleSection[] {
  const left = { global: budgets.globalMaxChars, project: budgets.projectMaxChars };
  const out: RuleSection[] = [];
  for (const r of rules) {
    const room = left[r.scope];
    if (room <= 0) {
      out.push({ ...r, text: `[omitted: the ${r.scope} rules budget is used up; read ${r.source} with read_file if relevant]` });
      continue;
    }
    if (r.text.length <= room) {
      out.push(r);
      left[r.scope] -= r.text.length;
    } else {
      out.push({ ...r, text: `${r.text.slice(0, room)}\n[truncated: ${r.text.length - room} more chars over the ${r.scope} rules budget; read ${r.source} for the rest]` });
      left[r.scope] = 0;
    }
  }
  return out;
}

/** A rule that is not always in the prompt: attached by glob, by description, or only when @mentioned. */
export interface NamedRule {
  source: string;
  text: string;
  description?: string;
  /** Cursor `globs`: attached when a file in the conversation matches. */
  globs?: string;
}

export interface ProjectContext {
  root: string;
  rules: RuleSection[];
  /** Rules that apply on demand (description only, the agent reads the file if relevant). */
  optionalRules: { source: string; description: string }[];
  /** `globs` rules. Included once a matching file has been read or edited. */
  fileRules: NamedRule[];
  /** No description and no globs: only when the user writes `@rule <name>`. */
  manualRules: NamedRule[];
  specs: { path: string; title: string }[];
}

/** File-scoped rules whose globs match any of `rels` (paths relative to the project root). */
export function rulesForFiles(rules: NamedRule[], rels: string[]): NamedRule[] {
  const norm = rels.map((r) => r.replace(/\\/g, '/'));
  return rules.filter((rule) => rule.globs && norm.some((rel) => ruleGlobsMatch(rule.globs!, rel)));
}

const MAX_RULE_CHARS = 24_000;

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  let key = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      data[key] = kv[2].replace(/^["']|["']$/g, '').trim();
    } else if (key && /^\s+/.test(line)) {
      data[key] = `${data[key]} ${line.trim()}`.trim();
    }
  }
  return { data, body: text.slice(m[0].length) };
}

/** Nearest ancestor with .git (or the cwd itself). */
export function findProjectRoot(cwd: string): string {
  let dir = resolve(cwd);
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || dir === homedir()) return resolve(cwd);
    dir = parent;
  }
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function read(p: string): string {
  const t = readFileSync(p, 'utf8');
  return t.length > MAX_RULE_CHARS ? t.slice(0, MAX_RULE_CHARS) + '\n[truncated]' : t;
}

export function loadProjectContext(cwd: string, budgets: RuleBudgets = DEFAULT_RULE_BUDGETS): ProjectContext {
  const root = findProjectRoot(cwd);
  const rules: RuleSection[] = [];
  const optionalRules: ProjectContext['optionalRules'] = [];
  const fileRules: NamedRule[] = [];
  const manualRules: NamedRule[] = [];
  const seen = new Set<string>();
  const classify = (src: string, data: Record<string, string>, body: string) => {
    const text = body.trim();
    if (data.alwaysApply === 'true') {
      if (!seen.has(src)) {
        seen.add(src);
        rules.push({ source: src, text, scope: 'project' });
      }
      return;
    }
    if (data.globs) fileRules.push({ source: src, text, description: data.description, globs: data.globs });
    if (data.description) optionalRules.push({ source: src, description: data.globs ? `${data.description} (files: ${data.globs})` : data.description });
    else if (!data.globs && data.alwaysApply !== 'false') {
      if (!seen.has(src)) {
        seen.add(src);
        rules.push({ source: src, text, scope: 'project' });
      }
    } else if (!data.globs) manualRules.push({ source: src, text });
  };
  const add = (p: string, label: string, scope: RuleSection['scope'] = 'project') => {
    if (!existsSync(p)) return false;
    const r = real(p);
    if (seen.has(r)) return true;
    seen.add(r);
    rules.push({ source: label, text: read(p), scope });
    return true;
  };

  add(homePath('AGENTS.md'), '~/.sun/AGENTS.md (global)', 'global');

  const chain: string[] = [];
  for (let d = resolve(cwd); ; d = dirname(d)) {
    chain.unshift(d);
    if (d === root || dirname(d) === d) break;
  }
  for (const d of chain) {
    const rel = relative(root, d) || '.';
    if (!add(join(d, 'AGENTS.md'), `${rel}/AGENTS.md`)) add(join(d, 'CLAUDE.md'), `${rel}/CLAUDE.md`);
  }

  for (const base of [root, resolve(cwd)]) {
    const sunRules = join(base, '.sun', 'rules');
    if (existsSync(sunRules)) {
      for (const f of readdirSync(sunRules).filter((f) => f.endsWith('.md')).sort()) {
        const { data, body } = parseFrontmatter(readFileSync(join(sunRules, f), 'utf8'));
        classify(relative(root, join(sunRules, f)), data, body);
      }
    }
  }

  const cursorRules = join(root, '.cursor', 'rules');
  if (existsSync(cursorRules)) {
    for (const f of readdirSync(cursorRules).filter((f) => f.endsWith('.mdc') || f.endsWith('.md')).sort()) {
      const { data, body } = parseFrontmatter(readFileSync(join(cursorRules, f), 'utf8'));
      classify(`.cursor/rules/${f}`, data, body);
    }
  }

  const specs: ProjectContext['specs'] = [];
  const specDir = join(root, 'specs');
  if (existsSync(specDir)) {
    for (const f of readdirSync(specDir).filter((f) => f.endsWith('.md')).sort()) {
      const first = readFileSync(join(specDir, f), 'utf8').split('\n').find((l) => l.startsWith('#'));
      specs.push({ path: `specs/${f}`, title: first?.replace(/^#+\s*/, '') ?? f });
    }
  }
  return { root, rules: applyRuleBudgets(rules, budgets), optionalRules, fileRules, manualRules, specs };
}
