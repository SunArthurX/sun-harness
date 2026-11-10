import type { Tool, ToolContext, ToolServices } from './types.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildRepoMap } from '../repomap.js';
import { searchCodebase } from '../ux/codebase.js';
import { renderSlides, speakerNotes, type SlideInput } from '../ux/slides.js';

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
      'Remember a durable fact about the user, their preferences, people, projects, or a lesson (one short fact per call). Long-term memories are recalled automatically when relevant. Set core: true only for identity-level facts needed in every conversation (name, language, time zone); those are always shown.',
    parameters: {
      type: 'object',
      properties: {
        fact: { type: 'string' },
        kind: { type: 'string', enum: ['fact', 'preference', 'person', 'project', 'lesson'] },
        core: { type: 'boolean' },
        section: { type: 'string', description: 'core memory section, e.g. Profile, Preferences' },
      },
      required: ['fact'],
    },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) =>
      a.core || a.section || !ctx.services.memoryRemember
        ? need(ctx, 'memorySave')(String(a.fact), a.section ?? (a.core ? 'Profile' : undefined))
        : ctx.services.memoryRemember(String(a.fact), a.kind),
  },
  {
    name: 'memory_search',
    description: 'Search long-term memory (facts, preferences, people, projects, lessons, past conversations) by keywords.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'memorySearch')(String(a.query)),
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
    name: 'wide_research',
    description:
      'Research several independent items without mixing them in one context (Manus wide research, bounded). Pass a question and 2–8 items. Each item runs in a fresh subagent. Writes research/<question>.md and returns the combined notes for you to synthesize.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        items: { type: 'array', items: { type: 'string' }, description: 'Independent subjects, one each.' },
      },
      required: ['question', 'items'],
    },
    risk: 'read',
    source: 'builtin',
    modes: ['agent'],
    execute: (a, ctx) => need(ctx, 'wideResearch')(String(a.question ?? ''), Array.isArray(a.items) ? a.items.map(String) : []),
  },
  {
    name: 'make_slides',
    description:
      'Write a presentation the user can open: an HTML deck (arrow keys) and a speaker-notes markdown file under slides/. Pass a title and slides with title, bullets, and notes. Use this when the user wants a deck, not a prose outline.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              bullets: { type: 'array', items: { type: 'string' } },
              notes: { type: 'string' },
            },
            required: ['title'],
          },
        },
      },
      required: ['title', 'slides'],
    },
    risk: 'write',
    source: 'builtin',
    modes: ['agent', 'assistant'],
    async execute(a, ctx) {
      const title = String(a.title ?? 'Slides').slice(0, 120);
      const slides = (Array.isArray(a.slides) ? a.slides : []) as SlideInput[];
      const slug = title.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'slides';
      const dir = join(ctx.cwd, 'slides');
      mkdirSync(dir, { recursive: true });
      const htmlPath = join(dir, `${slug}.html`);
      const notesPath = join(dir, `${slug}-notes.md`);
      writeFileSync(htmlPath, renderSlides(title, slides));
      writeFileSync(notesPath, speakerNotes(title, slides));
      return `Wrote ${htmlPath} (${slides.length} slides) and ${notesPath}. Open the HTML in a browser; arrow keys change slides.`;
    },
  },
  {
    name: 'session_search',
    description: 'Search past conversations by words in titles and messages. Use this when the user refers to something decided earlier and it is not in memory.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    risk: 'read',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'searchSessions')(String(a.query ?? '')),
  },
  {
    name: 'remember_user',
    description: 'Save one stable fact about the user (name, role, timezone, communication style, a lasting preference) into the user profile, which is loaded every session. One short sentence.',
    parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
    risk: 'write',
    source: 'builtin',
    execute: (a, ctx) => need(ctx, 'rememberUser')(String(a.fact ?? '')),
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
    name: 'exit_plan_mode',
    description:
      'Plan mode only: submit your implementation plan (Markdown) for the user to approve. On approval the session switches to coding mode and you implement the plan.',
    parameters: { type: 'object', properties: { plan: { type: 'string' } }, required: ['plan'] },
    // exec risk: the plan passes the approval policy, so a human reviews it unless approval is full-auto.
    risk: 'exec',
    source: 'builtin',
    async execute(a, ctx) {
      if (!ctx.services.exitPlanMode) throw new Error('Plan mode is not available here.');
      return ctx.services.exitPlanMode(String(a.plan ?? ''));
    },
  },
  {
    name: 'codebase_search',
    description:
      'Search the repository by meaning or by a symbol name (functions, classes, types). Returns file:line snippets. Use this before reading whole files. Respects .cursorignore and .sunignore.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words, a phrase, or a symbol name.' },
        k: { type: 'number', description: 'How many snippets (default 8).' },
      },
      required: ['query'],
    },
    risk: 'read',
    source: 'builtin',
    async execute(a, ctx) {
      const hits = searchCodebase(ctx.cwd, String(a.query ?? ''), Number(a.k) || 8);
      if (!hits.length) return 'No matches.';
      return hits.map((h) => `${h.path}:${h.line} (score ${h.score})\n${h.text}`).join('\n---\n');
    },
  },
  {
    name: 'repo_map',
    description:
      'Outline of the repository: the most referenced definitions per file (functions, classes, types) with line numbers. Filter with `query` (symbol or file name) or `path` (sub-folder). Use it to find where things live before reading files.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } } },
    risk: 'read',
    source: 'builtin',
    async execute(a, ctx) {
      const { text, totalFiles } = buildRepoMap(ctx.cwd, { query: a.query, focus: a.path, budget: 12_000 });
      return text ? `${text}\n(${totalFiles} source files scanned)` : 'No definitions found.';
    },
  },
  {
    name: 'job_status',
    description: 'Show background jobs of this session (no id) or the state and latest output of one job.',
    parameters: { type: 'object', properties: { id: { type: 'string' } } },
    risk: 'read',
    source: 'builtin',
    execute: async (a, ctx) => need(ctx, 'jobStatus')(a.id),
  },
  {
    name: 'job_kill',
    description: 'Stop a running background job.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    risk: 'exec',
    source: 'builtin',
    execute: async (a, ctx) => need(ctx, 'killJob')(String(a.id)),
  },
  {
    name: 'schedule_task',
    description:
      'Schedule a prompt to run later as a new session: once at an ISO time ("at") or repeatedly with a 5-field cron ("cron", local time). Runs while the gateway or the desktop app is running.',
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
