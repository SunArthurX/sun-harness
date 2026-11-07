export interface RouterConfig {
  /** Model for the harness's own background calls (memory extraction, reflection, intel analysis). */
  background?: string;
  /** Sessions whose model is "auto": quick conversational turns. */
  fast?: string;
  /** Sessions whose model is "auto": hard turns (code, analysis, long inputs, recent tool errors). */
  strong?: string;
}

export const DEFAULT_ROUTER: RouterConfig = {};

const HARD = /\b(debug|refactor|implement|architecture|design|prove|analy[sz]e|compare|optimi[sz]e|plan|why|algorithm|review|migrate|benchmark|investigate)\b|分析|设计|实现|优化|调试|比较|为什么|方案|架构|重构/i;

export interface RouteSignals {
  /** Latest user message text. */
  text: string;
  /** Tool calls that failed in the last few steps. */
  recentToolErrors: number;
  /** Steps already taken in this run. */
  steps: number;
}

/** Heuristic difficulty: strong for code, long or analytical requests, and runs that are struggling. */
export function routeTier(s: RouteSignals): 'fast' | 'strong' {
  if (/```|\bfunction\b|\bclass\b|=>|\bdef\b|stack trace|Traceback|Error:/.test(s.text)) return 'strong';
  if (s.text.length > 1200) return 'strong';
  if (HARD.test(s.text)) return 'strong';
  if (s.recentToolErrors >= 2 || s.steps >= 12) return 'strong';
  return 'fast';
}
