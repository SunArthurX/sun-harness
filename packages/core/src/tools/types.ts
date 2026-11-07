import type { JsonSchema, TodoItem, ToolRisk, ToolSchema } from '../types.js';

export interface ToolServices {
  /** Read-before-edit bookkeeping for this session. */
  fileState?: import('./edit.js').FileState;
  /** Snapshot files (absolute paths) before they are modified, for undo. */
  checkpoint?(paths: string[]): void;
  /** Durable todo update (logged as todo/update). */
  setTodos?(items: TodoItem[]): void;
  kbSearch?(query: string, k?: number, provider?: string): Promise<string>;
  kbAdd?(title: string, text: string): Promise<string>;
  memorySave?(fact: string, section?: string): Promise<string>;
  /** Long-term memory layer (recalled by relevance, not always in the prompt). */
  memoryRemember?(fact: string, kind?: string): Promise<string>;
  memorySearch?(query: string): Promise<string>;
  loadSkill?(name: string): Promise<string>;
  runSubagent?(prompt: string, opts: { mode?: string }): Promise<string>;
  scheduleTask?(spec: { prompt: string; at?: string; cron?: string; title?: string }): Promise<string>;
  /** Start a background shell job; its result is delivered to the session when it ends. */
  startJob?(command: string, cwd: string): string;
  jobStatus?(id?: string): string;
  killJob?(id: string): string;
  /** Language servers for post-edit diagnostics. */
  lsp?: import('../lsp.js').LspConfig;
  /** Shell sandbox for this session (bash, jobs). */
  sandbox?: import('../sandbox.js').ExecSandbox;
  /** Plan mode: record the approved plan and switch the session to coding mode. */
  exitPlanMode?(plan: string): string;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  services: ToolServices;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  risk: ToolRisk;
  /** builtin | mcp:<server> | plugin:<name> */
  source: string;
  /** Restrict to modes; undefined = all modes. */
  modes?: string[];
  /** For write tools: which argument holds the target path (used by the path guard). */
  pathArg?: string;
  /** For write tools touching several files (apply_patch): all target paths. */
  paths?(args: any): string[];
  execute(args: any, ctx: ToolContext): Promise<string>;
  /**
   * Capability gating: tools that depend on something external report whether it works right now.
   * Unavailable tools are not offered to the model (a dead tool invites endless retries).
   */
  available?(): Promise<boolean>;
  /** Output is external content (web, browser, …): wrapped as untrusted and scanned for prompt injection. */
  untrusted?: boolean;
}

export function toSchema(t: Tool): ToolSchema {
  return { name: t.name, description: t.description, parameters: t.parameters };
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): () => void {
    this.tools.set(tool.name, tool);
    return () => {
      if (this.tools.get(tool.name) === tool) this.tools.delete(tool.name);
    };
  }

  unregisterSource(source: string): void {
    for (const [k, t] of this.tools) if (t.source === source) this.tools.delete(k);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(mode?: string, allow?: (t: Tool) => boolean): Tool[] {
    return [...this.tools.values()].filter((t) => (!mode || !t.modes || t.modes.includes(mode)) && (!allow || allow(t)));
  }
}

const MAX_OUTPUT = 40_000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  if (text.length <= max) return text;
  const head = text.slice(0, Math.floor(max * 0.7));
  const tail = text.slice(-Math.floor(max * 0.25));
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters truncated ...]\n\n${tail}`;
}
