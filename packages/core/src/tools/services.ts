import type { Tool, ToolContext, ToolServices } from './types.js';

function need<K extends keyof ToolServices>(ctx: ToolContext, k: K): NonNullable<ToolServices[K]> {
  const fn = ctx.services[k];
  if (!fn) throw new Error(`Service "${k}" is not available in this host.`);
  return fn as NonNullable<ToolServices[K]>;
}

/** Tools that delegate to host services (knowledge, memory, skills, subagents, schedules). */
export const SERVICE_TOOLS: Tool[] = [
  {
    name: 'kb_search',
    description: 'Search the knowledge base (personal notes; company KB when configured). Returns ranked passages with sources.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'number', description: 'Max results (default 6).' },
        provider: { type: 'string', description: 'Optional provider id, e.g. "personal" or "company".' },
      },
      required: ['query'],
    },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'kbSearch')(String(a.query), a.k, a.provider),
  },
  {
    name: 'kb_add_note',
    description: 'Save a note into the personal knowledge base (markdown). Use for durable reference material, not for chat memory.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] },
    risk: 'write',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'kbAdd')(String(a.title), String(a.text)),
  },
  {
    name: 'memory_save',
    description:
      'Remember a durable fact about the user or their preferences/projects (e.g. "prefers pnpm"). Keep it short. Memory is shown in future sessions.',
    parameters: {
      type: 'object',
      properties: { fact: { type: 'string' }, section: { type: 'string', description: 'e.g. Profile, Preferences, Projects, Lessons' } },
      required: ['fact'],
    },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'memorySave')(String(a.fact), a.section),
  },
  {
    name: 'load_skill',
    description: 'Load the full instructions of a skill listed in the system prompt. Call this before doing a task the skill covers.',
    parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'loadSkill')(String(a.name)),
  },
  {
    name: 'task',
    description:
      'Delegate a self-contained sub-task to a fresh subagent with its own context. Give a complete prompt; it returns a final report. Use for research or parallelizable work.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, mode: { type: 'string', enum: ['coding', 'agent', 'assistant'] } },
      required: ['prompt'],
    },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'runSubagent')(String(a.prompt), { mode: a.mode }),
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a prompt to run later as a new session: once at an ISO time ("at") or repeatedly with a 5-field cron ("cron", local time). Runs while the desktop app is open.',
    parameters: {
      type: 'object',
      properties: { prompt: { type: 'string' }, at: { type: 'string' }, cron: { type: 'string' }, title: { type: 'string' } },
      required: ['prompt'],
    },
    risk: 'write',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'scheduleTask')({ prompt: String(a.prompt), at: a.at, cron: a.cron, title: a.title }),
  },
];
