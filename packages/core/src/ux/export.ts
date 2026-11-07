import type { SessionEvent } from '../types.js';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function toolArgs(raw: string): string {
  try {
    const a = JSON.parse(raw);
    return JSON.stringify(a, null, 2);
  } catch {
    return raw;
  }
}

/** A readable transcript: user and assistant turns, tool calls with collapsed output, key session events. */
export function sessionToMarkdown(events: readonly SessionEvent[]): string {
  const meta = events.find((e) => e.type === 'session/meta') as Extract<SessionEvent, { type: 'session/meta' }> | undefined;
  const title = [...events].reverse().find((e) => e.type === 'session/title') as { title: string } | undefined;
  const results = new Map<string, Extract<SessionEvent, { type: 'tool/result' }>>();
  for (const e of events) if (e.type === 'tool/result') results.set(e.callId, e);
  const out: string[] = [`# ${title?.title ?? meta?.title ?? 'Session'}`, '', `- Session: \`${meta?.id ?? ''}\``, `- Mode: ${meta?.mode ?? ''} · Model: ${meta?.model ?? ''}`, `- Workspace: \`${meta?.cwd ?? ''}\``, `- Started: ${meta?.createdAt ?? ''}`, ''];
  for (const e of events) {
    if (e.type === 'user/message') {
      if (e.source === 'memory' || e.source === 'hook') continue;
      out.push(`## ${e.source && e.source !== 'user' ? `(${e.source})` : 'User'}`, '', e.text, '');
      for (const img of e.images ?? []) out.push(`![image](${img.path})`, '');
    } else if (e.type === 'assistant/message') {
      if (e.text || e.toolCalls.length) out.push(`## Assistant · ${e.model}`, '');
      if (e.text) out.push(e.text, '');
      for (const c of e.toolCalls) {
        const r = results.get(c.id);
        out.push(`<details><summary>${r?.isError ? '✗' : '✓'} ${c.name}</summary>`, '', '```json', toolArgs(c.arguments), '```', '');
        if (r?.diff) out.push('```diff', r.diff, '```', '');
        if (r) out.push('```', r.output.length > 4000 ? `${r.output.slice(0, 4000)}\n… (${r.output.length - 4000} more characters)` : r.output, '```', '');
        out.push('</details>', '');
      }
    } else if (e.type === 'model/switch') out.push(`> model ${e.from} → ${e.to}${e.reason ? ` (${e.reason})` : ''}`, '');
    else if (e.type === 'mode/switch') out.push(`> mode ${e.from} → ${e.to}`, '');
    else if (e.type === 'verify/result') out.push(`> ${e.passed ? '✓ verified' : '✗ verification failed'}: ${e.results.map((r) => r.command).join(' && ')}`, '');
    else if (e.type === 'context/compaction') out.push(`> context compacted`, '');
  }
  return out.join('\n');
}

/** Self-contained HTML (no scripts): the Markdown transcript rendered with minimal styling. */
export function sessionToHtml(events: readonly SessionEvent[]): string {
  const md = sessionToMarkdown(events);
  const lines = md.split('\n');
  const html: string[] = [];
  let inCode = false;
  for (const l of lines) {
    if (l.startsWith('```')) {
      html.push(inCode ? '</code></pre>' : `<pre><code class="${esc(l.slice(3))}">`);
      inCode = !inCode;
    } else if (inCode) html.push(esc(l));
    else if (l.startsWith('# ')) html.push(`<h1>${esc(l.slice(2))}</h1>`);
    else if (l.startsWith('## ')) html.push(`<h2>${esc(l.slice(3))}</h2>`);
    else if (l.startsWith('> ')) html.push(`<p class="event">${esc(l.slice(2))}</p>`);
    else if (l.startsWith('- ')) html.push(`<p class="meta">${esc(l.slice(2))}</p>`);
    else if (/^<\/?details|^<summary/.test(l)) html.push(l.replace(/<summary>(.*)<\/summary>/, (_m, t: string) => `<summary>${esc(t)}</summary>`));
    else if (l.trim()) html.push(`<p>${esc(l)}</p>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>sun-harness session</title><style>
body{font:15px/1.6 -apple-system,BlinkMacSystemFont,sans-serif;max-width:860px;margin:40px auto;padding:0 20px;color:#1f1a14;background:#fbf8f3}
h1{font-weight:500}h2{font-size:15px;margin:28px 0 6px;color:#e8862a;text-transform:uppercase;letter-spacing:.06em}
pre{background:#201a13;color:#f3e9da;padding:12px;border-radius:8px;overflow:auto;font:12.5px/1.5 Menlo,monospace}
details{border:1px solid #e7dfd2;border-radius:8px;padding:6px 10px;margin:8px 0;background:#fff}.event{color:#6f6556;font-size:13px}.meta{margin:2px 0;color:#6f6556}
</style></head><body>${html.join('\n')}</body></html>`;
}
