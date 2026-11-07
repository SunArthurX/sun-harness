import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '1.0.0' });
server.registerTool('echo', { description: 'Echo text back', inputSchema: { text: z.string() } }, async ({ text }) => ({
  content: [{ type: 'text', text: `echo: ${text}` }],
}));
server.registerTool('slow', { description: 'Answer after a delay', inputSchema: { ms: z.number() } }, async ({ ms }) => {
  await new Promise((r) => setTimeout(r, ms));
  return { content: [{ type: 'text', text: `slow done after ${ms}ms` }] };
});
await server.connect(new StdioServerTransport());
