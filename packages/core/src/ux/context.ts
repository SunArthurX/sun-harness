import type { SessionEvent, ToolSchema } from '../types.js';

/** Same estimate as compaction uses: ~4 characters per token, CJK characters one token each. */
export function estimateTextTokens(text: string): number {
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af]/g) || []).length;
  return Math.ceil((text.length - cjk) / 4) + cjk;
}

/** Providers bill images by size; without decoding, ~1,000 tokens per image is a fair middle. */
export const IMAGE_TOKENS = 1000;

export interface ContextItem {
  label: string;
  tokens: number;
}

export interface ContextCategory {
  name: string;
  tokens: number;
  items: ContextItem[];
}

export interface ContextReport {
  sessionId: string;
  model: string;
  /** The model's context window (tokens). */
  window: number;
  /** History is compacted when it reaches this size. */
  compactAt: number;
  /** Estimated size of the next request. */
  totalTokens: number;
  /** totalTokens / window. */
  percent: number;
  categories: ContextCategory[];
  /** What the provider reported for the last request (real numbers, not estimates). */
  lastRequest?: { inputTokens: number; cachedTokens: number; outputTokens: number; at: string; model: string };
  compactions: number;
  /** Older history replaced by a summary in the current view. */
  compactedUpToSeq?: number;
  suggestions: string[];
}

const top = (items: ContextItem[], n = 12) => [...items].sort((a, b) => b.tokens - a.tokens).slice(0, n);
const sum = (items: ContextItem[]) => items.reduce((s, i) => s + i.tokens, 0);

/**
 * Break down what the next model request contains, mirroring deriveMessages (the latest compaction replaces older
 * events) so the report describes exactly the model's view.
 */
