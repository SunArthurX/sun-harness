import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { KnowledgeProvider } from './kb/types.js';
import type { ModeDef } from './modes.js';
import { homePath } from './paths.js';
import type { Tool } from './tools/types.js';
import type { SessionEvent } from './types.js';

export interface PluginAPI {
  readonly name: string;
  readonly settings: Record<string, unknown>;
  /** risk defaults to "exec" (asks for approval) unless the plugin declares otherwise. */
  registerTool(tool: Omit<Tool, 'source' | 'risk'> & { risk?: Tool['risk'] }): void;
  registerKnowledgeProvider(p: KnowledgeProvider): void;
  registerMode(m: ModeDef): void;
  registerPromptSection(title: string, text: string | (() => string)): void;
  /** Observe durable session events. */
  onSessionEvent(handler: (sessionId: string, event: SessionEvent) => void): void;
  log(...args: unknown[]): void;
}

export interface PluginState {
  name: string;
  dir: string;
  status: 'loaded' | 'error' | 'disabled';
  error?: string;
  contributes: { tools: string[]; modes: string[]; knowledge: string[]; prompts: string[] };
}

export interface PluginSink {
  addTool(t: Tool): void;
  addKnowledge(p: KnowledgeProvider): void;
  addMode(m: ModeDef): void;
  addPrompt(title: string, text: () => string): void;
  addListener(h: (sessionId: string, event: SessionEvent) => void): void;
}

export function pluginDirs(): string[] {
  const root = homePath('plugins');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((n) => join(root, n))
    .filter((d) => statSync(d).isDirectory());
}

function entryOf(dir: string): string | undefined {
  const pkg = join(dir, 'package.json');
  if (existsSync(pkg)) {
    const data = JSON.parse(readFileSync(pkg, 'utf8'));
    const main = data.sun?.main ?? data.main;
    if (main && existsSync(join(dir, main))) return join(dir, main);
  }
  for (const f of ['index.mjs', 'index.js']) if (existsSync(join(dir, f))) return join(dir, f);
  return undefined;
}

/** Load plugins from ~/.sun/plugins/<name>. A plugin exports `default (api) => void` or `{ activate(api) }`. */
export async function loadPlugins(
  sink: PluginSink,
  opts: { disabled: string[]; settings: Record<string, Record<string, unknown>> },
  dirs: string[] = pluginDirs(),
): Promise<PluginState[]> {
  const states: PluginState[] = [];
  for (const dir of dirs) {
    const name = dir.split(/[\\/]/).pop()!;
    const state: PluginState = { name, dir, status: 'loaded', contributes: { tools: [], modes: [], knowledge: [], prompts: [] } };
    states.push(state);
    if (opts.disabled.includes(name)) {
      state.status = 'disabled';
      continue;
    }
    try {
      const entry = entryOf(dir);
      if (!entry) throw new Error('No entry point (package.json "sun.main", index.mjs or index.js).');
      const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`);
      const activate = typeof mod.default === 'function' ? mod.default : (mod.activate ?? mod.default?.activate);
      if (typeof activate !== 'function') throw new Error('Plugin must export a default function or activate(api).');
      const api: PluginAPI = {
        name,
        settings: opts.settings[name] ?? {},
        registerTool: (t) => {
          sink.addTool({ ...t, risk: t.risk ?? 'exec', source: `plugin:${name}` });
          state.contributes.tools.push(t.name);
        },
        registerKnowledgeProvider: (p) => {
          sink.addKnowledge(p);
          state.contributes.knowledge.push(p.id);
        },
        registerMode: (m) => {
          sink.addMode(m);
          state.contributes.modes.push(m.id);
        },
        registerPromptSection: (title, text) => {
          sink.addPrompt(title, typeof text === 'function' ? text : () => text);
          state.contributes.prompts.push(title);
        },
        onSessionEvent: (h) => sink.addListener(h),
        log: (...a) => console.log(`[plugin:${name}]`, ...a),
      };
      await activate(api);
    } catch (e) {
      state.status = 'error';
      state.error = (e as Error).message;
    }
  }
  return states;
}
