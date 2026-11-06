import type { JsonSchema, TodoItem, ToolRisk, ToolSchema } from '../types.js';

export interface ToolServices {
  /** Durable todo update (logged as todo/update). */
  setTodos?(items: TodoItem[]): void;
  kbSearch?(query: string, k?: number, provider?: string): Promise<string>;
  kbAdd?(title: string, text: string): Promise<string>;
  memorySave?(fact: string, section?: string): Promise<string>;
  loadSkill?(name: string): Promise<string>;
  runSubagent?(prompt: string, opts: { mode?: string }): Promise<string>;
  scheduleTask?(spec: { prompt: string; at?: string; cron?: string; title?: string }): Promise<string>;
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
  execute(args: any, ctx: ToolContext): Promise<string>;
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
