import { localDate } from './util/date.js';
import { platform, release } from 'node:os';
import type { ModeDef } from './modes.js';
import type { ProjectContext } from './rules.js';

export interface PromptParts {
  mode: ModeDef;
  cwd: string;
  model: string;
  project?: ProjectContext;
  skills?: { name: string; description: string }[];
  memory?: string;
  knowledgeProviders?: { id: string; name: string }[];
  extraSections?: { title: string; text: string }[];
  now?: Date;
}

export function buildSystemPrompt(p: PromptParts): string {
  const out: string[] = [p.mode.prompt];
  const now = p.now ?? new Date();
  out.push(
    [
      '# Environment',
      `- Workspace: ${p.cwd}`,
      p.project && p.project.root !== p.cwd ? `- Project root: ${p.project.root}` : '',
      `- OS: ${platform()} ${release()}`,
      `- Date: ${localDate(now)}`,
      `- Model: ${p.model}`,
    ]
      .filter(Boolean)
      .join('\n'),
  );

  if (p.project?.rules.length) {
    out.push(
      '# Project rules\nThese rules are binding. Closer (more specific) files override broader ones.\n\n' +
        p.project.rules.map((r) => `## ${r.source}\n${r.text.trim()}`).join('\n\n'),
    );
  }
  if (p.project?.optionalRules.length) {
    out.push(
      '# Optional rules (read the file when relevant)\n' + p.project.optionalRules.map((r) => `- ${r.source}: ${r.description}`).join('\n'),
    );
  }
  if (p.project?.specs.length) {
    out.push(
      '# Specs (source of truth for behavior; read before changing related code)\n' +
        p.project.specs.map((s) => `- ${s.path}: ${s.title}`).join('\n'),
    );
  }
  if (p.skills?.length) {
    out.push(
      '# Skills\nSkills are packaged instructions. When a task matches a skill, call load_skill with its name first, then follow it.\n' +
        p.skills.map((s) => `- ${s.name}: ${s.description}`).join('\n'),
    );
  }
  if (p.knowledgeProviders?.length) {
    out.push('# Knowledge base\nUse kb_search to consult: ' + p.knowledgeProviders.map((k) => `${k.name} (${k.id})`).join(', ') + '.');
  }
  if (p.memory?.trim()) {
    out.push('# Memory (what you know about the user)\n' + p.memory.trim());
  }
  for (const s of p.extraSections ?? []) out.push(`# ${s.title}\n${s.text}`);
  return out.join('\n\n');
}
