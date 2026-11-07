import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { homePath } from './paths.js';

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

export interface ProjectContext {
  root: string;
  rules: RuleSection[];
  /** Rules that apply on demand (description only, the agent reads the file if relevant). */
  optionalRules: { source: string; description: string }[];
  specs: { path: string; title: string }[];
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
  const seen = new Set<string>();
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
        const src = relative(root, join(sunRules, f));
        if (data.alwaysApply === 'false' && data.description) optionalRules.push({ source: src, description: data.description });
        else if (!seen.has(real(join(sunRules, f)))) {
          seen.add(real(join(sunRules, f)));
          rules.push({ source: src, text: body.trim(), scope: 'project' });
        }
      }
    }
  }

  const cursorRules = join(root, '.cursor', 'rules');
  if (existsSync(cursorRules)) {
    for (const f of readdirSync(cursorRules).filter((f) => f.endsWith('.mdc') || f.endsWith('.md')).sort()) {
      const { data, body } = parseFrontmatter(readFileSync(join(cursorRules, f), 'utf8'));
      const src = `.cursor/rules/${f}`;
      if (data.alwaysApply === 'true') rules.push({ source: src, text: body.trim(), scope: 'project' });
      else if (data.description) optionalRules.push({ source: src, description: data.description });
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
  return { root, rules: applyRuleBudgets(rules, budgets), optionalRules, specs };
}
