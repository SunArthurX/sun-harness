import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { homePath } from './paths.js';
import { findProjectRoot } from './rules.js';
import { truncate, type Tool } from './tools/types.js';

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  type?: 'stdio' | 'http' | 'sse';
  disabled?: boolean;
  /** Trusted servers run without approval in auto-edit mode. */
  trust?: boolean;
}

export interface McpServerState {
  name: string;
  source: string;
  status: 'connecting' | 'ready' | 'error' | 'disabled';
  error?: string;
  tools: string[];
  config: McpServerConfig;
}

export function mcpConfigFiles(cwd: string): string[] {
  const root = findProjectRoot(cwd);
  return [homePath('mcp.json'), join(root, '.mcp.json'), join(root, '.sun', 'mcp.json')];
}

/** Later files override earlier ones by server name (project beats user). */
export function loadMcpConfig(cwd: string): { name: string; source: string; config: McpServerConfig }[] {
  const map = new Map<string, { name: string; source: string; config: McpServerConfig }>();
  for (const f of mcpConfigFiles(cwd)) {
    if (!existsSync(f)) continue;
    try {
      const data = JSON.parse(readFileSync(f, 'utf8'));
      for (const [name, config] of Object.entries<McpServerConfig>(data.mcpServers ?? data.servers ?? {})) map.set(name, { name, source: f, config });
    } catch {
      // Invalid file: surfaced by `sun doctor`.
    }
  }
  return [...map.values()];
}

export function mcpToolName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

export class McpManager {
  private clients = new Map<string, Client>();
  readonly servers = new Map<string, McpServerState>();
  private tools: Tool[] = [];

  async connectAll(cwd: string, onChange?: () => void): Promise<void> {
    await this.closeAll();
    const entries = loadMcpConfig(cwd);
    await Promise.all(
      entries.map(async ({ name, source, config }) => {
        const state: McpServerState = { name, source, config, status: config.disabled ? 'disabled' : 'connecting', tools: [] };
        this.servers.set(name, state);
        if (config.disabled) return;
        const client = new Client({ name: 'sun-harness', version: '0.1.0' });
        try {
          const transport = config.url
            ? config.type === 'sse'
              ? new SSEClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
              : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
            : new StdioClientTransport({
                command: config.command!,
                args: config.args ?? [],
                env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) },
                cwd: config.cwd ?? cwd,
                stderr: 'ignore',
              });
          let deadline: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              client.connect(transport),
              new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('connect timeout (30s)')), 30_000); }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
          const { tools } = await client.listTools();
          for (const t of tools) {
            this.tools.push({
              name: mcpToolName(name, t.name),
              description: `[MCP ${name}] ${t.description ?? t.name}`.slice(0, 1024),
              parameters: (t.inputSchema as any) ?? { type: 'object', properties: {} },
              risk: config.trust ? 'read' : 'exec',
              source: `mcp:${name}`,
              execute: async (args) => {
                const r: any = await client.callTool({ name: t.name, arguments: args ?? {} });
                const text = (r.content ?? [])
                  .map((c: any) => (c.type === 'text' ? c.text : c.type === 'resource' ? (c.resource?.text ?? c.resource?.uri) : `[${c.type}]`))
                  .join('\n');
                if (r.isError) throw new Error(text || 'MCP tool error');
                return truncate(text || JSON.stringify(r.structuredContent ?? r));
              },
            });
            state.tools.push(t.name);
          }
          this.clients.set(name, client);
          state.status = 'ready';
        } catch (e) {
          await client.close().catch(() => undefined);
          state.status = 'error';
          state.error = (e as Error).message;
        }
        onChange?.();
      }),
    );
  }

  listTools(): Tool[] {
    return this.tools;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => undefined)));
    this.clients.clear();
    this.servers.clear();
    this.tools = [];
  }
}
