import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ensureDir, homePath, sunHome } from '../paths.js';
import type { Tool } from '../tools/types.js';
import type { JsonSchema } from '../types.js';

// ---------------- DingTalk (dws CLI) ----------------

const READ_VERBS = /^(list|ls|get|search|query|show|status|info|detail|details|help|--help|-h|recent|unread|stat|stats|read|view|export|download|free-busy|freebusy|busy|version|whoami|me|tree|members|history|preview|summary|transcript|count)$/i;
const WRITE_VERBS = /^(send|create|new|add|update|edit|modify|delete|del|rm|remove|approve|agree|reject|refuse|revoke|recall|cancel|post|reply|forward|upload|move|mv|copy|cp|rename|set|invite|join|leave|kick|ding|submit|transfer|publish|archive|restore|start|stop|install|uninstall|finish|done|complete|assign|import|book|reserve|comment|mark|login|logout)$/i;

/** A dws invocation is read-only when it names a read verb and no write verb (unknown verbs count as writes). */
export function dwsIsRead(args: string[]): boolean {
  const words = args.filter((a) => !a.startsWith('--') || a === '--help');
  if (words.some((w) => WRITE_VERBS.test(w))) return false;
  return words.some((w) => READ_VERBS.test(w));
}

const dwsProbes = new Map<string, { ok: boolean; at: number }>();

function dwsReady(bin: string): boolean {
  const hit = dwsProbes.get(bin);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  let ok = false;
  const r = spawnSync(bin, ['auth', 'status'], { encoding: 'utf8', timeout: 10_000 });
  if (r.status === 0) {
    try {
      ok = JSON.parse(r.stdout).authenticated === true;
    } catch {
      ok = /authenticated["']?\s*:\s*true|已登录/.test(r.stdout);
    }
  }
  dwsProbes.set(bin, { ok, at: Date.now() });
  return ok;
}

function runDws(bin: string, args: string[], signal: AbortSignal): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: { ...process.env, NO_COLOR: '1' } });
    let out = '';
    const add = (d: Buffer) => (out = (out + d.toString()).slice(-200_000));
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    const kill = () => child.kill('SIGKILL');
    const t = setTimeout(kill, 120_000);
    signal.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      clearTimeout(t);
      signal.removeEventListener('abort', kill);
      resolve(`${out.trim() || '(no output)'}${code ? `\n[exit ${code}]` : ''}`);
    });
    child.on('error', (e) => resolve(`Failed to start dws: ${e.message}`));
  });
}

/** DingTalk through the DingTalk Workspace CLI: a read tool (no side effects) and a write tool (passes approval). */
export function dingtalkTools(bin = 'dws'): Tool[] {
  const available = async () => dwsReady(bin);
  const params: JsonSchema = {
    type: 'object',
    properties: { args: { type: 'array', items: { type: 'string' }, description: 'dws arguments, e.g. ["calendar", "event", "list"]' } },
    required: ['args'],
  };
  const usage =
    'DingTalk Workspace CLI (dws): calendar, todo, chat messages, mail, docs, drive, approvals (oa), attendance, minutes, contacts. Discover commands with args ["<service>", "--help"]. Load a dingtalk-* skill first when one matches the task.';
  return [
    {
      name: 'dingtalk_read',
      description: `${usage} Read-only commands only (list, get, search, query, show, …).`,
      parameters: params,
      risk: 'read',
      source: 'builtin',
      untrusted: true,
      available,
      async execute(a, ctx) {
        const args = (a.args ?? []).map(String);
        if (!dwsIsRead(args)) throw new Error('This dws command may change data; use dingtalk_write for it.');
        return runDws(bin, args, ctx.signal);
      },
    },
    {
      name: 'dingtalk_write',
      description: `${usage} Commands that change data or notify people (send, create, update, approve, …). The user approves each call.`,
      parameters: params,
      risk: 'network',
      source: 'builtin',
      untrusted: true,
      available,
      execute: (a, ctx) => runDws(bin, (a.args ?? []).map(String), ctx.signal),
    },
  ];
}

// ---------------- MCP presets (email, calendar) ----------------

export interface McpPreset {
  description: string;
  config: { command: string; args: string[]; env?: Record<string, string> };
  setup: string;
}

/** Community MCP servers for mail and calendars; their tools are marked untrusted when added. */
export const MCP_PRESETS: Record<string, McpPreset> = {
  gmail: {
    description: 'Gmail: search, read, draft, send, labels',
    config: { command: 'npx', args: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'] },
    setup: 'Create a Google Cloud OAuth client (Desktop app), save it as ~/.gmail-mcp/gcp-oauth.keys.json, then run: npx -y @gongrzhe/server-gmail-autoauth-mcp auth',
  },
  'google-calendar': {
    description: 'Google Calendar: list, create, update events; free/busy',
    config: { command: 'npx', args: ['-y', '@cocal/google-calendar-mcp'], env: { GOOGLE_OAUTH_CREDENTIALS: '~/.config/google-calendar-mcp/gcp-oauth.keys.json' } },
    setup: 'Create a Google Cloud OAuth client (Desktop app) and save the JSON at the path in GOOGLE_OAUTH_CREDENTIALS; the first call opens a browser to sign in.',
  },
  outlook: {
    description: 'Microsoft 365 / Outlook: mail, calendar, contacts, OneDrive',
    config: { command: 'npx', args: ['-y', '@softeria/ms-365-mcp-server'] },
    setup: 'Run: npx -y @softeria/ms-365-mcp-server --login (device code sign-in).',
  },
  apple: {
    description: 'macOS apps: Mail, Calendar, Reminders, Notes, Contacts, Messages',
    config: { command: 'npx', args: ['-y', '@dhravya/apple-mcp@latest'] },
    setup: 'macOS only. Grant automation permissions when macOS asks.',
  },
};

/** Add a preset to ~/.sun/mcp.json and mark its tools as untrusted content. Returns the setup hint. */
export function addMcpPreset(name: string, saveTaint: (globs: string[]) => void): string {
  const p = MCP_PRESETS[name];
  if (!p) throw new Error(`Unknown preset ${name}. Presets: ${Object.keys(MCP_PRESETS).join(', ')}`);
  ensureDir(sunHome());
  const file = homePath('mcp.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  data.mcpServers = { ...(data.mcpServers ?? {}), [name]: p.config };
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  saveTaint([`mcp__${name.replace(/[^a-zA-Z0-9_-]/g, '_')}__*`]);
  return p.setup;
}
