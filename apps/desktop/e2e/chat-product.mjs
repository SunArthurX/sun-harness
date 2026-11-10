// Run after pnpm build. Both renderer surfaces use a local scripted provider.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChrome, HarnessHost, startGateway } from '@sun/core';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const appPath = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const webRoot = fileURLToPath(new URL('../out/renderer', import.meta.url));
const home = await mkdtemp(join(tmpdir(), 'sun-chat-product-'));
const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlE0i8AAAAASUVORK5CYII=';
const closedStreams = new Set();
const browserInput = new Map();
const openedBrowserPages = new Set();
const attachedRequests = new Set();
let app;
let host;
let gateway;
let survivors = [];

function tool(index, id, name, args) {
  return { index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

const model = createServer((request, response) => {
  const run = async () => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/browser-fixture') {
      const surface = url.searchParams.get('surface');
      openedBrowserPages.add(surface);
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<title>Browser audit page</title><input aria-label="Audit field" autofocus style="width:100vw;height:100vh" oninput="fetch('/browser-input?surface=${encodeURIComponent(surface)}&amp;text='+encodeURIComponent(this.value))">`);
      return;
    }
    if (url.pathname === '/browser-input') {
      browserInput.set(url.searchParams.get('surface'), url.searchParams.get('text'));
      response.writeHead(204).end();
      return;
    }
    if (request.method === 'GET') {
      response.writeHead(404).end();
      return;
    }
    const body = [];
    for await (const chunk of request) body.push(chunk);
    const { messages, model: requestedModel } = JSON.parse(Buffer.concat(body));
    const prompt = messages.findLast(message => message.role === 'user')?.content;
    const toolResults = messages.filter(message => message.role === 'tool');
    if (requestedModel === 'quota') {
      response.writeHead(402, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Fixture quota exhausted.' } }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta, finish) => response.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`);
    if (typeof prompt === 'string' && prompt.startsWith('audit stop ')) {
      response.once('close', () => closedStreams.add(prompt));
      send({ content: 'Fixture waiting for stop.' });
      return;
    }
    const attachmentText = Array.isArray(prompt) ? prompt.find(part => part.type === 'text')?.text : undefined;
    const attachmentMatch = attachmentText?.match(/^Audit attachments (Electron|Gateway)/);
    if (attachmentMatch) {
      assert.match(attachmentText, /<attached file="audit-chat.txt">[\s\S]*audited file content/);
      assert.equal(prompt.find(part => part.type === 'image_url')?.image_url.url, `data:image/png;base64,${imageBase64}`);
      attachedRequests.add(attachmentMatch[1]);
      send({ content: 'Fixture attachments received.' }, 'stop');
    } else if (typeof prompt === 'string' && prompt.startsWith('audit quota ')) {
      send({ content: 'Fixture recovered on the replacement model.' }, 'stop');
    } else if (prompt === 'audit worktree edit') {
      if (!toolResults.some(message => message.tool_call_id === 'audit-tree')) {
        send({ tool_calls: [tool(0, 'audit-tree', 'write_file', { path: 'audit-tree.txt', content: 'isolated tree change\n' })] }, 'tool_calls');
      } else {
        send({ content: 'Worktree edit completed.' }, 'stop');
      }
    } else if (typeof prompt === 'string' && prompt.startsWith('audit decisions ')) {
      const done = id => toolResults.some(message => message.tool_call_id === id);
      if (!done('audit-deny')) send({ tool_calls: [tool(0, 'audit-deny', 'write_file', { path: 'audit-denied.txt', content: 'must not exist\n' })] }, 'tool_calls');
      else if (!done('audit-always-1')) send({ tool_calls: [tool(0, 'audit-always-1', 'bash', { command: "printf 'always one\\n'" })] }, 'tool_calls');
      else if (!done('audit-always-2')) send({ tool_calls: [tool(0, 'audit-always-2', 'bash', { command: "printf 'always two\\n'" })] }, 'tool_calls');
      else send({ content: 'Decisions completed.' }, 'stop');
    } else if (prompt === 'audit portal automation') {
      send({ content: 'Portal automation completed.' }, 'stop');
    } else if (typeof prompt === 'string' && prompt.startsWith('audit browser ')) {
      if (!toolResults.some(message => message.tool_call_id === 'audit-browser')) {
        const surface = prompt.slice('audit browser '.length);
        send({ tool_calls: [tool(0, 'audit-browser', 'browser_navigate', {
          url: `http://127.0.0.1:${model.address().port}/browser-fixture?surface=${encodeURIComponent(surface)}`,
        })] }, 'tool_calls');
      } else {
        send({ content: 'Browser fixture opened.' }, 'stop');
      }
    } else if (!toolResults.some(message => message.tool_call_id === 'audit-file')) {
      send({ tool_calls: [
        tool(0, 'audit-plan', 'todo_write', { items: Array.from({ length: 12 }, (_, index) => ({
          id: String(index), content: index === 0 ? 'Verify fixture task' : `Pending fixture task ${index}`,
          status: index === 0 ? 'in_progress' : 'pending',
        })) }),
        tool(1, 'audit-file', 'write_file', { path: 'audit-chat.txt', content: 'audited file content\n' }),
      ] }, 'tool_calls');
    } else if (!toolResults.some(message => message.tool_call_id === 'audit-command')) {
      send({ tool_calls: [tool(0, 'audit-command', 'bash', { command: "printf 'audited terminal output\\n'" })] }, 'tool_calls');
    } else {
      send({ content: 'Audit chat completed.' }, 'stop');
    }
    response.end('data: [DONE]\n\n');
  };
  void run().catch(error => response.destroy(error));
});

