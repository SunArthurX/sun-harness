import { runHook, type HookRunOptions, type HookRunResult } from './hook-process.js';
import type { AgentHooks } from './agent.js';
import { HOOK_TOOL_NAME_LIMIT, hookMatches, inspectHooks, type HookDefinition, type HookEntry, type HookEvent, type HooksConfig } from './hook-config.js';

export { runHook } from './hook-process.js';
export type { HookRunOptions, HookRunResult, HookRunState } from './hook-process.js';
export { HOOK_EVENTS, inspectHooks, reviewHookTrust } from './hook-config.js';
export type { HookDefinition, HookDiagnostic, HookEntry, HookEvent, HookInspection, HooksConfig, HookTrustChange } from './hook-config.js';

export function loadHooks(cwd: string): HooksConfig {
  const config: HooksConfig = {};
  for (const hook of inspectHooks(cwd).hooks) {
    (config[hook.event] ??= []).push({
      id: hook.explicitId, enabled: hook.status !== 'disabled', command: hook.command, matcher: hook.matcher,
      timeoutMs: hook.timeoutMs, onFailure: hook.onFailure,
    });
  }
  return config;
}

export const HOOK_FIXTURES = ['read', 'shell', 'edit'] as const;
export type HookFixture = typeof HOOK_FIXTURES[number];

export interface HookFixtureRequest {
  cwd: string;
  id: string;
  digest: string;
  fixture: HookFixture;
  execute?: boolean;
  requestId?: string;
}

export interface HookFixtureResult {
  hook: HookDefinition;
  sandbox: string;
  payload: Record<string, unknown>;
  matches: boolean;
  execution?: HookRunResult;
}

export function hookFixturePayload(event: HookEvent, fixture: HookFixture, cwd: string): Record<string, unknown> {
  const base = { event, sessionId: 'hook-fixture', cwd };
  if (event === 'sessionStart') return base;
  if (event === 'stop') return { ...base, lastText: 'Synthetic fixture response.' };
  const tool = fixture === 'shell' ? { tool: 'bash', args: { command: 'printf "fixture"' } }
    : fixture === 'edit' ? { tool: 'write_file', args: { path: 'fixture.txt', content: 'synthetic fixture' } }
    : { tool: 'list_dir', args: { path: '.' } };
  return { ...base, ...tool, ...(event === 'postToolUse' ? { output: 'Synthetic fixture tool output.' } : {}) };
}

export interface ShellHookOptions {
  runOptions?: () => HookRunOptions;
  onRun?: (hook: HookDefinition, result: HookRunResult) => void;
}

export function createShellHooks(cwd: string, options: ShellHookOptions = {}): AgentHooks & { sessionStart(sessionId: string, signal?: AbortSignal): Promise<string> } {
  const invoke = async (hook: HookDefinition, payload: unknown, signal?: AbortSignal) => {
    const result = await runHook(hook, payload, cwd, { ...options.runOptions?.(), signal });
    options.onRun?.(hook, result);
    return result;
  };
  const initial = inspectHooks(cwd).hooks.filter(hook =>
    hook.event === 'preToolUse' && hook.onFailure === 'block' && hook.status !== 'disabled');
  const trusted = (event: HookEvent, tool?: string) => inspectHooks(cwd).hooks.filter(hook =>
    hook.event === event && !hook.worktreeSetup && hook.status === 'trusted' && (tool === undefined || hookMatches(hook.matcher, tool)));
  const stillTrusted = (hook: HookDefinition) => inspectHooks(cwd).hooks.some(current =>
    current.id === hook.id && current.digest === hook.digest && current.status === 'trusted');
  const matchesPolicy = (matcher: string | undefined, tool: string) => tool.length > HOOK_TOOL_NAME_LIMIT || hookMatches(matcher, tool);
  return {
    async sessionStart(sessionId, signal) {
      const outs: string[] = [];
      for (const h of trusted('sessionStart')) {
        if (signal?.aborted) break;
        if (!stillTrusted(h)) continue;
        const r = await invoke(h, { event: 'sessionStart', sessionId, cwd }, signal);
        if (r.code === 0 && r.stdout) outs.push(r.stdout);
      }
      return outs.join('\n');
    },
    async preToolUse(e, signal) {
      const current = inspectHooks(cwd);
      if (current.diagnostics.some(issue => issue.policy && matchesPolicy(issue.matcher, e.tool))) {
        return { block: 'Policy hook configuration is invalid; failing closed.' };
      }
      const active = current.hooks.filter(hook => hook.event === 'preToolUse' && hook.status !== 'disabled');
      if (initial.some(prior => matchesPolicy(prior.matcher, e.tool)
        && !active.some(hook => hook.id === prior.id && hook.digest === prior.digest))) {
        return { block: 'Policy hook configuration changed during the run; failing closed.' };
      }
      for (const h of active) {
        if (signal?.aborted) break;
        if (h.onFailure === 'block' && matchesPolicy(h.matcher, e.tool)
          && (h.status !== 'trusted' || (h.matcher && e.tool.length > HOOK_TOOL_NAME_LIMIT))) {
          return { block: 'Policy hook is not trusted or its matcher cannot be evaluated; failing closed.' };
        }
        if (h.status !== 'trusted' || !hookMatches(h.matcher, e.tool)) continue;
        if (!stillTrusted(h)) {
          if (h.onFailure === 'block') return { block: 'Policy hook trust changed during dispatch; failing closed.' };
          continue;
        }
        const r = await invoke(h, { event: 'preToolUse', ...e }, signal);
        if (r.code === 2) return { block: r.stderr || r.stdout || 'blocked' };
        if (r.code !== 0 && h.onFailure === 'block') return { block: `policy hook failed (exit ${r.code}, ${r.state}${r.stderr ? `: ${r.stderr.slice(0, 200)}` : ''}); failing closed` };
      }
    },
    async postToolUse(e, signal) {
      const outs: string[] = [];
      for (const h of trusted('postToolUse', e.tool)) {
        if (signal?.aborted) break;
        if (!stillTrusted(h)) continue;
        const r = await invoke(h, { event: 'postToolUse', ...e, output: e.output.slice(0, 20_000) }, signal);
        if (r.code === 0 && r.stdout) outs.push(r.stdout);
        if (r.code === 2) outs.push(`Hook feedback: ${r.stderr || r.stdout}`);
      }
      return outs.join('\n') || undefined;
    },
    async stop(e, signal) {
      for (const h of trusted('stop')) {
        if (signal?.aborted) break;
        if (!stillTrusted(h)) continue;
        const r = await invoke(h, { event: 'stop', ...e }, signal);
        if (r.code === 2) return r.stderr || r.stdout || 'A stop hook asked you to continue.';
      }
    },
  };
}
