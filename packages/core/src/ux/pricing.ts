import type { SessionEvent } from '../types.js';

/** USD per million tokens. `cached` is the price of input served from the prompt cache. */
export interface ModelPrice {
  input: number;
  cached?: number;
  output: number;
}

/**
 * List prices at the time of writing (estimates; providers change them). Keys match `provider/model`,
 * a trailing `*` matches a prefix. Override or extend with `pricing` in ~/.sun/config.json.
 */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'deepseek/deepseek-chat': { input: 0.28, cached: 0.028, output: 0.42 },
  'deepseek/deepseek-reasoner': { input: 0.28, cached: 0.028, output: 0.42 },
  'qwen/qwen-flash': { input: 0.05, cached: 0.01, output: 0.4 },
  'qwen/qwen-plus': { input: 0.4, cached: 0.08, output: 1.2 },
  'qwen/qwen-max': { input: 1.6, cached: 0.32, output: 6.4 },
  'qwen/qwen3-coder-plus': { input: 1, cached: 0.2, output: 5 },
  'qwen/qwen3-vl-plus': { input: 0.2, cached: 0.04, output: 1.6 },
  'openai/gpt-4o': { input: 2.5, cached: 1.25, output: 10 },
  'openai/gpt-4o-mini': { input: 0.15, cached: 0.075, output: 0.6 },
  'openai/gpt-5*': { input: 1.25, cached: 0.125, output: 10 },
  'anthropic/claude-sonnet*': { input: 3, cached: 0.3, output: 15 },
  'anthropic/claude-opus*': { input: 15, cached: 1.5, output: 75 },
  'anthropic/claude-haiku*': { input: 1, cached: 0.1, output: 5 },
  'glm/glm-4.6': { input: 0.6, cached: 0.11, output: 2.2 },
  'gemini/gemini-2.5-pro': { input: 1.25, cached: 0.31, output: 10 },
  'gemini/gemini-2.5-flash': { input: 0.3, cached: 0.075, output: 2.5 },
  'ollama/*': { input: 0, output: 0 },
};

export function priceOf(model: string, table: Record<string, ModelPrice>): ModelPrice | undefined {
  if (table[model]) return table[model];
  let best: { k: string; p: ModelPrice } | undefined;
  for (const [k, p] of Object.entries(table)) if (k.endsWith('*') && model.startsWith(k.slice(0, -1)) && (!best || k.length > best.k.length)) best = { k, p };
  return best?.p;
}

export interface CostReport {
  usd: number;
  /** Models seen without a price (their tokens are not in `usd`). */
  unpriced: string[];
  byModel: { model: string; input: number; cached: number; output: number; usd?: number }[];
}

/** Estimated cost of a session from its logged usage (assistant messages, compactions are not billed separately). */
export function sessionCost(events: readonly SessionEvent[], table: Record<string, ModelPrice>): CostReport {
  const by = new Map<string, { input: number; cached: number; output: number }>();
  for (const e of events) {
    if (e.type !== 'assistant/message' || !e.usage) continue;
    const r = by.get(e.model) ?? { input: 0, cached: 0, output: 0 };
    r.input += e.usage.inputTokens;
    r.cached += e.usage.cachedTokens ?? 0;
    r.output += e.usage.outputTokens;
    by.set(e.model, r);
  }
  let usd = 0;
  const unpriced: string[] = [];
  const byModel = [...by.entries()].map(([model, r]) => {
    const p = priceOf(model, table);
    if (!p) {
      unpriced.push(model);
      return { model, ...r };
    }
    const cost = ((r.input - r.cached) * p.input + r.cached * (p.cached ?? p.input) + r.output * p.output) / 1e6;
    usd += cost;
    return { model, ...r, usd: cost };
  });
  return { usd, unpriced, byModel };
}

export function formatUsd(x: number): string {
  return x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`;
}