async function exerciseChat(page, surface) {
  page.setDefaultTimeout(10_000);
  if (surface === 'Gateway') await page.setViewportSize({ width: 920, height: 630 });
  const cwd = join(home, `workspace-${surface.toLowerCase()}`);
  await mkdir(cwd);
  await page.locator('.hero').waitFor();
  const session = await page.evaluate(({ cwd, surface }) => window.sun.call('createSession', {
    cwd, mode: 'coding', title: `${surface} audit session`, approval: 'suggest',
  }), { cwd, surface });
  await page.locator('.session').filter({ hasText: `${surface} audit session` }).click();
  const composer = page.locator('.composer textarea');
  await composer.fill(`audit chat ${surface}`);
  await composer.press('Enter');
  const plan = page.locator('.todos');
  await plan.getByText('Verify fixture task').waitFor();
  assert.equal(await plan.evaluate(element => element.scrollHeight > element.clientHeight), true);
  const approval = page.locator('.approval').filter({ hasText: 'write_file' });
  await approval.waitFor();
  assert.ok((await plan.boundingBox()).y + (await plan.boundingBox()).height <= (await page.locator('.transcript').boundingBox()).y + 1);
  await assert.rejects(readFile(join(cwd, 'audit-chat.txt')), { code: 'ENOENT' });
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  await page.locator('.approval').filter({ hasText: 'bash' }).getByRole('button', { name: 'Allow', exact: true }).click();
  await page.getByText('Audit chat completed.', { exact: true }).waitFor();
  await page.locator('.chat-head .dot-idle').waitFor();
  assert.equal(await readFile(join(cwd, 'audit-chat.txt'), 'utf8'), 'audited file content\n');
  const history = await page.evaluate(id => window.sun.call('getEvents', id), session.id);
  assert.equal(history.filter(event => event.type === 'approval/decision' && event.decision === 'allow').length, 2);
  assert.equal(history.filter(event => event.type === 'tool/result' && !event.isError).length, 3);

  await composer.fill(`audit decisions ${surface}`);
  await composer.press('Enter');
  await page.locator('.approval').filter({ hasText: 'write_file' }).getByRole('button', { name: 'Deny', exact: true }).click();
  await page.locator('.approval').filter({ hasText: 'bash' }).getByRole('button', { name: 'Always allow bash', exact: true }).click();
  await page.getByText('Decisions completed.', { exact: true }).waitFor();
  await assert.rejects(readFile(join(cwd, 'audit-denied.txt')), { code: 'ENOENT' });
  const decided = await page.evaluate(id => window.sun.call('getEvents', id), session.id);
  const decision = callId => decided.find(event => event.type === 'approval/decision' && event.callId === callId)?.decision;
  assert.deepEqual([decision('audit-deny'), decision('audit-always-1'), decision('audit-always-2')], ['deny', 'allow_always', undefined]);
  assert.equal(decided.some(event => event.type === 'approval/request' && event.callId === 'audit-always-2'), false);
  assert.match(decided.find(event => event.type === 'tool/result' && event.callId === 'audit-always-2')?.output ?? '', /always two/);
  await page.getByTitle('Files this session produced').click();
  const deliverables = page.locator('.chat-panels .changes').filter({ hasText: 'Deliverables' });
  await deliverables.getByRole('button', { name: 'audit-chat.txt' }).waitFor();
  await deliverables.getByRole('button', { name: 'Close' }).click();
  await page.getByTitle('Review the changes in this session').click();
  await page.waitForFunction(async id => (await window.sun.call('getEvents', id)).some(event => event.type === 'review/report'), session.id);

  const dock = page.locator('.dock');
  await dock.getByRole('tab', { name: 'Changes' }).click();
  await dock.locator('.cv-tree').getByText('audit-chat.txt', { exact: true }).waitFor();
  await dock.locator('.difflines').getByText('audited file content', { exact: true }).waitFor();
  await dock.getByRole('tab', { name: 'Terminal' }).click();
  await dock.locator('.dock-term pre').filter({ hasText: 'audited terminal output' }).waitFor();
  await dock.getByRole('tab', { name: 'Files' }).click();
  await dock.getByRole('button', { name: 'audit-chat.txt' }).click();
  assert.match(await dock.locator('.dock-file-body').innerText(), /audited file content/);
  await dock.getByRole('tab', { name: 'Browser' }).click();
  await dock.locator('.dock-body').waitFor();
  await dock.getByRole('tab', { name: 'Browser' }).click();
  assert.equal(await dock.locator('.dock-body').count(), 0);
  await page.locator('.context-chip').click();
  await page.locator('.context-panel').getByText('Tool results', { exact: true }).waitFor();
  const contextHtml = await page.evaluate(id => window.sun.call('contextReportHtml', id), session.id);
  assert.match(contextHtml, /Tool results/);
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${primary}+K`);
  await page.locator('.palette').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.rail-lang').click();
  await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
  for (const label of ['更改', '浏览器', '终端', '文件']) await dock.getByRole('tab', { name: new RegExp(label) }).waitFor();
  await page.locator('.rail-lang').click();
  await page.waitForFunction(() => document.documentElement.lang === 'en');

  const stopPrompt = `audit stop ${surface}`;
  await composer.fill(stopPrompt);
  await composer.press('Enter');
  await page.getByText('Fixture waiting for stop.', { exact: true }).waitFor();
  await page.locator('.composer').getByRole('button', { name: /Stop/ }).click();
  await page.waitForFunction(async id => (await window.sun.call('listSessions')).find(item => item.id === id)?.status === 'aborted', session.id);
  for (let attempt = 0; attempt < 100 && !closedStreams.has(stopPrompt); attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.ok(closedStreams.has(stopPrompt), `${surface} provider request stayed open`);
  for (const panel of ['knowledge', 'extensions', 'evolution', 'intel', 'automations', 'settings', 'chat']) {
    await page.locator(`[data-nav="${panel}"]`).click();
    assert.equal(await page.locator(`[data-nav="${panel}"].on`).count(), 1);
  }
  await page.getByText('Audit chat completed.', { exact: true }).waitFor();
  const row = page.locator('.session-row').filter({ hasText: `${surface} audit session` });
  await row.hover();
  await row.getByTitle('Pin to the top').click();
  await row.getByTitle('Unpin').waitFor();
  await row.hover();
  await row.getByTitle('Unpin').click();
  const search = page.locator('.session-search');
  await search.fill(`audit chat ${surface}`);
  await page.locator('.session').filter({ has: page.locator('.hit-snippet') }).filter({ hasText: `${surface} audit session` }).click();
  await search.clear();
  await page.locator('.chat-controls').getByTitle('Model', { exact: true }).selectOption('fixture/quota');
  await page.waitForFunction(async id => (await window.sun.call('listSessions')).find(item => item.id === id)?.model === 'fixture/quota', session.id);
  await composer.fill(`audit quota ${surface}`);
  await composer.press('Enter');
  const paused = page.locator('.banner').filter({ hasText: 'The model quota is exhausted.' });
  await paused.waitFor();
  await paused.locator('select').selectOption('fixture/model');
  await paused.getByRole('button', { name: 'Switch & resume' }).click();
  await page.getByText('Fixture recovered on the replacement model.', { exact: true }).waitFor();
  const resumed = await page.evaluate(id => window.sun.call('getEvents', id), session.id);
  assert.ok(resumed.some(event => event.type === 'run/status' && event.reason === 'quota'));
  assert.equal(resumed.filter(event => event.type === 'model/switch').length, 2);
  await composer.fill(`Audit attachments ${surface} @audit-cha`);
  await page.locator('.suggest').getByText('audit-chat.txt', { exact: true }).click();
  await page.locator('.composer input[type="file"]').setInputFiles({ name: 'audit.png', mimeType: 'image/png', buffer: Buffer.from(imageBase64, 'base64') });
  await page.locator('.composer .thumbs img').waitFor();
  await composer.press('Enter');
  await page.getByText('Fixture attachments received.', { exact: true }).waitFor();
  assert.ok(attachedRequests.has(surface));
  await page.getByRole('img', { name: 'attachment' }).waitFor();
  const durable = await page.evaluate(id => window.sun.call('getEvents', id), session.id);
  assert.equal(durable.findLast(event => event.type === 'user/message').images?.[0]?.mime, 'image/png');
  await page.getByTitle('Undo the last file edit step (checkpoint)').click();
  await page.getByText('Restored audit-chat.txt', { exact: true }).waitFor();
  await assert.rejects(readFile(join(cwd, 'audit-chat.txt')), { code: 'ENOENT' });
  console.log(`${surface}: chat streamed and persisted, approvals guarded both actions, Deny and Always allow applied, deliverables, review and undo worked, dock and context rendered, language switched, provider aborted, search and pin worked, quota recovered, and file/image attachments were replayable.`);
  return session.id;
}

async function exerciseBrowser(page, surface, sessionId, state) {
  const origin = `http://127.0.0.1:${model.address().port}`;
  await page.locator('[data-nav="settings"]').click();
  await page.locator('[data-settings-section="browser"]').click();
  const settings = page.locator('[data-settings-panel="browser"]');
  await settings.getByLabel('Website origin').fill(origin);
  await settings.getByLabel('Browser action').selectOption('browse');
  await settings.getByRole('button', { name: 'Allow', exact: true }).click();
  await settings.getByRole('status').getByText('Saved', { exact: true }).waitFor();
  await page.locator('[data-nav="chat"]').click();
  const composer = page.locator('.composer textarea');
  await composer.fill(`audit browser ${surface}`);
  await composer.press('Enter');
  const approval = page.locator('.approval').filter({ hasText: 'browser_navigate' });
  await approval.getByRole('button', { name: 'Allow', exact: true }).click();
  try {
    await page.getByText('Browser fixture opened.', { exact: true }).waitFor({ timeout: 75_000 });
  } catch (error) {
    const recent = await page.evaluate(id => window.sun.call('getEvents', id), sessionId);
    const info = await page.evaluate(id => window.sun.call('browserInfo', id), sessionId);
    const port = await readFile(join(state, 'browser', 'profiles', 'default', 'DevToolsActivePort'), 'utf8')
      .then(text => text.split('\n')[0], () => undefined);
    const targets = port ? await fetch(`http://127.0.0.1:${port}/json/list`)
      .then(response => response.json(), () => []) : [];
    console.error(`${surface} browser state`, JSON.stringify({ active: info.active, fixtureOpened: openedBrowserPages.has(surface), targets: targets.map(target => target.url) }));
    console.error(`${surface} browser diagnostic`, JSON.stringify(recent.slice(-10).map(event => ({
      type: event.type, status: event.status, reason: event.reason, name: event.name, output: event.output,
    }))));
    throw error;
  }
  const history = await page.evaluate(id => window.sun.call('getEvents', id), sessionId);
  const result = history.find(event => event.type === 'tool/result' && event.callId === 'audit-browser');
  assert.equal(result?.isError, false, result?.output);
  const dock = page.locator('.dock');
  await dock.getByRole('tab', { name: 'Browser' }).click();
  const panel = dock.locator('.browser-panel');
  await panel.locator('.browser-view img').waitFor();
  const view = panel.locator('.browser-view');
  await view.press('u');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(browserInput.has(surface), false);
  await panel.getByRole('button', { name: 'Take over' }).click();
  const handBack = panel.getByRole('button', { name: 'Hand back to agent' });
  await handBack.waitFor();
  await view.locator('img').click();
  await view.press('x');
  for (let attempt = 0; attempt < 100 && browserInput.get(surface) !== 'x'; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(browserInput.get(surface), 'x');
  await handBack.click();
  await panel.getByRole('button', { name: 'Take over' }).waitFor();
  assert.equal((await page.evaluate(id => window.sun.call('browserInfo', id), sessionId)).takeover, false);
  await view.press('z');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(browserInput.get(surface), 'x');
  console.log(`${surface}: the managed Chromium live view displayed a real frame, forwarded keyboard input only under control, and returned ownership.`);
}

async function seedPages(state) {
  const reports = join(state, 'intel', 'reports');
  const raw = join(state, 'intel', 'raw');
  const proposals = join(state, 'evolution', 'proposals');
  await Promise.all([reports, raw, proposals].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(reports, '2026-11-07.md'), '# Earlier fixture report\n');
  await writeFile(join(reports, '2026-11-08.md'), '# Pending fixture report\n\n> Analysis pending\n');
  await writeFile(join(raw, '2026-11-08.json'), JSON.stringify({ items: [], errors: [] }));
  for (const [id, type, title, content] of [
    ['fixture-accept', 'memory', 'Accept fixture memory', 'Keep test workspaces separate.'],
    ['fixture-reject', 'feature', 'Reject fixture idea', 'An intentionally rejected feature.'],
  ]) {
    await writeFile(join(proposals, `${id}.json`), JSON.stringify({
      id, type, title, content, rationale: 'Synthetic product audit.', source: { kind: 'manual', ref: 'audit' },
      status: 'pending', createdAt: '2026-11-07T12:00:00.000Z',
    }));
  }
}

async function exercisePages(page, surface, state) {
  const nav = id => page.locator(`[data-nav="${id}"]`).click();
  await nav('knowledge');
  await page.getByPlaceholder('Title', { exact: true }).fill('Audit solar note');
  await page.getByPlaceholder('Markdown…').fill('光伏组件保持本地隔离。');
  await page.getByRole('button', { name: 'Save to personal KB' }).click();
  await page.getByText(/Saved .*audit-solar-note/).waitFor();
  await page.getByPlaceholder('Search your notes…').fill('光伏组件');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.locator('.hit').getByText('Audit solar note', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Open memory settings' }).click();
  await page.locator('[data-settings-panel="memory"]').waitFor();

  await nav('intel');
  await page.getByRole('button', { name: '2026-11-07' }).click();
  await page.getByRole('heading', { name: 'Earlier fixture report' }).waitFor();
  await page.getByRole('button', { name: '2026-11-08' }).click();
  await page.getByRole('heading', { name: 'Pending fixture report' }).waitFor();
  await page.getByRole('button', { name: 'Analyze pending' }).click();
  await page.getByText('No items.', { exact: true }).waitFor();
  assert.match(await readFile(join(state, 'intel', 'reports', '2026-11-08.html'), 'utf8'), /No items/);

  await nav('evolution');
  const accept = page.locator('.proposal').filter({ hasText: 'Accept fixture memory' });
  const reject = page.locator('.proposal').filter({ hasText: 'Reject fixture idea' });
  await accept.getByRole('button', { name: 'Accept', exact: true }).click();
  await accept.getByText('accepted', { exact: true }).waitFor();
  await reject.getByRole('button', { name: 'Reject', exact: true }).click();
  await reject.getByText('rejected', { exact: true }).waitFor();
  assert.match(await readFile(join(state, 'memory', 'MEMORY.md'), 'utf8'), /Keep test workspaces separate/);
  await assert.rejects(readFile(join(state, 'evolution', 'backlog.md')), { code: 'ENOENT' });

  await nav('automations');
  await page.getByRole('button', { name: '+ New automation' }).click();
  const editor = page.locator('.automation-form');
  await editor.getByLabel('What should it do?').fill('audit portal automation');
  await editor.getByLabel('When (plain language or cron)').fill('every day at 23:59');
  await editor.getByPlaceholder('(from the prompt)').fill('Portal fixture automation');
  await editor.getByText(/59 23 \* \* \*/).waitFor();
  await editor.getByRole('button', { name: 'Create', exact: true }).click();
  const automation = page.locator('.automation').filter({ hasText: 'Portal fixture automation' });
  await automation.getByRole('checkbox').click();
  await automation.getByText('Off', { exact: true }).waitFor();
  await automation.getByRole('checkbox').click();
  await automation.getByText('On', { exact: true }).waitFor();
  await automation.getByRole('button', { name: /Run now/ }).click();
  await page.getByText('Portal automation completed.', { exact: true }).waitFor();
  await nav('automations');
  await automation.getByRole('button', { name: 'History (1)', exact: true }).click();
  await automation.locator('.run-row').click();
  await page.getByText('Portal automation completed.', { exact: true }).waitFor();
  await nav('automations');
  page.once('dialog', dialog => dialog.accept());
  await automation.getByRole('button', { name: 'Delete', exact: true }).click();
  await automation.waitFor({ state: 'detached' });
  console.log(`${surface}: knowledge write and CJK search, memory route, Intel listing and analysis, Evolution accept/reject, and automation create/run/history/delete all passed.`);
}

async function exerciseWorktree(page, surface) {
  const repo = join(home, `git-${surface.toLowerCase()}`);
  await mkdir(repo);
  const git = (...args) => execFileSync('git', args, { cwd: repo, env: { ...process.env, HOME: home }, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Audit fixture');
  git('config', 'user.email', 'audit@example.test');
  await writeFile(join(repo, 'README.md'), '# Git audit fixture\n');
  git('add', 'README.md');
  git('commit', '-qm', 'Initial fixture');
  await page.locator('[data-nav="chat"]').click();
  const open = async title => {
    await page.evaluate(({ cwd, title }) => window.sun.call('createSession', {
      cwd, mode: 'coding', worktree: true, approval: 'auto-edit', title,
    }), { cwd: repo, title });
    await page.locator('.session').filter({ hasText: title }).click();
  };
  await open(`${surface} worktree edit`);
  const composer = page.locator('.composer textarea');
  await composer.fill('audit worktree edit');
  await composer.press('Enter');
  await page.getByText('Worktree edit completed.', { exact: true }).waitFor();
  await page.locator('.chat-head .dot-idle').waitFor();
  await assert.rejects(readFile(join(repo, 'audit-tree.txt')), { code: 'ENOENT' });
  await page.getByTitle('Worktree changes').click();
  const panel = page.locator('[data-worktree]');
  await panel.locator('.change-files').getByText(/audit-tree\.txt/).waitFor();
  await panel.getByText('Diff', { exact: true }).click();
  assert.match(await panel.locator('pre.diff').innerText(), /\+isolated tree change/);
  await panel.getByRole('button', { name: 'Merge (squash)' }).click();
  await page.locator('[data-worktree="merged"]').waitFor();
  assert.equal(await readFile(join(repo, 'audit-tree.txt'), 'utf8'), 'isolated tree change\n');
  assert.match(git('diff', '--cached', '--name-only'), /audit-tree\.txt/);
  git('commit', '-qm', 'Squash fixture');
  await open(`${surface} worktree discard`);
  if (await panel.count() === 0) await page.getByTitle('Worktree changes').click();
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.locator('[data-worktree="discarded"]').waitFor();
  console.log(`${surface}: the worktree diff was inspected, squash merged to the index, and a separate clean worktree was discarded.`);
}

try {
  const ready = once(model, 'listening');
  model.listen(0, '127.0.0.1');
  await ready;
  // The isolated HOME has no login keychain; macOS Chromium stalls its first request waiting for one.
  const chrome = findChrome();
  assert.ok(chrome, 'Chrome or Chromium is required');
  const chromePath = join(home, 'chrome-fixture.sh');
  await writeFile(chromePath, `#!/bin/sh\nexec ${JSON.stringify(chrome)} --use-mock-keychain "$@"\n`);
  await chmod(chromePath, 0o755);
  const config = {
    browser: { chromePath },
    defaultModel: 'fixture/model', fallbackModels: [], titles: 'first-message', ui: { language: 'en' },
    intel: { sources: [] },
    providers: { fixture: { type: 'openai', baseUrl: `http://127.0.0.1:${model.address().port}`, apiKey: 'offline-fixture', models: ['model', 'quota'], vision: true } },
  };
  const desktopHome = join(home, 'desktop-state');
  await mkdir(desktopHome);
  await writeFile(join(desktopHome, 'config.json'), JSON.stringify(config));
  await seedPages(desktopHome);
  app = await electron.launch({
    executablePath: require('electron'), args: [`--user-data-dir=${join(home, 'electron')}`, appPath],
    env: { ...process.env, HOME: home, SUN_HOME: desktopHome, SUN_NO_GATEWAY: '1', SUN_SKIP_SHELL_ENV: '1' },
  });
  const desktop = await app.firstWindow();
  await exerciseBrowser(desktop, 'Electron', await exerciseChat(desktop, 'Electron'), desktopHome);
  await exercisePages(desktop, 'Electron', desktopHome);
  await exerciseWorktree(desktop, 'Electron');

  const gatewayHome = join(home, 'gateway-state');
  await mkdir(gatewayHome);
  await writeFile(join(gatewayHome, 'config.json'), JSON.stringify(config));
  await seedPages(gatewayHome);
  process.env.SUN_HOME = gatewayHome;
  host = new HarnessHost({ connectMcp: false, loadPlugins: false, shellHooks: false });
  await host.init();
  gateway = await startGateway(host, { port: 0, webRoot });
  const web = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    void window.loadURL(url);
  }, `${gateway.url}/#token=${gateway.token}`);
  const webPage = await web;
  await exerciseBrowser(webPage, 'Gateway', await exerciseChat(webPage, 'Gateway'), gatewayHome);
  await exercisePages(webPage, 'Gateway', gatewayHome);
  await exerciseWorktree(webPage, 'Gateway');
} finally {
  await app?.close();
  const profiles = join(home, 'desktop-state', 'browser');
  survivors = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(profiles));
  survivors.forEach(line => process.kill(Number(line.trim().split(/\s+/)[0]), 'SIGKILL'));
  await gateway?.close();
  await host?.dispose();
  model.closeAllConnections();
  if (model.listening) await new Promise(resolve => model.close(resolve));
  await rm(home, { recursive: true, force: true });
}
assert.deepEqual(survivors, [], 'quitting the desktop app stops its managed Chromium');
console.log('Electron: quitting the app stopped its managed Chromium.');

const signalHome = await mkdtemp(join(tmpdir(), 'sun-chat-signal-'));
try {
  const signalled = await electron.launch({
    executablePath: require('electron'), args: [`--user-data-dir=${join(signalHome, 'electron')}`, appPath],
    env: { ...process.env, HOME: signalHome, SUN_HOME: signalHome, SUN_NO_GATEWAY: '1', SUN_SKIP_SHELL_ENV: '1' },
  });
  await (await signalled.firstWindow()).locator('.hero').waitFor();
  const child = signalled.process();
  const exited = once(child, 'exit').then(() => true);
  child.kill('SIGTERM');
  const quit = await Promise.race([exited, new Promise(resolve => setTimeout(() => resolve(false), 10_000))]);
  if (!quit) child.kill('SIGKILL');
  assert.ok(quit, 'one SIGTERM quits the desktop app');
  console.log('Electron: one SIGTERM quit the app after host disposal.');
} finally {
  await rm(signalHome, { recursive: true, force: true });
}
