import type { ChatMessage, ToolCall } from '../types.js';
import { readSse } from './sse.js';
import { classifyHttpError, toProviderError, type ModelRequest, type ModelResponse, type Provider } from './types.js';

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
      if (m.role === 'user') push('user', { type: 'text', text: m.content || ' ' });
      else if (m.role === 'tool') push('user', { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content });
      else {
        if (m.content) push('assistant', { type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) {
          let input: unknown = {};
          try {
            input = JSON.parse(c.arguments || '{}');
          } catch {
            input = {};
          }
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
      system: req.system,
      messages: this.toWire(req.messages),
      stream: true,
    };
    if (req.tools.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (req.temperature !== undefined) body.temperature = req.temperature;

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
        signal: req.signal,
      });
    } catch (e) {
      throw toProviderError(e, req.signal);
    }
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => '');
      throw classifyHttpError(res.status, text, res.headers.get('retry-after'));
    }

    let text = '';
    let reasoning = '';
    let finishReason: string | undefined;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const blocks = new Map<number, { kind: string; call?: ToolCall }>();
    try {
      for await (const { data } of readSse(res.body)) {
        let ev: any;
        try {
          ev = JSON.parse(data);
        } catch {
          continue;
        }
        switch (ev.type) {
          case 'message_start':
            usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
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
      throw toProviderError(e, req.signal);
    }
    const toolCalls = [...blocks.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, b]) => b.call)
      .filter((c): c is ToolCall => !!c)
      .map((c) => ({ ...c, arguments: c.arguments || '{}' }));
    return { text, reasoning: reasoning || undefined, toolCalls, usage, finishReason };
  }
}
