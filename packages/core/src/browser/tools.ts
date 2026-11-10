import { join } from 'node:path';
import type { Tool } from '../tools/types.js';
import type { BrowserManager } from './browser.js';

const SNAPSHOT_NOTE = 'Returns an accessibility snapshot: use opaque element refs from this snapshot for browser_click / browser_type.';

/** Browser tools bound to one BrowserManager; every harness session gets its own tab. */
export function createBrowserTools(b: BrowserManager): Tool[] {
  let cached: { at: number; ok: boolean } | undefined;
  const available = async () => {
    if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), ok: b.available() };
    return cached.ok;
  };
  const tool = (t: Omit<Tool, 'source' | 'available'>): Tool => ({ ...t, source: 'builtin', available });
  return [
    tool({
      name: 'browser_navigate',
      description: `Open a URL in the browser (a real Chrome; logins persist in the profile). A new origin requires review in Browser permissions. ${SNAPSHOT_NOTE} Use web_fetch instead for static pages you only need to read.`,
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
      risk: 'network',
      execute: (a, ctx) => b.navigate(ctx.sessionId, String(a.url), ctx.signal),
    }),
    tool({
      name: 'browser_snapshot',
      description: `Snapshot the current page. Take a new snapshot after browser takeover and handback. ${SNAPSHOT_NOTE}`,
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      execute: (_a, ctx) => b.snapshot(ctx.sessionId, ctx.signal),
    }),
    tool({
      name: 'browser_click',
      description: 'Click an element by its ref from the latest snapshot. Returns the new snapshot.',
      parameters: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
      risk: 'network',
      execute: (a, ctx) => b.click(ctx.sessionId, String(a.ref), ctx.signal),
    }),
    tool({
      name: 'browser_type',
      description: 'Type text into an input by ref (replaces its content unless clear is false); submit presses Enter. Returns the new snapshot.',
      parameters: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean' }, clear: { type: 'boolean' } }, required: ['ref', 'text'] },
      risk: 'network',
      execute: (a, ctx) => b.type(ctx.sessionId, String(a.ref), String(a.text ?? ''), { submit: !!a.submit, clear: a.clear !== false }, ctx.signal),
    }),
    tool({
      name: 'browser_press_key',
      description: 'Press a key in the page: Enter, Tab, Escape, Backspace, ArrowDown, PageDown, or a combination like Control+a.',
      parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      risk: 'network',
      execute: (a, ctx) => b.press(ctx.sessionId, String(a.key), ctx.signal),
    }),
    tool({
      name: 'browser_scroll',
      description: 'Scroll the page up or down (default 600 px) and return the new snapshot.',
      parameters: { type: 'object', properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } }, required: ['direction'] },
      risk: 'read',
      execute: (a, ctx) => b.scroll(ctx.sessionId, a.direction === 'up' ? 'up' : 'down', Number(a.amount) || 600, ctx.signal),
    }),
    tool({
      name: 'browser_back',
      description: 'Go back one page in history and return the snapshot.',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      execute: (_a, ctx) => b.back(ctx.sessionId, ctx.signal),
    }),
    tool({
      name: 'browser_screenshot',
      description: 'Save a PNG screenshot of the page into the workspace (for deliverables or the user). Returns the file path.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'relative path, default screenshots/<time>.png' }, full_page: { type: 'boolean' } } },
      risk: 'read',
      async execute(a, ctx) {
        const rel = String(a.path ?? `screenshots/${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
        const file = await b.screenshot(ctx.sessionId, join(ctx.cwd, rel), !!a.full_page, ctx.signal);
        return `Saved ${rel} (${file})`;
      },
    }),
    tool({
      name: 'browser_uploads',
      description: 'List the current session’s single-use upload handles approved by the user in the live browser panel.',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      execute: async (_a, ctx) => JSON.stringify(b.listUploads(ctx.sessionId)),
    }),
    tool({
      name: 'browser_upload',
      description: 'Set an approved file on a top-level file input. Use the latest snapshot ref and a handle from browser_uploads. Never pass a local file path.',
      parameters: { type: 'object', properties: { ref: { type: 'string' }, handle: { type: 'string' } }, required: ['ref', 'handle'], additionalProperties: false },
      risk: 'network',
      execute: (a, ctx) => b.upload(ctx.sessionId, String(a.ref), String(a.handle), ctx.signal),
    }),
    tool({
      name: 'browser_download',
      description: 'Download an HTTP or HTTPS URL from the browser profile into bounded session-owned staging. Requires separate download permission on the current site and every destination.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
      risk: 'network',
      execute: async (a, ctx) => JSON.stringify(await b.download(ctx.sessionId, String(a.url), ctx.signal)),
    }),
    tool({
      name: 'browser_evaluate',
      description: 'Run a JavaScript expression in the page and return its JSON value (e.g. extract a table). Prefer snapshots for navigation.',
      parameters: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
      risk: 'exec',
      execute: (a, ctx) => b.evaluate(ctx.sessionId, String(a.expression), ctx.signal),
    }),
  ];
}
