import type { ChatMessage, SessionEvent, ToolCall } from './types.js';

/**
 * Project model-visible history from the durable log.
 * - Honors the latest compaction: earlier events are replaced by its summary.
 * - Guarantees every assistant tool call is paired with a tool result (providers reject unpaired calls).
 */
export function deriveMessages(events: readonly SessionEvent[]): ChatMessage[] {
  let start = 0;
  const out: ChatMessage[] = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'context/compaction') {
      out.push({ role: 'user', content: `[Summary of the earlier conversation]\n${e.summary}` });
      out.push({ role: 'assistant', content: 'Understood. Continuing from the summary.' });
      start = e.upToSeq + 1;
      break;
    }
  }

  let pending: ToolCall[] = [];
  const flushPending = () => {
    for (const c of pending) {
      out.push({ role: 'tool', toolCallId: c.id, name: c.name, content: '[No result: the call was interrupted.]' });
    }
    pending = [];
  };

  for (const e of events) {
    if (e.seq < start) continue;
    switch (e.type) {
      case 'user/message':
        flushPending();
        out.push({ role: 'user', content: e.text });
        break;
      case 'assistant/message':
        flushPending();
        out.push({
          role: 'assistant',
          content: e.text,
          toolCalls: e.toolCalls.length ? e.toolCalls : undefined,
          reasoning: e.reasoning,
        });
        pending = [...e.toolCalls];
        break;
      case 'tool/result': {
        const idx = pending.findIndex((c) => c.id === e.callId);
        if (idx >= 0) {
          pending.splice(idx, 1);
          out.push({ role: 'tool', toolCallId: e.callId, name: e.name, content: e.output });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Tool calls of the last assistant message that still have no result. */
export function pendingToolCalls(events: readonly SessionEvent[]): ToolCall[] {
  let pending: ToolCall[] = [];
  for (const e of events) {
    if (e.type === 'assistant/message') pending = [...e.toolCalls];
    else if (e.type === 'user/message') pending = [];
    else if (e.type === 'tool/result') pending = pending.filter((c) => c.id !== e.callId);
  }
  return pending;
}

/** Rough token estimate (chars/4, CJK counted heavier). Good enough for compaction thresholds. */
export function estimateTokens(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    const text = m.content + ('toolCalls' in m && m.toolCalls ? JSON.stringify(m.toolCalls) : '');
    const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
    n += Math.ceil((text.length - cjk) / 4) + cjk + 4;
  }
  return n;
}
