import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionLog } from './log.js';
import { saveMemoryFact } from './memory.js';
import { ensureDir, homePath } from './paths.js';
import { extractJson } from './util/json.js';

export type ProposalType = 'memory' | 'skill' | 'rule' | 'feature';

export interface Proposal {
  id: string;
  type: ProposalType;
  title: string;
  /** memory: the fact; skill: SKILL.md body; rule: rule text; feature: description. */
  content: string;
  rationale: string;
  section?: string;
  skillName?: string;
  skillDescription?: string;
  source: { kind: 'session' | 'intel' | 'manual'; ref: string };
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: string;
  decidedAt?: string;
}

export type Complete = (system: string, user: string) => Promise<string>;

function dir(): string {
  return ensureDir(homePath('evolution', 'proposals'));
}

export function listProposals(status?: Proposal['status']): Proposal[] {
  return readdirSync(dir())
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir(), f), 'utf8')) as Proposal)
    .filter((p) => !status || p.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function save(p: Proposal): Proposal {
  writeFileSync(join(dir(), `${p.id}.json`), JSON.stringify(p, null, 2) + '\n');
  return p;
}

export function addProposal(p: Omit<Proposal, 'id' | 'status' | 'createdAt'>): Proposal {
  const existing = listProposals().find((x) => x.type === p.type && x.title.toLowerCase() === p.title.toLowerCase());
  if (existing) return existing;
  return save({ ...p, id: `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`, status: 'pending', createdAt: new Date().toISOString() });
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'skill';
}

function journal(line: string): void {
  const f = homePath('evolution', 'journal.md');
  if (!existsSync(f)) writeFileSync(f, '# Evolution journal\n\nAccepted changes to how sun-harness behaves.\n\n');
  appendFileSync(f, `- ${new Date().toISOString().slice(0, 16).replace('T', ' ')} — ${line}\n`);
}

/** Apply an accepted proposal to the harness itself (memory, skills, global rules, backlog). */
export function acceptProposal(id: string): { proposal: Proposal; appliedTo: string } {
  const p = listProposals().find((x) => x.id === id);
  if (!p) throw new Error(`No proposal ${id}`);
  if (p.status !== 'pending') throw new Error(`Proposal ${id} is already ${p.status}`);
  let appliedTo = '';
  switch (p.type) {
    case 'memory':
      saveMemoryFact(p.content, p.section ?? 'Lessons');
      appliedTo = homePath('memory', 'MEMORY.md');
      break;
    case 'skill': {
      const name = slug(p.skillName ?? p.title);
      const sdir = homePath('skills', name);
      mkdirSync(sdir, { recursive: true });
      const desc = (p.skillDescription ?? p.rationale).replace(/\n/g, ' ');
      writeFileSync(join(sdir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n\n${p.content.trim()}\n`);
      appliedTo = join(sdir, 'SKILL.md');
      break;
    }
    case 'rule': {
      const f = homePath('AGENTS.md');
      if (!existsSync(f)) writeFileSync(f, '# Global rules (sun-harness)\n\nApplied to every session. Written in English.\n');
      appendFileSync(f, `\n- ${p.content.trim().replace(/\n+/g, ' ')}\n`);
      appliedTo = f;
      break;
    }
    case 'feature': {
      const f = homePath('evolution', 'backlog.md');
      if (!existsSync(f)) writeFileSync(f, '# Feature backlog\n\nIdeas from intel and reflection. Each becomes a spec before code.\n');
      appendFileSync(f, `\n## ${p.title}\n\n${p.content.trim()}\n\n_Why:_ ${p.rationale}\n_Source:_ ${p.source.kind} ${p.source.ref}\n`);
      appliedTo = f;
      break;
    }
  }
  p.status = 'accepted';
  p.decidedAt = new Date().toISOString();
  save(p);
  journal(`accepted ${p.type} "${p.title}" → ${appliedTo}`);
  return { proposal: p, appliedTo };
}

export function rejectProposal(id: string): Proposal {
  const p = listProposals().find((x) => x.id === id);
  if (!p) throw new Error(`No proposal ${id}`);
  p.status = 'rejected';
  p.decidedAt = new Date().toISOString();
  return save(p);
}

const REFLECT_SYSTEM = `You improve a personal AI agent harness by reflecting on one session transcript.
Propose at most 5 high-value, durable improvements. Types:
- "memory": a short fact about the user or their preferences/projects (content = one sentence; section = Profile|Preferences|Projects|Lessons).
- "skill": a reusable procedure the agent should follow next time (content = Markdown instructions; skillName = kebab-case; skillDescription = when to use it).
- "rule": a global behavior rule (content = one imperative sentence).
- "feature": a capability the harness lacks (content = description).
Only propose what the transcript supports. No duplicates of existing memory. Output ONLY a JSON array:
[{"type":"memory|skill|rule|feature","title":"...","content":"...","rationale":"...","section":"...","skillName":"...","skillDescription":"..."}]
Use English.`;

export function transcriptOf(sessionId: string, maxChars = 60_000): string {
  const log = SessionLog.open(sessionId);
  const parts: string[] = [];
  for (const e of log.all()) {
    if (e.type === 'user/message') parts.push(`USER: ${e.text}`);
    else if (e.type === 'assistant/message') {
      parts.push(`ASSISTANT: ${e.text}${e.toolCalls.length ? `\n  calls: ${e.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 200)})`).join(', ')}` : ''}`);
    } else if (e.type === 'tool/result') parts.push(`TOOL ${e.name}${e.isError ? ' ERROR' : ''}: ${e.output.slice(0, 600)}`);
    else if (e.type === 'approval/decision') parts.push(`APPROVAL: ${e.decision}`);
  }
  const t = parts.join('\n');
  return t.length > maxChars ? t.slice(-maxChars) : t;
}

export async function reflectSession(complete: Complete, sessionId: string, memory = ''): Promise<Proposal[]> {
  const transcript = transcriptOf(sessionId);
  if (!transcript.trim()) return [];
  const out = await complete(REFLECT_SYSTEM, `Existing memory:\n${memory || '(empty)'}\n\nTranscript:\n${transcript}`);
  const items = extractJson<Partial<Proposal>[]>(out);
  if (!Array.isArray(items)) throw new Error(`Reflection returned no JSON proposals: ${out.slice(0, 300)}`);
  return items
    .filter((i) => i && i.type && i.title && i.content && ['memory', 'skill', 'rule', 'feature'].includes(i.type))
    .slice(0, 5)
    .map((i) =>
      addProposal({
        type: i.type as ProposalType,
        title: String(i.title),
        content: String(i.content),
        rationale: String(i.rationale ?? ''),
        section: i.section,
        skillName: i.skillName,
        skillDescription: i.skillDescription,
        source: { kind: 'session', ref: sessionId },
      }),
    );
}
