import type { SessionEvent } from './types.js';

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch']);

export interface SessionMetrics {
  /** Model requests (assistant messages). */
  steps: number;
  toolCalls: number;
  toolErrors: number;
  editCalls: number;
  editFailures: number;
  inputTokens: number;
  outputTokens: number;
  compactions: number;
  approvals: number;
  userMessages: number;
  durationMs: number;
  /** Tool name → calls / errors. */
  byTool: Record<string, { calls: number; errors: number }>;
}

/** Derive quality and cost metrics from a session log (everything needed is already logged). */
export function sessionMetrics(events: readonly SessionEvent[]): SessionMetrics {
  const m: SessionMetrics = {
    steps: 0,
    toolCalls: 0,
    toolErrors: 0,
    editCalls: 0,
    editFailures: 0,
    inputTokens: 0,
    outputTokens: 0,
    compactions: 0,
    approvals: 0,
    userMessages: 0,
    durationMs: 0,
    byTool: {},
  };
  for (const e of events) {
    if (e.type === 'assistant/message') {
      m.steps++;
      m.inputTokens += e.usage?.inputTokens ?? 0;
      m.outputTokens += e.usage?.outputTokens ?? 0;
    } else if (e.type === 'tool/result') {
      m.toolCalls++;
      const t = (m.byTool[e.name] ??= { calls: 0, errors: 0 });
      t.calls++;
      if (e.isError) {
        m.toolErrors++;
        t.errors++;
      }
      if (EDIT_TOOLS.has(e.name)) {
        m.editCalls++;
        if (e.isError) m.editFailures++;
      }
    } else if (e.type === 'context/compaction') m.compactions++;
    else if (e.type === 'approval/request') m.approvals++;
    else if (e.type === 'user/message' && (e.source ?? 'user') === 'user') m.userMessages++;
  }
  if (events.length > 1) m.durationMs = Date.parse(events[events.length - 1].ts) - Date.parse(events[0].ts);
  return m;
}
