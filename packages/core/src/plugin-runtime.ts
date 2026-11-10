import { basename } from 'node:path';
import type { SunConfig } from './config.js';
import type { KnowledgeProvider } from './kb/types.js';
import { BUILTIN_MODES, type ModeDef } from './modes.js';
import { homePath } from './paths.js';
import { inspectPlugin, loadPlugins, pluginDirs, type PluginListener, type PluginState } from './plugins.js';
import type { Tool } from './tools/types.js';
import type { SessionEvent } from './types.js';

interface Registrations {
  tools: Tool[];
  knowledge: KnowledgeProvider[];
  modes: ModeDef[];
  prompts: { title: string; text: () => string }[];
  listeners: PluginListener[];
}

type Lifecycle = { name: string; status: 'draining' | 'disabled'; inFlight: number };

export class PluginRuntime {
  private readonly active = new Map<string, Registrations>();
  private readonly states = new Map<string, PluginState>();
  private readonly running = new Map<string, number>();
  private readonly draining = new Set<string>();
  private readonly auditFailures = new Set<string>();
  readonly modes = new Map(BUILTIN_MODES.map(mode => [mode.id, mode]));
  started = false;

  constructor(
    private readonly config: () => SunConfig['plugins'],
    private readonly record: (event: Lifecycle) => void,
    private readonly changed: () => void,
  ) {}

  list(): PluginState[] {
    const dirs = new Set(pluginDirs());
    // Installed folders can disappear while the previous generation is still in use.
    for (const name of [...this.active.keys(), ...this.running.keys()]) dirs.add(homePath('plugins', name));
    return [...dirs].sort().map(dir => {
      const name = basename(dir);
      const enabled = this.enabled(name);
      const inFlight = this.running.get(name) ?? 0;
      const state = (enabled && this.states.get(name)) || inspectPlugin(dir, !enabled);
      return {
        ...state, enabled, inFlight,
        status: enabled ? state.status : inFlight > 0 ? 'draining' : 'disabled',
        ...(this.auditFailures.has(name) ? { lifecycleAudit: 'incomplete' as const } : {}),
      };
    });
  }

  private enabled(name: string): boolean {
    return !this.config().disabled.includes(name);
  }

  hasInFlight(name: string): boolean {
    return this.running.has(name);
  }

  private rebuildModes(): void {
    this.modes.clear();
    for (const mode of BUILTIN_MODES) this.modes.set(mode.id, mode);
    for (const { modes } of this.active.values()) for (const mode of modes) this.modes.set(mode.id, mode);
  }

  get tools(): Tool[] {
    return [...this.active.values()].flatMap(p => p.tools);
  }

  hasTool(tool: Tool): boolean {
    if (!tool.source?.startsWith('plugin:')) return true;
    return this.active.get(tool.source.slice('plugin:'.length))?.tools.includes(tool) ?? false;
  }

  get knowledge(): KnowledgeProvider[] {
    return [...this.active.values()].flatMap(p => p.knowledge);
  }

  get prompts(): Registrations['prompts'] {
    return [...this.active.values()].flatMap(p => p.prompts);
  }

  notify(sessionId: string, event: SessionEvent): void {
    for (const { listeners } of this.active.values()) {
      for (const handler of listeners) void Promise.resolve(handler(sessionId, event)).catch(() => undefined);
    }
  }

  private audit(event: Lifecycle): boolean {
    try {
      this.record(event);
      this.auditFailures.delete(event.name);
      return true;
    } catch {
      this.auditFailures.add(event.name);
      return false;
    }
  }

  disable(name: string): boolean {
    this.active.delete(name);
    this.states.delete(name);
    this.rebuildModes();
    const inFlight = this.running.get(name) ?? 0;
    if (inFlight > 0) this.draining.add(name);
    return this.audit({ name, status: inFlight > 0 ? 'draining' : 'disabled', inFlight });
  }

  private hold(name: string): () => void {
    this.running.set(name, (this.running.get(name) ?? 0) + 1);
    return () => {
      const remaining = this.running.get(name)! - 1;
      if (remaining > 0) this.running.set(name, remaining);
      else {
        this.running.delete(name);
        if (this.draining.delete(name)) this.audit({ name, status: 'disabled', inFlight: 0 });
      }
      if (!this.enabled(name)) this.changed();
    };
  }

  async activate(dir: string): Promise<void> {
    const name = basename(dir);
    if (!this.enabled(name)) return;
    const generation: Registrations = { tools: [], knowledge: [], modes: [], prompts: [], listeners: [] };
    const isRegistered = () => this.active.get(name) === generation;
    const dispatch = async <T>(run: () => Promise<T> | T): Promise<T> => {
      if (!isRegistered()) throw new Error('CAPABILITY_DISABLED: The plugin registration was revoked.');
      const release = this.hold(name);
      try {
        return await run();
      } finally {
        release();
      }
    };
    const release = this.hold(name);
    try {
      const [state] = await loadPlugins({
        addTool: tool => generation.tools.push({
          ...tool,
          isRegistered,
          execute: (args, ctx) => dispatch(() => tool.execute(args, ctx)),
          ...(tool.available && { available: () => dispatch(() => tool.available!()) }),
        }),
        addKnowledge: provider => generation.knowledge.push({
          id: provider.id, name: provider.name,
          search: (query, k) => dispatch(() => provider.search(query, k)),
          ...(provider.add && { add: (title, text) => dispatch(() => provider.add!(title, text)) }),
          ...(provider.stats && { stats: () => dispatch(() => provider.stats!()) }),
        }),
        addMode: mode => generation.modes.push(mode),
        addPrompt: (title, text) => generation.prompts.push({ title, text }),
        addListener: handler => generation.listeners.push((id, event) => dispatch(() => handler(id, event))),
      }, { ...this.config(), canActivate: () => this.enabled(name) }, [dir]);
      if (!this.enabled(name)) return;
      this.states.set(name, state);
      if (state.status === 'loaded') {
        this.active.set(name, generation);
        this.rebuildModes();
      }
    } finally {
      release();
    }
  }

  async reload(): Promise<void> {
    this.started = true;
    this.active.clear();
    this.states.clear();
    this.rebuildModes();
    for (const dir of pluginDirs()) await this.activate(dir);
  }
}
