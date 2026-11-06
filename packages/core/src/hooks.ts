import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentHooks } from './agent.js';
import { homePath } from './paths.js';
import { findProjectRoot } from './rules.js';

export interface HookEntry {
  /** Regex on tool name (tool hooks only). */
  matcher?: string;
  command: string;
  timeoutMs?: number;
}

export interface HooksConfig {
  sessionStart?: HookEntry[];
  preToolUse?: HookEntry[];
  postToolUse?: HookEntry[];
  stop?: HookEntry[];
}

export function loadHooks(cwd: string): HooksConfig {
  const out: HooksConfig = {};
  for (const f of [homePath('hooks.json'), join(findProjectRoot(cwd), '.sun', 'hooks.json')]) {
    if (!existsSync(f)) continue;
    try {
      const data = JSON.parse(readFileSync(f, 'utf8')) as HooksConfig;
      for (const k of ['sessionStart', 'preToolUse', 'postToolUse', 'stop'] as const) {
        if (data[k]) out[k] = [...(out[k] ?? []), ...data[k]!];
      }
    } catch {
      // Invalid hooks file is ignored (reported by doctor).
    }
  }
  return out;
}

/**
 * Run a hook command with the event JSON on stdin.
 * Exit 0 = ok (stdout is extra context); exit 2 = block (stderr/stdout is the reason); other = ignored warning.
 */
export function runHook(entry: HookEntry, payload: unknown, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-c', entry.command], { cwd, env: { ...process.env, SUN_HOOK: '1' } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const t = setTimeout(() => child.kill('SIGKILL'), entry.timeoutMs ?? 30_000);
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on('error', () => resolve({ code: 1, stdout: '', stderr: 'spawn failed' }));
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createShellHooks(cwd: string): AgentHooks & { sessionStart(sessionId: string): Promise<string> } {
  const cfg = loadHooks(cwd);
  const match = (entries: HookEntry[] | undefined, tool?: string) =>
    (entries ?? []).filter((h) => !h.matcher || !tool || new RegExp(h.matcher).test(tool));
  return {
    async sessionStart(sessionId) {
      const outs: string[] = [];
      for (const h of match(cfg.sessionStart)) {
        const r = await runHook(h, { event: 'sessionStart', sessionId, cwd }, cwd);
        if (r.code === 0 && r.stdout) outs.push(r.stdout);
      }
      return outs.join('\n');
    },
    async preToolUse(e) {
      for (const h of match(cfg.preToolUse, e.tool)) {
        const r = await runHook(h, { event: 'preToolUse', ...e }, e.cwd);
        if (r.code === 2) return { block: r.stderr || r.stdout || 'blocked' };
      }
    },
    async postToolUse(e) {
      const outs: string[] = [];
      for (const h of match(cfg.postToolUse, e.tool)) {
        const r = await runHook(h, { event: 'postToolUse', ...e, output: e.output.slice(0, 20_000) }, e.cwd);
        if (r.code === 0 && r.stdout) outs.push(r.stdout);
        if (r.code === 2) outs.push(`Hook feedback: ${r.stderr || r.stdout}`);
      }
      return outs.join('\n') || undefined;
    },
    async stop(e) {
      for (const h of match(cfg.stop)) {
        const r = await runHook(h, { event: 'stop', ...e }, e.cwd);
        if (r.code === 2) return r.stderr || r.stdout || 'A stop hook asked you to continue.';
      }
    },
  };
}