export function buildContextReport(input: {
  sessionId: string;
  model: string;
  window: number;
  compactAt: number;
  system: { title: string; text: string }[];
  tools: ToolSchema[];
  events: readonly SessionEvent[];
}): ContextReport {
  const { events } = input;
  const system = input.system.map((s) => ({ label: s.title, tokens: estimateTextTokens(s.text) }));
  const tools = input.tools.map((t) => ({ label: t.name, tokens: estimateTextTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })) }));

  let start = 0;
  let summaryTokens = 0;
  let compactedUpToSeq: number | undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'context/compaction') {
      summaryTokens = estimateTextTokens(e.summary) + 20;
      start = e.upToSeq + 1;
      compactedUpToSeq = e.upToSeq;
      break;
    }
  }

  const user: ContextItem[] = [];
  const recalled: ContextItem[] = [];
  const attached: ContextItem[] = [];
  const images: ContextItem[] = [];
  const assistant: ContextItem[] = [];
  const results = new Map<string, ContextItem[]>();
  const calls = new Map<string, string>();
  for (const e of events) {
    if (e.seq < start) continue;
    if (e.type === 'user/message') {
      if (e.source === 'memory') {
        recalled.push({ label: `recall #${e.seq}`, tokens: estimateTextTokens(e.text) });
        continue;
      }
      let text = e.text;
      for (const m of e.text.matchAll(/<attached (file|dir)="([^"]*)">([\s\S]*?)<\/attached>/g)) {
        attached.push({ label: `${m[1] === 'dir' ? '📁 ' : ''}${m[2]}`, tokens: estimateTextTokens(m[0]) });
        text = text.replace(m[0], '');
      }
      for (const im of e.images ?? []) images.push({ label: im.path.split('/').pop() ?? 'image', tokens: IMAGE_TOKENS });
      const label = `${e.source && e.source !== 'user' ? `(${e.source}) ` : ''}${(e.command?.input ?? text).replace(/\s+/g, ' ').trim().slice(0, 60)}`;
      user.push({ label, tokens: estimateTextTokens(text) + 4 });
    } else if (e.type === 'assistant/message') {
      for (const c of e.toolCalls) calls.set(c.id, c.name);
      const t = estimateTextTokens(e.text + (e.toolCalls.length ? JSON.stringify(e.toolCalls) : '')) + 4;
      assistant.push({ label: e.text ? e.text.replace(/\s+/g, ' ').slice(0, 60) : `→ ${e.toolCalls.map((c) => c.name).join(', ')}`, tokens: t });
    } else if (e.type === 'tool/result') {
      const name = calls.get(e.callId) ?? e.name;
      results.set(name, [...(results.get(name) ?? []), { label: `${name} #${e.seq}`, tokens: estimateTextTokens(e.output) + 4 }]);
    }
  }

  const toolResultItems = [...results.entries()].map(([name, list]) => ({ label: `${name} (${list.length}×)`, tokens: sum(list) }));
  const largestResults = top([...results.values()].flat(), 5);
  const categories: ContextCategory[] = [
    { name: 'System prompt', tokens: sum(system), items: system },
    { name: 'Tool definitions', tokens: sum(tools), items: top(tools, 40) },
    { name: 'Compaction summary', tokens: summaryTokens, items: summaryTokens ? [{ label: `summary of events ≤ #${compactedUpToSeq}`, tokens: summaryTokens }] : [] },
    { name: 'User messages', tokens: sum(user), items: top(user) },
    { name: 'Attached files', tokens: sum(attached), items: top(attached) },
    { name: 'Images', tokens: sum(images), items: images },
    { name: 'Recalled memories', tokens: sum(recalled), items: top(recalled) },
    { name: 'Assistant messages', tokens: sum(assistant), items: top(assistant) },
    { name: 'Tool results', tokens: sum(toolResultItems), items: top(toolResultItems) },
  ].filter((c) => c.tokens > 0);

  const totalTokens = sum(categories.map((c) => ({ label: c.name, tokens: c.tokens })));
  const last = [...events].reverse().find((e) => e.type === 'assistant/message' && e.usage) as Extract<SessionEvent, { type: 'assistant/message' }> | undefined;
  const pct = (n: number) => Math.round((n / Math.max(1, totalTokens)) * 100);
  const byName = (n: string) => categories.find((c) => c.name === n)?.tokens ?? 0;
  const suggestions: string[] = [];
  if (totalTokens >= input.compactAt * 0.8) suggestions.push(`The context is at ${Math.round((totalTokens / input.compactAt) * 100)}% of the compaction threshold: run /compact now, or start a new session for an unrelated task.`);
  for (const r of largestResults) if (r.tokens > totalTokens * 0.15 && r.tokens > 2000) suggestions.push(`${r.label} alone is ${r.tokens.toLocaleString('en')} tokens (${pct(r.tokens)}%). Ask for narrower reads (line ranges, grep) next time; /compact drops it.`);
  if (byName('Tool definitions') > totalTokens * 0.25 && tools.length > 30) suggestions.push(`${tools.length} tool definitions take ${pct(byName('Tool definitions'))}%: disable MCP servers you do not need in this project.`);
  const rules = system.find((s) => s.label === 'Project rules');
  if (rules && rules.tokens > 4000) suggestions.push(`Project rules are ${rules.tokens.toLocaleString('en')} tokens: mark rarely needed rule files alwaysApply: false (they become a one-line index).`);
  const skills = system.find((s) => s.label === 'Skills');
  if (skills && skills.tokens > 1500 && skills.tokens > totalTokens * 0.2) suggestions.push(`The skills index is ${skills.tokens.toLocaleString('en')} tokens (${pct(skills.tokens)}%): set "skills": { "compat": false } to skip Claude/agents skill folders, or prune ~/.sun/skills.`);
  if (byName('Attached files') > totalTokens * 0.3) suggestions.push('Attached files are a large share: mention folders or smaller files, or let the agent read what it needs.');
  if (!suggestions.length) suggestions.push('Nothing to do: the context is comfortably sized.');

  return {
    sessionId: input.sessionId,
    model: input.model,
    window: input.window,
    compactAt: input.compactAt,
    totalTokens,
    percent: totalTokens / Math.max(1, input.window),
    categories,
    lastRequest: last?.usage ? { inputTokens: last.usage.inputTokens, cachedTokens: last.usage.cachedTokens ?? 0, outputTokens: last.usage.outputTokens, at: last.ts, model: last.model } : undefined,
    compactions: events.filter((e) => e.type === 'context/compaction').length,
    compactedUpToSeq,
    suggestions,
  };
}

