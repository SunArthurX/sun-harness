import { randomUUID } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KnowledgeProvider } from './kb/types.js';
import type { ModeDef } from './modes.js';
import { homePath } from './paths.js';
import type { CapabilityStatus } from './settings/types.js';
import type { Tool } from './tools/types.js';
import type { SessionEvent } from './types.js';

export const PLUGIN_ACTIONS = ['tools', 'knowledge', 'modes', 'prompts', 'session-events', 'filesystem', 'network', 'processes'] as const;
export type PluginAction = typeof PLUGIN_ACTIONS[number];
export type PluginListener = (sessionId: string, event: SessionEvent) => unknown;

export interface PluginAPI {
  readonly name: string;
  readonly settings: Record<string, unknown>;
  /** risk defaults to "exec" (asks for approval) unless the plugin declares otherwise. */
  registerTool(tool: Omit<Tool, 'source' | 'risk'> & { risk?: Tool['risk'] }): void;
  registerKnowledgeProvider(p: KnowledgeProvider): void;
  registerMode(m: ModeDef): void;
  registerPromptSection(title: string, text: string | (() => string)): void;
  /** Observe durable session events. */
  onSessionEvent(handler: PluginListener): void;
  log(...args: unknown[]): void;
}

export interface PluginState {
  name: string;
  status: 'loaded' | 'error' | 'disabled' | 'draining' | 'inactive';
  enabled: boolean;
  inFlight: number;
  manifest: 'declared' | 'undeclared' | 'invalid';
  requestedActions: PluginAction[];
  lifecycleAudit?: 'incomplete';
  error?: 'INVALID_MANIFEST' | 'NO_ENTRY' | 'ACTIVATION_FAILED';
  contributes: { tools: string[]; modes: string[]; knowledge: string[]; prompts: string[] };
}

export interface PluginEnableRequest {
  name: string;
  enabled: boolean;
  expectedRevision: string;
}

export function pluginCapability(plugin: PluginState): CapabilityStatus {
  const states = {
    loaded: { state: 'available' },
    error: { state: 'error', reasonCode: plugin.error === 'INVALID_MANIFEST' ? 'PLUGIN_INVALID_MANIFEST' : 'PLUGIN_ACTIVATION_FAILED' },
    disabled: { state: 'disabled', reasonCode: 'FEATURE_DISABLED' },
    draining: { state: 'disabled', reasonCode: 'PLUGIN_DRAINING' },
    inactive: { state: 'unavailable', reasonCode: 'PLUGIN_NOT_ACTIVE' },
  } as const;
  return {
    id: `extension.plugin.${encodeURIComponent(plugin.name)}`,
    owner: 'extension',
    ...states[plugin.status],
    surface: ['desktop', 'web', 'cli'],
    configKeys: ['plugins.disabled'],
  };
}

export interface PluginSink {
  addTool(t: Tool): void;
  addKnowledge(p: KnowledgeProvider): void;
  addMode(m: ModeDef): void;
  addPrompt(title: string, text: () => string): void;
  addListener(h: PluginListener): void;
}

