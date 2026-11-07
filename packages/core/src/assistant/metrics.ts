import type { SessionEvent } from '../types.js';

export interface ModeMetrics {
  mode: string;
  sessions: number;
  /** Messages the user typed (not hooks, jobs, schedules, verification). */
  userTurns: number;
  turnsPerSession: number;
  /** Median time from a user message to the first assistant message. */
  medianFirstResponseMs: number;
  /** Median time from a user message to the end of its run. */
  medianTurnMs: number;
  toolCallsPerTurn: number;
  toolErrorRate: number;
  /** Approval prompts per user turn: interruptions of the user. */
  approvalsPerTurn: number;
  denialRate: number;
  /** Runs the user stopped. */
  aborts: number;
  paused: number;
  /** Turns whose final answer was a question back to the user. */
  clarifyRate: number;
  tokensPerTurn: number;
  cacheHitRate: number;
  memoryRecalls: number;
  memoriesExtracted: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/** Efficiency of the conversation itself, per mode, computed from session logs. */
export function conversationMetrics(sessions: { mode: string; events: readonly SessionEvent[] }[]): ModeMetrics[] {
  const byMode = new Map<string, { mode: string; events: readonly SessionEvent[] }[]>();
  for (const s of sessions) byMode.set(s.mode, [...(byMode.get(s.mode) ?? []), s]);
  return [...byMode.entries()]
    .map(([mode, list]) => {
      let userTurns = 0;
      let toolCalls = 0;
      let toolErrors = 0;
      let approvals = 0;
      let denials = 0;
      let aborts = 0;
      let paused = 0;
      let clarify = 0;
      let input = 0;
      let output = 0;
      let cached = 0;
      let recalls = 0;
      let extracted = 0;
      const first: number[] = [];
      const turn: number[] = [];
      for (const { events } of list) {
        let open: number | undefined;
        let answered = false;
        let lastText = '';
        const close = (ts: number) => {
          if (open === undefined) return;
          turn.push(ts - open);
          if (/[?？]\s*$/.test(lastText.trim())) clarify++;
          open = undefined;
        };
        for (const e of events) {
          const ts = Date.parse(e.ts);
          if (e.type === 'user/message') {
            if (e.source === 'memory') recalls++;
            if (!e.source || e.source === 'user') {
              userTurns++;
              open = ts;
              answered = false;
            }
          } else if (e.type === 'assistant/message') {
            if (open !== undefined && !answered) {
              first.push(ts - open);
              answered = true;
            }
            if (e.text) lastText = e.text;
            toolCalls += e.toolCalls.length;
            input += e.usage?.inputTokens ?? 0;
            output += e.usage?.outputTokens ?? 0;
            cached += e.usage?.cachedTokens ?? 0;
          } else if (e.type === 'tool/result' && e.isError) toolErrors++;
          else if (e.type === 'approval/request') approvals++;
          else if (e.type === 'approval/decision' && e.decision === 'deny') denials++;
          else if (e.type === 'memory/extract') extracted += e.added.length;
          else if (e.type === 'run/status') {
            if (e.status === 'aborted') aborts++;
            if (e.status === 'paused') paused++;
            if (e.status !== 'running' && e.status !== 'awaiting_approval') close(ts);
          }
        }
      }
      const t = Math.max(1, userTurns);
      return {
        mode,
        sessions: list.length,
        userTurns,
        turnsPerSession: userTurns / Math.max(1, list.length),
        medianFirstResponseMs: median(first),
        medianTurnMs: median(turn),
        toolCallsPerTurn: toolCalls / t,
        toolErrorRate: toolCalls ? toolErrors / toolCalls : 0,
        approvalsPerTurn: approvals / t,
        denialRate: approvals ? denials / approvals : 0,
        aborts,
        paused,
        clarifyRate: clarify / t,
        tokensPerTurn: (input + output) / t,
        cacheHitRate: input ? cached / input : 0,
        memoryRecalls: recalls,
        memoriesExtracted: extracted,
      };
    })
    .sort((a, b) => b.userTurns - a.userTurns);
}

export function formatMetrics(rows: ModeMetrics[], days: number): string {
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
  const lines = [
    `# Conversation efficiency (last ${days} days)`,
    '',
    '| Mode | Sessions | Turns | Turns/session | First response | Turn time | Tools/turn | Tool errors | Approvals/turn | Denied | Clarify | Tokens/turn | Cached | Recalls | Memories |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.mode} | ${r.sessions} | ${r.userTurns} | ${r.turnsPerSession.toFixed(1)} | ${sec(r.medianFirstResponseMs)} | ${sec(r.medianTurnMs)} | ${r.toolCallsPerTurn.toFixed(1)} | ${pct(r.toolErrorRate)} | ${r.approvalsPerTurn.toFixed(2)} | ${pct(r.denialRate)} | ${pct(r.clarifyRate)} | ${Math.round(r.tokensPerTurn)} | ${pct(r.cacheHitRate)} | ${r.memoryRecalls} | ${r.memoriesExtracted} |`,
    ),
  ];
  return lines.join('\n');
}
