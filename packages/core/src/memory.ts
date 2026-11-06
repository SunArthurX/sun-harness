import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureDir, homePath } from './paths.js';

const MAX_PROMPT_CHARS = 12_000;

export function memoryFile(): string {
  ensureDir(homePath('memory'));
  return homePath('memory', 'MEMORY.md');
}

export function readMemory(): string {
  const f = memoryFile();
  if (!existsSync(f)) return '';
  const t = readFileSync(f, 'utf8');
  return t.length > MAX_PROMPT_CHARS ? t.slice(-MAX_PROMPT_CHARS) : t;
}

export function writeMemory(text: string): void {
  writeFileSync(memoryFile(), text);
}

/** Append a fact under a "## Section" heading, creating the heading if needed. Duplicate facts are ignored. */
export function saveMemoryFact(fact: string, section = 'Notes'): string {
  const f = memoryFile();
  let text = existsSync(f) ? readFileSync(f, 'utf8') : '# Memory\n';
  const line = `- ${fact.trim().replace(/\n+/g, ' ')}`;
  if (text.split('\n').some((l) => l.trim() === line)) return 'Already remembered.';
  const heading = `## ${section.trim() || 'Notes'}`;
  const lines = text.split('\n');
  const idx = lines.findIndex((l) => l.trim().toLowerCase() === heading.toLowerCase());
  if (idx < 0) {
    text = `${text.trimEnd()}\n\n${heading}\n${line}\n`;
  } else {
    let end = idx + 1;
    while (end < lines.length && !lines[end].startsWith('## ')) end++;
    while (end > idx + 1 && !lines[end - 1].trim()) end--;
    lines.splice(end, 0, line);
    text = lines.join('\n');
  }
  writeFileSync(f, text);
  return `Remembered under "${section}".`;
}
