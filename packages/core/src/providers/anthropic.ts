import type { ChatMessage, ToolCall } from '../types.js';
import { readSse } from './sse.js';
import { streamWatchdog, classifyHttpError, toProviderError, wireArguments, type ModelRequest, type ModelResponse, type Provider } from './types.js';

export interface AnthropicOptions {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  version?: string;
}

/** Anthropic Messages API (also used by Anthropic-compatible gateways such as GLM / Kimi / DeepSeek anthropic endpoints). */
export class AnthropicProvider implements Provider {
  readonly id: string;
  constructor(private readonly opts: AnthropicOptions) {
    this.id = opts.id;
  }

  private toWire(messages: ChatMessage[]): unknown[] {
    const out: { role: string; content: unknown[] }[] = [];
    const push = (role: string, block: unknown) => {
      const last = out.at(-1);
      if (last && last.role === role) last.content.push(block);
      else out.push({ role, content: [block] });
    };
    for (const m of messages) {
      if (m.role === 'system') continue;
      if (m.role === 'user') {
        for (const i of m.images ?? []) push('user', { type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } });
        push('user', { type: 'text', text: m.content || ' ' });
      }
      else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
      else {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) {
          const input: unknown = JSON.parse(wireArguments(c.arguments));
          push('assistant', { type: 'tool_use', id: c.id, name: c.name, input });
        }
        if (!m.content && !m.toolCalls?.length) push('assistant', { type: 'text', text: ' ' });
      }
    }
    return out;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 8192,
      // Prompt caching: system and tools are stable across steps; the last message marks the growing prefix.
      system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
      messages: this.toWire(req.messages),
      stream: true,
    };
    if (req.tools.length) {
      const tools: Record<string, unknown>[] = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      tools[tools.length - 1].cache_control = { type: 'ephemeral' };
      body.tools = tools;
    }
    const msgs = body.messages as { content: Record<string, unknown>[] }[];
    const lastBlock = msgs.at(-1)?.content.at(-1);
    if (lastBlock) lastBlock.cache_control = { type: 'ephemeral' };
    if (req.temperature !== undefined) body.temperature = req.temperature;

    const wd = streamWatchdog(req.signal, req.timeouts);
    let res: Response;
    try {
      res = await fetch(`${(this.opts.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.opts.apiKey ?? '',
          'anthropic-version': this.opts.version ?? '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: wd.signal,
      });
    } catch (e) {
      wd.stop();
      throw wd.stallError() ?? toProviderError(e, req.signal);
    }
    if (!res.ok || !res.body) {
      wd.stop();
      const text = await res.text().catch(() => '');
      throw classifyHttpError(res.status, text, res.headers.get('retry-after'));
    }
    wd.kick();

    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
    const blocks = new Map<number, { kind: string; call?: ToolCall }>();
    try {
      for await (const { data } of readSse(res.body, () => wd.kick())) {
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'message_start':
            {
              const u = ev.message?.usage ?? {};
              // Anthropic counts cached reads/writes separately from input_tokens.
              usage.cachedTokens = u.cache_read_input_tokens ?? 0;
              usage.inputTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            }
            break;
          case 'content_block_start': {
            const b = ev.content_block;
            if (b.type === 'tool_use') blocks.set(ev.index, { kind: 'tool', call: { id: b.id, name: b.name, arguments: '' } });
            else blocks.set(ev.index, { kind: b.type });
            break;
          }
          case 'content_block_delta': {
            const d = ev.delta;
            if (d.type === 'text_delta') {
              text += d.text;
              req.onDelta?.({ text: d.text });
            } else if (d.type === 'thinking_delta') {
              reasoning += d.thinking;
              req.onDelta?.({ reasoning: d.thinking });
            } else if (d.type === 'input_json_delta') {
              const b = blocks.get(ev.index);
              if (b?.call) b.call.arguments += d.partial_json;
            }
            break;
          }
          case 'message_delta':
            if (ev.delta?.stop_reason) finishReason = ev.delta.stop_reason;
            if (ev.usage?.output_tokens) usage.outputTokens = ev.usage.output_tokens;
            break;
          case 'error':
            throw classifyHttpError(ev.error?.type === 'overloaded_error' ? 529 : 400, JSON.stringify(ev.error));
        }
      }
    } catch (e) {
      throw wd.stallError() ?? toProviderError(e, req.signal);
    } finally {
      wd.stop();
    }
    const toolCalls = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b.call)
      .filter((c): c is ToolCall => !!c)
      .map((c) => ({ ...c, arguments: c.arguments || '{}' }));
    return { text, reasoning: reasoning || undefined, toolCalls, usage, finishReason };
  }
}
