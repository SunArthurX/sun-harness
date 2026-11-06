import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnthropicProvider, OpenAICompatProvider, ProviderError, classifyHttpError, parseModelRef } from '../src/index.js';

let server: Server;
let base = '';
let mode: 'openai' | 'anthropic' | 'quota' | 'glm-quota' = 'openai';
let lastBody: any;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      lastBody = JSON.parse(body || '{}');
      if (mode === 'quota') {
        res.writeHead(402, { 'content-type': 'application/json' });
        return res.end('{"error":{"message":"Insufficient Balance"}}');
      }
      if (mode === 'glm-quota') {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end('{"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}');
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (o: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(o)}\n\n`);
      if (mode === 'openai') {
        send({ choices: [{ delta: { reasoning_content: 'think ' } }] });
        send({ choices: [{ delta: { content: 'Hel' } }] });
        send({ choices: [{ delta: { content: 'lo' } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_', arguments: '{"pa' } }] } }] });
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"a"}' } }] }, finish_reason: 'tool_calls' }] });
        send({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5 } });
        res.write('data: [DONE]\n\n');
      } else {
        send({ type: 'message_start', message: { usage: { input_tokens: 7 } } }, 'message_start');
        send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
        send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } });
        send({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'bash' } });
        send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } });
        send({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } });
        send({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } });
      }
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

afterAll(() => server.close());

describe('providers', () => {
  it('OpenAI-compatible: streams text, reasoning, and assembles tool calls', async () => {
    mode = 'openai';
    const p = new OpenAICompatProvider({ id: 'x', baseUrl: base, apiKey: 'k' });
    const deltas: string[] = [];
    const r = await p.complete({
      model: 'm',
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't0', name: 'list_dir', arguments: '{}' }] },
        { role: 'tool', toolCallId: 't0', name: 'list_dir', content: 'a\nb' },
      ],
      tools: [{ name: 'read_file', description: 'd', parameters: { type: 'object' } }],
      onDelta: (d) => d.text && deltas.push(d.text),
    });
    expect(r.text).toBe('Hello');
    expect(r.reasoning).toBe('think ');
    expect(r.toolCalls).toEqual([{ id: 'call_1', name: 'read_file', arguments: '{"path":"a"}' }]);
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(lastBody.messages[0]).toEqual({ role: 'system', content: 'sys' });
    expect(lastBody.messages[2].tool_calls[0].function.name).toBe('list_dir');
    expect(lastBody.messages[3]).toEqual({ role: 'tool', tool_call_id: 't0', content: 'a\nb' });
  });

  it('Anthropic: streams text and tool_use blocks; merges tool results into user turns', async () => {
    mode = 'anthropic';
    const p = new AnthropicProvider({ id: 'a', baseUrl: base, apiKey: 'k' });
    const r = await p.complete({
      model: 'claude',
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'x', toolCalls: [{ id: 't1', name: 'a', arguments: '{}' }, { id: 't2', name: 'b', arguments: '{}' }] },
        { role: 'tool', toolCallId: 't1', name: 'a', content: '1' },
        { role: 'tool', toolCallId: 't2', name: 'b', content: '2' },
      ],
      tools: [],
    });
    expect(r.text).toBe('Hi');
    expect(r.toolCalls).toEqual([{ id: 'tu_1', name: 'bash', arguments: '{"command":"ls"}' }]);
    expect(r.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(lastBody.messages).toHaveLength(3);
    expect(lastBody.messages[2].content.map((c: any) => c.type)).toEqual(['tool_result', 'tool_result']);
  });

  it('classifies quota errors (DeepSeek 402, GLM 429 余额不足) as quota', async () => {
    for (const m of ['quota', 'glm-quota'] as const) {
      mode = m;
      const p = new OpenAICompatProvider({ id: 'x', baseUrl: base });
      const err = await p.complete({ model: 'm', system: '', messages: [{ role: 'user', content: 'x' }], tools: [] }).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect(err.kind).toBe('quota');
    }
  });

  it('classifies HTTP errors', () => {
    expect(classifyHttpError(429, 'Too many requests', '3')).toMatchObject({ kind: 'rate_limit', retryAfterMs: 3000 });
    expect(classifyHttpError(429, 'You exceeded your current quota').kind).toBe('quota');
    expect(classifyHttpError(401, 'invalid api key').kind).toBe('auth');
    expect(classifyHttpError(400, "This model's maximum context length is 128000").kind).toBe('context_length');
    expect(classifyHttpError(503, 'unavailable').kind).toBe('network');
    expect(classifyHttpError(400, 'bad').kind).toBe('other');
  });

  it('network failures become retryable network errors', async () => {
    const p = new OpenAICompatProvider({ id: 'x', baseUrl: 'http://127.0.0.1:1' });
    const err = await p.complete({ model: 'm', system: '', messages: [], tools: [] }).catch((e) => e);
    expect(err.kind).toBe('network');
  });

  it('parses model refs', () => {
    expect(parseModelRef('openrouter/anthropic/claude')).toEqual({ provider: 'openrouter', model: 'anthropic/claude' });
    expect(parseModelRef('deepseek-chat')).toEqual({ provider: 'deepseek', model: 'deepseek-chat' });
  });
});
