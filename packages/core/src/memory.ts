import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { USER_PROFILE_MAX } from './settings/preferences.js';
import { ensureDir, homePath } from './paths.js';

const MAX_PROMPT_CHARS = 12_000;
export { USER_PROFILE_MAX } from './settings/preferences.js';

export function memoryFile(): string {
  ensureDir(homePath('memory'));
  return homePath('memory', 'MEMORY.md');
}

export function readMemory(full = false): string {
  const f = memoryFile();
  if (!existsSync(f)) return '';
  const t = readFileSync(f, 'utf8');
  return !full && t.length > MAX_PROMPT_CHARS ? t.slice(-MAX_PROMPT_CHARS) : t;
}

export function writeMemory(text: string): void {
  writeFileSync(memoryFile(), text);
}

export function userFile(): string {
  ensureDir(homePath('memory'));
  return homePath('memory', 'USER.md');
}

/** Who the user is. Capped so it cannot crowd out the task. */
export function readUserProfile(): string {
  const f = userFile();
  if (!existsSync(f)) return '';
  return readFileSync(f, 'utf8').slice(0, USER_PROFILE_MAX);
}

export function writeUserProfile(text: string): void {
  const body = text.length > USER_PROFILE_MAX ? text.slice(0, USER_PROFILE_MAX) : text;
  writeFileSync(userFile(), body.endsWith('\n') || !body ? body : `${body}\n`);
}

function instructionsFile(): string {
  ensureDir(homePath('memory'));
  return homePath('memory', 'INSTRUCTIONS.md');
}

export function readPersonalInstructions(): string {
  const file = instructionsFile();
  return existsSync(file) ? readFileSync(file, 'utf8').slice(0, USER_PROFILE_MAX) : '';
}

export function writePersonalInstructions(text: string): void {
  writeFileSync(instructionsFile(), text.slice(0, USER_PROFILE_MAX));
}

/** Add one stable fact about the user. Drops the oldest bullets when the file would pass the cap. */
export function saveUserFact(fact: string): string {
  const line = `- ${fact.trim().replace(/\n+/g, ' ')}`;
  if (!line.slice(2).trim()) return 'Nothing to save.';
  let text = existsSync(userFile()) ? readFileSync(userFile(), 'utf8') : '# User\n';
  if (text.split('\n').some((l) => l.trim() === line)) return 'Already in the user profile.';
  text = `${text.trimEnd()}\n${line}\n`;
  const lines = text.split('\n');
  while (text.length > USER_PROFILE_MAX) {
    const i = lines.findIndex((l) => l.startsWith('- '));
    if (i < 0) break;
    lines.splice(i, 1);
    text = lines.join('\n');
    if (!text.endsWith('\n')) text += '\n';
  }
  if (text.length > USER_PROFILE_MAX) text = text.slice(0, USER_PROFILE_MAX);
  writeFileSync(userFile(), text);
  return 'Saved to the user profile.';
}

export function dailyFile(date: string): string {
  ensureDir(homePath('memory', 'daily'));
  return homePath('memory', 'daily', `${date}.md`);
}

/** One line in today's diary (OpenClaw-style daily note). Duplicates are ignored. */
export function appendDaily(line: string, date: string): void {
  const fact = line.trim().replace(/\n+/g, ' ');
  if (!fact) return;
  const f = dailyFile(date);
  const text = existsSync(f) ? readFileSync(f, 'utf8') : `# ${date}\n`;
  const bullet = `- ${fact}`;
  if (text.split('\n').some((l) => l.trim() === bullet)) return;
  writeFileSync(f, `${text.trimEnd()}\n${bullet}\n`);
}

export function readDaily(date: string): string {
  const f = dailyFile(date);
  return existsSync(f) ? readFileSync(f, 'utf8') : '';
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
