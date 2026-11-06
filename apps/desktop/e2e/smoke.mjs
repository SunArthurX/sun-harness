// End-to-end smoke test: launches the built desktop app, runs a live session with an approval, and screenshots every page.
// Usage: pnpm --filter @sun/desktop run build && node apps/desktop/e2e/smoke.mjs   (needs DEEPSEEK_API_KEY)
import { _electron as electron } from 'playwright-core';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const shots = join(here, 'shots');
mkdirSync(shots, { recursive: true });

const home = mkdtempSync(join(tmpdir(), 'sun-e2e-home-'));
const ws = mkdtempSync(join(tmpdir(), 'sun-e2e-ws-'));
mkdirSync(join(ws, '.git'));
writeFileSync(join(ws, 'AGENTS.md'), '# Rules\nWrite everything in English.\n');
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    defaultModel: process.env.SUN_E2E_MODEL || 'deepseek/deepseek-chat',
    approval: 'suggest',
    // A provider with a rejected key, to exercise the paused banner and "Switch & resume".
    providers: { broke: { type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-invalid', models: ['deepseek-chat'] } },
  }),
);
mkdirSync(join(home, 'kb'), { recursive: true });
writeFileSync(join(home, 'kb', 'harness.md'), '# Harness notes\n\n## Principles\nModel-visible means logged. Durable before clever.\n');

const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(here, '..', 'out', 'main', 'index.js')],
  env: { ...process.env, SUN_HOME: home, SUN_SKIP_SHELL_ENV: '1' },
});
const win = await app.firstWindow();
await win.setViewportSize?.({ width: 1360, height: 860 }).catch(() => {});
await win.waitForSelector('.hero');
await win.waitForTimeout(1200);
await win.screenshot({ path: join(shots, '01-welcome.png') });

await win.evaluate(() => {
  window.__live = [];
  window.sun.onLive((e) => window.__live.push(e.kind === 'event' ? `${e.event.seq}:${e.event.type}` : e.kind));
});
const session = await win.evaluate((cwd) => window.sun.call('createSession', { cwd, mode: 'coding' }), ws);
await win.click(`.session:has-text("New session")`);
await win.waitForSelector('.composer textarea');
await win.fill('.composer textarea', 'Create notes.md containing a 3-item checklist about the sun. Then list the directory and tell me what you did in one sentence.');
await win.keyboard.press('Enter');

await win.waitForSelector('.approval', { timeout: 90_000 });
await win.waitForTimeout(400);
await win.screenshot({ path: join(shots, '02-approval.png') });
await win.click('.approval .btn-primary');

for (let i = 0; ; i++) {
  const status = await win.evaluate(async (id) => (await window.sun.call('listSessions')).find((s) => s.id === id)?.status, session.id);
  if (status === 'idle') break;
  if (i > 240) throw new Error(`Session did not finish (status ${status})`);
  // Models may take a different path that needs more approvals; approve each one that appears.
  if (await win.$('.approval .btn-primary')) await win.click('.approval .btn-primary').catch(() => {});
  await win.waitForTimeout(500);
}
await win.waitForTimeout(600);
await win.screenshot({ path: join(shots, '03-chat.png') });
const ok = existsSync(join(ws, 'notes.md'));
// The UI must reflect the durable log exactly: every tool result rendered, final status idle, no "working" indicator.
const ui = await win.evaluate(() => ({
  idleDot: !!document.querySelector('.chat-head .dot-idle'),
  working: !!document.querySelector('.pulse'),
  okTools: document.querySelectorAll('.tool-ok').length,
  assistantBlocks: document.querySelectorAll('.msg.assistant .md').length,
}));
console.log('ui', JSON.stringify(ui));
if (process.env.SUN_E2E_DEBUG) console.log('live', JSON.stringify(await win.evaluate(() => window.__live.filter((k) => k !== 'delta'))));
if (!ui.idleDot || ui.working || ui.okTools < 2) {
  console.error('UI does not match the session log');
  process.exitCode = 1;
}

// Quota/auth recovery from the UI: pause on a rejected key, then switch model and resume.
const broken = await win.evaluate((cwd) => window.sun.call('createSession', { cwd, mode: 'coding', model: 'broke/deepseek-chat' }), ws);
await win.evaluate((id) => window.sun.call('send', id, 'Reply with exactly: recovered'), broken.id);
await win.click(`.session:has-text("Reply with exactly")`);
await win.waitForSelector('.banner', { timeout: 60_000 });
await win.waitForTimeout(400);
await win.screenshot({ path: join(shots, '09-paused.png') });
await win.selectOption('.banner select', 'deepseek/deepseek-chat');
await win.click('.banner .btn-ghost');
for (let i = 0; ; i++) {
  const s = await win.evaluate(async (id) => (await window.sun.call('listSessions')).find((x) => x.id === id), broken.id);
  if (s?.status === 'idle') break;
  if (i > 120) throw new Error(`Recovery did not finish (${s?.status})`);
  await win.waitForTimeout(500);
}
await win.waitForTimeout(500);
await win.screenshot({ path: join(shots, '10-recovered.png') });
const recovered = await win.evaluate(async (id) => {
  const ev = await window.sun.call('getEvents', id);
  return { paused: ev.some((e) => e.type === 'run/status' && e.status === 'paused'), switched: ev.some((e) => e.type === 'model/switch'), text: ev.filter((e) => e.type === 'assistant/message').at(-1)?.text };
}, broken.id);
console.log('recovery', JSON.stringify(recovered));
if (!recovered.paused || !recovered.switched || !/recovered/i.test(recovered.text ?? '')) process.exitCode = 1;

const pages = [
  ['Knowledge', '04-knowledge.png'],
  ['Skills · MCP · Plugins', '05-extensions.png'],
  ['Evolution', '06-evolution.png'],
  ['Harness Intel', '07-intel.png'],
  ['Settings', '08-settings.png'],
];
for (const [title, file] of pages) {
  await win.click(`.rail-btn[title="${title}"]`);
  if (title === 'Knowledge') {
    await win.fill('.card input', 'logged principles');
    await win.keyboard.press('Enter');
    await win.waitForSelector('.hit', { timeout: 5000 }).catch(() => {});
  }
  await win.waitForTimeout(700);
  await win.screenshot({ path: join(shots, file) });
}

const events = await win.evaluate((id) => window.sun.call('getEvents', id), session.id);
await app.close();
const types = events.map((e) => e.type);
console.log(JSON.stringify({ notesCreated: ok, approvalLogged: types.includes('approval/decision'), toolResults: types.filter((t) => t === 'tool/result').length, shots }, null, 2));
if (!ok || !types.includes('approval/decision')) process.exit(1);
