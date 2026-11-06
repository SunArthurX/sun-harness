import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { homePath } from './paths.js';
import { findProjectRoot, parseFrontmatter } from './rules.js';

export interface Skill {
  name: string;
  description: string;
  dir: string;
  file: string;
  scope: 'project' | 'user' | 'compat' | 'plugin';
}

/** Search order: project wins over user, user over compat (Claude/Cursor/Codex locations). */
export function skillDirs(cwd: string, extra: string[] = [], compat = true): { dir: string; scope: Skill['scope'] }[] {
  const root = findProjectRoot(cwd);
  const dirs: { dir: string; scope: Skill['scope'] }[] = [
    { dir: join(root, '.sun', 'skills'), scope: 'project' },
    { dir: homePath('skills'), scope: 'user' },
    ...extra.map((dir) => ({ dir, scope: 'user' as const })),
  ];
  if (compat) {
    dirs.push(
      { dir: join(root, '.claude', 'skills'), scope: 'compat' },
      { dir: join(root, '.agents', 'skills'), scope: 'compat' },
      { dir: join(homedir(), '.claude', 'skills'), scope: 'compat' },
      { dir: join(homedir(), '.agents', 'skills'), scope: 'compat' },
    );
  }
  return dirs;
}

export function discoverSkills(dirs: { dir: string; scope: Skill['scope'] }[]): Skill[] {
  const byName = new Map<string, Skill>();
  for (const { dir, scope } of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const sdir = join(dir, entry);
      const file = join(sdir, 'SKILL.md');
      try {
        if (!statSync(sdir).isDirectory() || !existsSync(file)) continue;
        const { data } = parseFrontmatter(readFileSync(file, 'utf8'));
        const name = data.name || entry;
        if (byName.has(name)) continue;
        byName.set(name, { name, description: (data.description || '').slice(0, 400), dir: sdir, file, scope });
      } catch {
        // Unreadable skill folders are skipped.
      }
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function listFiles(dir: string, base = dir, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) listFiles(full, base, out);
    else out.push(relative(base, full));
    if (out.length > 100) break;
  }
  return out;
}

/** Progressive disclosure: the index is in the prompt, the body is loaded on demand. */
export function loadSkillBody(skill: Skill): string {
  const { body } = parseFrontmatter(readFileSync(skill.file, 'utf8'));
  const files = listFiles(skill.dir).filter((f) => f !== 'SKILL.md');
  return [
    `# Skill: ${skill.name}`,
    `Location: ${skill.dir}`,
    body.trim(),
    files.length ? `\nBundled files (read with read_file using the location above):\n${files.map((f) => `- ${f}`).join('\n')}` : '',
  ].join('\n\n');
}
