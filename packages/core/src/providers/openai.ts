import type { ChatMessage, ToolCall } from '../types.js';
import { readSse } from './sse.js';
import { classifyHttpError, ProviderError, toProviderError, type ModelRequest, type ModelResponse, type Provider } from './types.js';

export interface OpenAICompatOptions {
  id: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  /** Send `reasoning_content` back on assistant turns (needed by some thinking models during tool use). */
  echoReasoning?: boolean;
}

/** OpenAI Chat Completions wire format; covers DeepSeek, OpenAI, GLM, Qwen, Gemini (compat), Ollama, OpenRouter. */
export class OpenAICompatProvider implements Provider {
  readonly id: string;
  constructor(private readonly opts: OpenAICompatOptions) {
    this.id = opts.id;
  }

  private toWire(system: string, messages: ChatMessage[]): unknown[] {
    const out: unknown[] = [];
    if (system) out.push({ role: 'system', content: system });
    for (const m of messages) {
      if (m.role === 'assistant') {
        const msg: Record<string, unknown> = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') };
        if (m.toolCalls?.length) {
          msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }));
        }
        if (this.opts.echoReasoning && m.reasoning) msg.reasoning_content = m.reasoning;
        out.push(msg);
      } else if (m.role === 'tool') {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: req.model,
      messages: this.toWire(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.temperature !== undefined) body.temperature = req.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.headers,
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
    let usage: ModelResponse['usage'];
    const calls = new Map<number, ToolCall>();
    try {
      for await (const { data } of readSse(res.body)) {
        if (data === '[DONE]') break;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw classifyHttpError(Number(chunk.error.code) || 400, JSON.stringify(chunk.error));
        if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (d.content) {
          text += d.content;
          req.onDelta?.({ text: d.content });
        }
        const r = d.reasoning_content ?? d.reasoning;
        if (typeof r === 'string' && r) {
          reasoning += r;
          req.onDelta?.({ reasoning: r });
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const cur = calls.get(idx) ?? { id: '', name: '', arguments: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.arguments += tc.function.arguments;
          calls.set(idx, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
    } catch (e) {
      throw toProviderError(e, req.signal);
    }
    const toolCalls = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, c]) => ({ ...c, id: c.id || `call_${Date.now()}_${i}` }))
      .filter((c) => c.name);
    if (!text && !toolCalls.length && !reasoning) {
      throw new ProviderError('network', 'Empty response from model');
    }
    return { text, reasoning: reasoning || undefined, toolCalls, usage, finishReason };
  }
}
