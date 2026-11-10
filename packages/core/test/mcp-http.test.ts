import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { McpManager } from '../src/mcp.js';

function echoServer() {
  const server = new McpServer({ name: 'loopback-echo', version: '1.0.0' });
  server.registerTool('echo', { inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: 'text', text: `echo: ${text}` }],
  }));
  return server;
}

it('connects authenticated HTTP and legacy SSE, invokes tools, and reconnects after changing configuration', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'sun-mcp-loopback-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  mkdirSync(workspace);
  mkdirSync(join(workspace, '.git'));
  mkdirSync(home);
  vi.stubEnv('SUN_HOME', home);
  const sessionById = new Map<string, SSEServerTransport>();
  const paths = new Set<string>();
  const manager = new McpManager();
  const listener = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const handle = async () => {
      if (request.headers.authorization !== 'Bearer fixture') {
        response.writeHead(401).end();
        return;
      }
      paths.add(url.pathname);
      if (url.pathname === '/mcp' && request.method === 'POST') {
        const server = echoServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        response.once('close', () => { void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(request, response);
      } else if (url.pathname === '/sse' && request.method === 'GET') {
        const server = echoServer();
        const transport = new SSEServerTransport('/messages', response);
        sessionById.set(transport.sessionId, transport);
        response.once('close', () => { sessionById.delete(transport.sessionId); });
        await server.connect(transport);
      } else if (url.pathname === '/messages' && request.method === 'POST') {
        const transport = sessionById.get(url.searchParams.get('sessionId') ?? '');
        if (transport) await transport.handlePostMessage(request, response);
        else response.writeHead(404).end();
      } else {
        response.writeHead(405).end();
      }
    };
    void handle().catch(() => response.destroy());
  });
  try {
    const ready = once(listener, 'listening');
    listener.listen(0, '127.0.0.1');
    await ready;
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Missing fixture listener address');
    const base = `http://127.0.0.1:${address.port}`;
    const headers = { Authorization: 'Bearer fixture' };
    const http = { url: `${base}/mcp`, headers };
    const sse = { url: `${base}/sse`, type: 'sse', headers, trust: true };
    const config = join(workspace, '.mcp.json');
    writeFileSync(config, JSON.stringify({ mcpServers: { http, sse, denied: { url: http.url } } }));
    await manager.connectAll(workspace);
    expect(manager.servers.get('http')?.status).toBe('ready');
    expect(manager.servers.get('sse')?.status).toBe('ready');
    expect(manager.servers.get('denied')?.status).toBe('error');
    const context = { cwd: workspace, sessionId: 'fixture', signal: new AbortController().signal, services: {} };
    for (const [name, risk] of [['http', 'exec'], ['sse', 'read']] as const) {
      const tool = manager.listTools().find(item => item.name === `mcp__${name}__echo`);
      expect(tool?.risk).toBe(risk);
      expect(await tool?.execute({ text: name }, context)).toBe(`echo: ${name}`);
    }
    expect(paths).toEqual(new Set(['/mcp', '/sse', '/messages']));
    writeFileSync(config, JSON.stringify({ mcpServers: { http, sse: { ...sse, disabled: true } } }));
    await manager.connectAll(workspace);
    expect(manager.servers.get('sse')?.status).toBe('disabled');
    expect(manager.listTools().map(item => item.name)).toEqual(['mcp__http__echo']);
  } finally {
    await manager.closeAll();
    await Promise.all([...sessionById.values()].map(transport => transport.close()));
    listener.closeAllConnections();
    if (listener.listening) await new Promise<void>(resolve => listener.close(() => resolve()));
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
});