const k = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(0)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Plain-text report for the CLI and chat bots. */
export function formatContextReport(r: ContextReport, detail = true): string {
  const bar = (f: number, w = 30) => '█'.repeat(Math.round(Math.min(1, f) * w)).padEnd(w, '░');
  const lines = [
    `Context · ${r.model} · ${k(r.totalTokens)} / ${k(r.window)} tokens (${(r.percent * 100).toFixed(1)}%) · compacts at ${k(r.compactAt)}`,
    `${bar(r.percent)}  ${bar(r.totalTokens / r.compactAt, 10)} of compaction threshold`,
    r.lastRequest ? `Last request (provider-reported): ${k(r.lastRequest.inputTokens)} in (${Math.round((r.lastRequest.cachedTokens / Math.max(1, r.lastRequest.inputTokens)) * 100)}% cached), ${k(r.lastRequest.outputTokens)} out · ${r.lastRequest.model}` : 'No request yet.',
    r.compactions ? `Compacted ${r.compactions}× (older history is a summary).` : '',
    '',
  ];
  for (const c of r.categories) {
    lines.push(`${c.name.padEnd(20)} ${k(c.tokens).padStart(6)}  ${((c.tokens / Math.max(1, r.totalTokens)) * 100).toFixed(0).padStart(3)}%`);
    if (detail) for (const i of c.items.slice(0, 6)) lines.push(`    ${k(i.tokens).padStart(6)}  ${i.label.slice(0, 70)}`);
  }
  lines.push('', ...r.suggestions.map((s) => `→ ${s}`));
  return lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n');
}

const COLORS = ['#e8862a', '#8db8ff', '#9a7fd1', '#7fd1a0', '#e8c37a', '#ff8a7a', '#6fc3c8', '#c8a26f', '#b0b0b0'];

/** Standalone HTML report (no scripts): stacked bar, categories, largest items, suggestions. */
export function contextReportHtml(r: ContextReport, title = 'Context report'): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const seg = r.categories.map((c, i) => `<span style="width:${((c.tokens / Math.max(1, r.window)) * 100).toFixed(2)}%;background:${COLORS[i % COLORS.length]}" title="${esc(c.name)}: ${c.tokens}"></span>`).join('');
  const rows = r.categories
    .map(
      (c, i) =>
        `<details><summary><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(c.name)}<b>${c.tokens.toLocaleString('en')}</b><em>${((c.tokens / Math.max(1, r.totalTokens)) * 100).toFixed(1)}%</em></summary><table>${c.items.map((x) => `<tr><td>${esc(x.label)}</td><td>${x.tokens.toLocaleString('en')}</td></tr>`).join('')}</table></details>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;background:#fbf8f3;color:#1f1a14}
h1{font-weight:500;margin-bottom:4px}.meta{color:#6f6556}.bar{display:flex;height:18px;border-radius:9px;overflow:hidden;background:#eee6da;margin:16px 0 4px}.bar span{display:block}
.mark{position:relative;height:10px}.mark b{position:absolute;top:0;border-left:2px dashed #e8862a;height:10px}
details{background:#fff;border:1px solid #e7dfd2;border-radius:8px;margin:6px 0;padding:6px 10px}summary{display:flex;gap:10px;align-items:center;cursor:pointer}summary b{margin-left:auto;font-variant-numeric:tabular-nums}summary em{color:#6f6556;width:60px;text-align:right;font-style:normal}
summary i{width:10px;height:10px;border-radius:3px;display:inline-block}table{width:100%;border-collapse:collapse;margin-top:6px;font-size:13px}td{padding:2px 4px;border-top:1px solid #f0e9de}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
ul{padding-left:18px}</style></head><body>
<h1>${esc(title)}</h1><p class="meta">${esc(r.model)} · ${r.totalTokens.toLocaleString('en')} of ${r.window.toLocaleString('en')} tokens (${(r.percent * 100).toFixed(1)}%) · compaction at ${r.compactAt.toLocaleString('en')}${r.lastRequest ? ` · last request ${r.lastRequest.inputTokens.toLocaleString('en')} in (${Math.round((r.lastRequest.cachedTokens / Math.max(1, r.lastRequest.inputTokens)) * 100)}% cached)` : ''}</p>
<div class="bar">${seg}</div><div class="mark"><b style="left:${((r.compactAt / Math.max(1, r.window)) * 100).toFixed(1)}%" title="compaction threshold"></b></div>
${rows}<h3>Suggestions</h3><ul>${r.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
<p class="meta">Estimates (≈4 characters per token, CJK 1 per character, ~${IMAGE_TOKENS} per image); the provider's own count is shown as "last request".</p></body></html>`;
}