export function pluginDirs(): string[] {
  const root = homePath('plugins');
  try {
    return readdirSync(root, { withFileTypes: true }).filter(entry => {
      if (!entry.isSymbolicLink()) return entry.isDirectory();
      try { return statSync(join(root, entry.name)).isDirectory(); }
      catch { return false; }
    }).map(entry => join(root, entry.name)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

const MAX_MANIFEST_BYTES = 64 * 1024;

function readManifest(dir: string): string | undefined {
  let fd: number;
  try {
    fd = openSync(join(dir, 'package.json'), constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Invalid plugin manifest size or type.');
    const bytes = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > MAX_MANIFEST_BYTES) throw new Error('Invalid plugin manifest size.');
    return bytes.toString('utf8', 0, size);
  } finally {
    closeSync(fd);
  }
}

function inspect(dir: string): { state: PluginState; main?: string } {
  const state: PluginState = {
    name: basename(dir), status: 'inactive', enabled: true, inFlight: 0, manifest: 'undeclared', requestedActions: [],
    contributes: { tools: [], modes: [], knowledge: [], prompts: [] },
  };
  try {
    const raw = readManifest(dir);
    if (raw === undefined) return { state };
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid plugin manifest.');
    const actions: unknown = data.sun?.requestedActions;
    if (actions !== undefined) {
      if (!Array.isArray(actions) || actions.length > PLUGIN_ACTIONS.length || new Set(actions).size !== actions.length
        || !actions.every(action => PLUGIN_ACTIONS.includes(action))) throw new Error('Invalid plugin action declaration.');
      state.manifest = 'declared';
      state.requestedActions = actions;
    }
    const main: unknown = data.sun?.main ?? data.main;
    return { state, main: typeof main === 'string' ? main : undefined };
  } catch {
    return { state: { ...state, status: 'error', manifest: 'invalid', error: 'INVALID_MANIFEST' } };
  }
}

export function inspectPlugin(dir: string, disabled: boolean): PluginState {
  const { state } = inspect(dir);
  return disabled ? { ...state, enabled: false, status: 'disabled' } : state;
}

function entryOf(dir: string, main?: string): string | undefined {
  if (main && existsSync(join(dir, main))) return join(dir, main);
  for (const f of ['index.mjs', 'index.js']) if (existsSync(join(dir, f))) return join(dir, f);
  return undefined;
}

/** Load plugins from ~/.sun/plugins/<name>. A plugin exports `default (api) => void` or `{ activate(api) }`. */
export async function loadPlugins(
  sink: PluginSink,
  opts: { disabled: string[]; settings: Record<string, Record<string, unknown>>; canActivate?: () => boolean },
  dirs: string[] = pluginDirs(),
): Promise<PluginState[]> {
  const states: PluginState[] = [];
  for (const dir of dirs) {
    const { state, main } = inspect(dir);
    const { name } = state;
    states.push(state);
    if (opts.disabled.includes(name) || opts.canActivate?.() === false) {
      state.enabled = false;
      state.status = 'disabled';
      continue;
    }
    if (state.error) continue;
    const entry = entryOf(dir, main);
    if (!entry) {
      state.status = 'error';
      state.error = 'NO_ENTRY';
      continue;
    }
    try {
      const mod = await import(pathToFileURL(entry).href + `?activation=${randomUUID()}`);
      if (opts.canActivate?.() === false) continue;
      const activate = typeof mod.default === 'function' ? mod.default : (mod.activate ?? mod.default?.activate);
      if (typeof activate !== 'function') throw new Error('Plugin must export a default function or activate(api).');
      const contributions: (() => void)[] = [];
      let activating = true;
      const stage = (contribution: () => void) => {
        if (!activating) throw new Error('Plugin registration must finish during activation.');
        contributions.push(contribution);
      };
      const api: PluginAPI = {
        name,
        settings: Object.hasOwn(opts.settings, name) ? opts.settings[name] : {},
        registerTool: (t) => {
          const tool: Tool = { ...t, risk: t.risk ?? 'exec', source: `plugin:${name}` };
          stage(() => {
            sink.addTool(tool);
            state.contributes.tools.push(tool.name);
          });
        },
        registerKnowledgeProvider: (p) => stage(() => {
          sink.addKnowledge(p);
          state.contributes.knowledge.push(p.id);
        }),
        registerMode: (m) => stage(() => {
          sink.addMode(m);
          state.contributes.modes.push(m.id);
        }),
        registerPromptSection: (title, text) => stage(() => {
          sink.addPrompt(title, typeof text === 'function' ? text : () => text);
          state.contributes.prompts.push(title);
        }),
        onSessionEvent: (h) => stage(() => sink.addListener(h)),
        log: (...a) => console.log(`[plugin:${name}]`, ...a),
      };
      try {
        await activate(api);
      } finally {
        activating = false;
      }
      if (opts.canActivate?.() !== false) {
        for (const contribute of contributions) contribute();
        state.status = 'loaded';
      }
    } catch {
      state.status = 'error';
      state.error = 'ACTIVATION_FAILED';
    }
  }
  return states;
}
