// Offline settings acceptance on Electron IPC and the served web renderer.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessHost, MockProvider, SETTINGS_PROTOCOL_VERSION as version, findChrome, startGateway } from '@sun/core';
import { _electron as electron } from 'playwright-core';

const require = createRequire(import.meta.url);
const home = mkdtempSync(join(tmpdir(), 'sun-settings-e2e-'));
const config = join(home, 'config.json');
const appPath = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const webRoot = fileURLToPath(new URL('../out/renderer', import.meta.url));
const cliPath = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
const fixtureKey = 'SUN_TEST_ONLY_E2E_SECRET';
const env = { ...process.env, SUN_HOME: home, SUN_SKIP_SHELL_ENV: '1', SUN_NO_GATEWAY: '1' };
process.env.SUN_HOME = home;
let app;
let host;
let gateway;

const runCli = (...args) => execFileSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' });
const launch = (useGateway = false) => electron.launch({
  executablePath: require('electron'),
  args: [`--user-data-dir=${join(home, 'electron')}`, appPath],
  env: { ...env, SUN_NO_GATEWAY: useGateway ? '' : '1' },
});
const readConfig = () => JSON.parse(readFileSync(config, 'utf8'));

async function openSettings(page) {
  await page.locator('[data-nav="settings"]').click();
  await page.getByRole('heading', { name: 'General', exact: true }).waitFor();
}

async function searchMaxSteps(page, query, language = 'en') {
  const search = page.getByRole('searchbox', { name: language === 'en' ? 'Search settings' : '搜索设置' });
  await search.fill(query);
  const match = page.locator('[data-settings-section="general"][data-settings-field="maxSteps"]');
  await match.waitFor();
  await search.press('ArrowDown');
  assert.equal(await match.evaluate(el => el === document.activeElement), true);
  await match.press('Enter');
  await page.waitForFunction(() => document.activeElement?.id === 'settings-field-maxSteps');
  assert.match(page.url(), /#settings\/general\/maxSteps$/);
}

async function resize(page, width) {
  await page.setViewportSize({ width, height: 900 });
  await page.waitForFunction(value => window.innerWidth === value, width);
  const layout = await page.locator('.settings-layout').evaluate(el => ({
    scroll: el.scrollWidth,
    width: el.clientWidth,
    navWidth: el.querySelector('nav')?.getBoundingClientRect().width,
    panelWidth: el.querySelector('.settings-panel')?.getBoundingClientRect().width,
  }));
  assert.ok(layout.scroll <= layout.width + 1, `Settings overflow at ${width}: ${JSON.stringify(layout)}`);
  assert.ok(layout.navWidth >= 140 && layout.panelWidth >= 300, `Settings layout too narrow: ${JSON.stringify(layout)}`);
}

async function language(page, locale, fromChinese = false) {
  const nav = page.getByRole('navigation', { name: fromChinese ? '设置分区' : 'Settings sections' });
  await nav.locator('[data-settings-section="language"]').click();
  await page.locator('[data-settings-panel="language"] select').selectOption(locale);
  await page.getByRole('button', { name: fromChinese ? '保存更改' : 'Save changes', exact: true }).click();
  await page.waitForFunction(value => document.documentElement.lang === value, locale);
}

async function patchUser(page, changes) {
  return page.evaluate(async ({ version, changes }) => {
    const snapshot = await window.sun.call('getSettings', version);
    return window.sun.call('updateSettings', { scope: 'user', expectedRevision: snapshot.revision, changes }, version);
  }, { version, changes });
}

async function appearanceAndKeyboard(page) {
  const baseSize = await page.evaluate(() => 16 * parseFloat(getComputedStyle(document.body).fontSize) / parseFloat(document.documentElement.style.fontSize));
  assert.equal((await patchUser(page, {
    'ui.theme': 'light', 'ui.textScale': 1.25, 'ui.reducedMotion': 'reduce', 'ui.shortcuts.palette': 'Primary+Shift+L',
  })).ok, true);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.motion === 'reduce');
  await page.waitForFunction(expected => Math.abs(parseFloat(getComputedStyle(document.body).fontSize) - expected) < 0.01, baseSize * 1.25);
  const primary = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${primary}+K`);
  assert.equal(await page.locator('.palette').count(), 0);
  await page.keyboard.press(`${primary}+Shift+L`);
  await page.locator('.palette').waitFor();
  await page.keyboard.press('Escape');
  assert.equal((await patchUser(page, {
    'ui.theme': 'dark', 'ui.textScale': 1, 'ui.reducedMotion': 'system', 'ui.shortcuts.palette': 'Primary+K',
  })).ok, true);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  assert.equal((await patchUser(page, { 'ui.theme': 'system' })).ok, true);
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light' && document.documentElement.dataset.motion === 'reduce');
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'no-preference' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && document.documentElement.dataset.motion === 'full');
  assert.equal((await patchUser(page, { 'ui.theme': 'dark' })).ok, true);
}

async function globalShortcutRollback(page) {
  const old = process.platform === 'darwin' ? 'Command+Shift+Y' : 'Control+Shift+Y';
  const reserved = process.platform === 'darwin' ? 'Command+Shift+U' : 'Control+Shift+U';
  assert.equal((await patchUser(page, { 'ui.mini': true, 'ui.shortcuts.mini': 'Primary+Shift+Y' })).ok, true);
  assert.equal(await app.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), old), true);
  assert.equal(await app.evaluate(({ globalShortcut }, key) => globalShortcut.register(key, () => {}), reserved), true);
  try {
    const previous = readFileSync(config, 'utf8');
    const result = await patchUser(page, { 'ui.shortcuts.mini': 'Primary+Shift+U' });
    assert.deepEqual(result, { ok: false, code: 'INVALID', fields: { 'ui.shortcuts.mini': 'SHORTCUT_UNAVAILABLE' } });
    assert.equal(readFileSync(config, 'utf8'), previous);
    assert.equal(await app.evaluate(({ globalShortcut }, key) => globalShortcut.isRegistered(key), old), true);
    assert.deepEqual(await page.evaluate(() => window.sun.call('desktopShortcutStatus')), { active: old, state: 'active' });
  } finally {
    await app.evaluate(({ globalShortcut }, key) => globalShortcut.unregister(key), reserved);
    assert.equal((await patchUser(page, { 'ui.mini': false })).ok, true);
  }
}

async function openPanel(page, id) {
  await page.locator(`[data-settings-section="${id}"]`).click();
  const panel = page.locator(`[data-settings-panel="${id}"]`);
  await panel.waitFor();
  return panel;
}

async function browserPermissionControls(page, surface) {
  const panel = await openPanel(page, 'browser');
  const origin = surface === 'Electron' ? 'https://browser-desktop.example' : 'https://browser-web.example';
  await panel.getByLabel('Website origin').fill(`${origin}/fixture?private=fixture`);
  await panel.getByLabel('Browser action').selectOption('upload');
  await panel.getByRole('button', { name: 'Allow', exact: true }).click();
  await panel.getByRole('status').getByText('Saved', { exact: true }).waitFor();
  const row = panel.locator('.row').filter({ has: page.getByText(origin, { exact: true }) });
  await row.getByText('Upload', { exact: true }).waitFor();
  assert.equal(await row.getByText('Allow', { exact: true }).count(), 1);
  const read = () => page.evaluate(version => window.sun.call('browserPermissions', version), version);
  assert.deepEqual((await read()).rules.filter(rule => rule.origin === origin), [{ origin, action: 'upload', decision: 'allow' }]);
  await row.getByRole('button', { name: 'Reset to Ask', exact: true }).click();
  await row.waitFor({ state: 'detached' });
  assert.equal((await read()).rules.some(rule => rule.origin === origin), false);
  console.log(`${surface} reviews independent browser origin actions and restores the default Ask decision.`);
}

async function browserFileTransfers(page, surface, provider) {
  if (!findChrome()) {
    console.log(`${surface} browser transfer fixture skipped because Chromium is unavailable.`);
    return;
  }
  const server = createServer((request, response) => {
    if (request.url === '/fixture.bin') {
      response.setHeader('content-disposition', 'attachment; filename="fixture.bin"');
      response.end('downloaded fixture');
      return;
    }
    response.end(`<!doctype html><title>Transfer fixture</title><label>Fixture file <input type="file"></label>
      <output></output><script>document.querySelector('input').onchange = async ({ target }) => {
        document.querySelector('output').textContent = await target.files[0].text();
      };</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const title = `${surface} file transfer fixture`;
  const session = host.createSession({ cwd: home, mode: 'agent', approval: 'full-auto', title });
  const call = (name, args) => ({ id: `${session.id}-${name}`, name, arguments: JSON.stringify(args) });
  try {
    for (const action of ['browse', 'upload', 'download']) {
      const { revision } = host.browser.permissions.snapshot();
      assert.equal(host.browser.permissions.update({ origin, action, decision: 'allow', expectedRevision: revision }).ok, true);
    }
    provider.push({ text: '', toolCalls: [call('browser_navigate', { url: origin })] });
    provider.push({ text: 'Browser opened', toolCalls: [] });
    await host.send(session.id, 'Open the offline transfer fixture.');
    await host.wait(session.id);
    await page.locator('[data-nav="chat"]').click();
    await page.locator('.session-title').getByText(title, { exact: true }).click();
    await page.getByRole('button', { name: '◎ Browser' }).click();
    const chooser = page.getByLabel('Choose a browser upload');
    await chooser.waitFor();
    const payload = Buffer.from(`${surface} private fixture bytes`);
    await chooser.setInputFiles({ name: 'reviewed.txt', mimeType: 'text/plain', buffer: payload });
    await page.getByText(`Approve reviewed.txt (${payload.length} bytes) for ${origin}?`, { exact: true }).waitFor();
    assert.deepEqual(host.browser.listUploads(session.id), []);
    await page.getByRole('button', { name: 'Approve file for this page', exact: true }).click();
    await page.getByText('The agent can use this file once on the approved page.', { exact: true }).waitFor();
    const [approval] = host.browser.listUploads(session.id);
    const snap = await host.browser.snapshot(session.id);
    const input = snap.split('\n').find(line => /Fixture file|Choose File/i.test(line) && line.includes('[ref='));
    const ref = /\[ref=(e\w+)\]/.exec(input)?.[1];
    assert.ok(ref, snap);
    provider.push({ text: '', toolCalls: [
      call('browser_upload', { ref, handle: approval.handle }),
      call('browser_download', { url: `${origin}/fixture.bin` }),
    ] });
    provider.push({ text: 'Transfers finished', toolCalls: [] });
    await host.send(session.id, 'Use the approved file and download the fixture.');
    await host.wait(session.id);
    const events = host.getEvents(session.id);
    assert.equal(JSON.stringify(events).includes(payload.toString('base64')), false);
    assert.equal(JSON.stringify(events).includes(payload.toString('utf8')), false);
    const download = events.find(event => event.type === 'tool/result' && event.callId === call('browser_download').id);
    assert.ok(download, JSON.stringify(events.map(event => event.type)));
    assert.equal(download.isError, false, download.output);
    const artifact = JSON.parse(download.output.replace(/^<untrusted[^>]*>\n|\n<\/untrusted>$/g, ''));
    assert.equal(readFileSync(artifact.path, 'utf8'), 'downloaded fixture');
    assert.equal(await host.browser.evaluate(session.id, 'document.querySelector("output").textContent'), payload.toString('utf8'));
    assert.deepEqual(host.browser.listUploads(session.id), []);
    console.log(`${surface} previews a selected file, authorizes its exact bytes once, and stages the browser download on the execution host.`);
  } finally {
    await host.browser.closeTab(session.id);
    server.close();
  }
}

async function pluginControls(page, surface, work) {
  await openPanel(page, 'plugins');
  const plugin = page.locator('[data-plugin="fixture"]');
  await plugin.getByText('Disabled', { exact: true }).waitFor();
  await plugin.getByText('Requested actions · Tools, Network', { exact: true }).waitFor();
  assert.equal((await plugin.innerText()).includes(fixtureKey), false);
  await plugin.getByRole('button', { name: 'Enable plugin' }).click();
  await plugin.getByText('Active', { exact: true }).waitFor();
  await plugin.getByText('fixture_plugin_tool', { exact: true }).waitFor();
  try {
    await work?.start();
    await plugin.getByRole('button', { name: 'Disable plugin' }).click();
    if (work) {
      await plugin.getByText('Draining', { exact: true }).waitFor();
      await plugin.getByText('Calls finishing · 1', { exact: true }).waitFor();
      assert.equal(await plugin.getByRole('button', { name: 'Enable plugin' }).isDisabled(), true);
    }
  } finally {
    await work?.finish();
  }
  await plugin.getByText('Disabled', { exact: true }).waitFor();
  assert.equal(await plugin.getByText('fixture_plugin_tool', { exact: true }).count(), 0);
  assert.deepEqual(readConfig().plugins.disabled, ['fixture']);
  console.log(`${surface} inspected the disabled plugin manifest, enabled its registration, and revoked it through settings.`);
  if (work) console.log(`${surface} streamed Draining with one call, then Disabled after settlement.`);
}

async function personalControls(page) {
  await page.locator('[data-nav="chat"]').click();
  await openSettings(page);
  await page.getByLabel('Default mode', { exact: true }).selectOption('assistant');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal(readConfig().defaultMode, 'assistant');

  const appearance = await openPanel(page, 'appearance');
  await appearance.getByLabel('Theme').selectOption('light');
  await appearance.getByLabel('Text scale').fill('1.15');
  await appearance.getByRole('button', { name: 'Save changes' }).click();
  await appearance.getByText('Saved', { exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light'
    && parseFloat(document.documentElement.style.fontSize) === 16 * 1.15);

  const profile = await openPanel(page, 'profile');
  await profile.getByLabel('User profile').fill('Discardable local edit');
  assert.equal(await profile.getByLabel('User profile').getAttribute('maxlength'), '1375');
  assert.equal(await page.evaluate(() => window.sun.call('setUserProfile', 'External edit', '')), true);
  await profile.getByRole('button', { name: 'Save changes' }).click();
  await profile.getByText('The notes changed on the host. Reload them before saving.').waitFor();
  assert.equal(await profile.getByLabel('User profile').inputValue(), 'Discardable local edit');
  await profile.getByRole('button', { name: 'Reload notes' }).click();
  await profile.getByLabel('User profile').fill('Profile fixture');
  await profile.getByRole('button', { name: 'Save changes' }).click();
  await profile.getByText('Saved', { exact: true }).waitFor();
  assert.equal(readFileSync(join(home, 'memory', 'USER.md'), 'utf8'), 'Profile fixture\n');

  const instructions = await openPanel(page, 'instructions');
  await instructions.getByLabel('Personal instructions').fill('Instructions fixture');
  const discard = page.waitForEvent('dialog');
  const navigation = page.locator('[data-settings-section="profile"]').click();
  await (await discard).dismiss();
  await navigation;
  assert.equal(await instructions.getByLabel('Personal instructions').inputValue(), 'Instructions fixture');
  await instructions.getByRole('button', { name: 'Save changes' }).click();
  await instructions.getByText('Saved', { exact: true }).waitFor();
  assert.equal(readFileSync(join(home, 'memory', 'INSTRUCTIONS.md'), 'utf8'), 'Instructions fixture');
  assert.equal(readFileSync(join(home, 'memory', 'USER.md'), 'utf8'), 'Profile fixture\n');
  console.log('Electron forms save appearance and default mode, and keep profile and instructions separate with conflict and discard handling.');
}

async function dataControls(page, surface) {
  await openSettings(page);
  const title = `Data fixture ${surface}`;
  const date = '2026-01-01T00:00:00Z';
  const lines = [
    { type: 'session/meta', id: 'foreign', title, cwd: join(home, 'missing-workspace'), mode: 'coding', model: 'fixture/model', createdAt: date },
    { type: 'user/message', text: 'portable data fixture' },
  ].map((body, seq) => JSON.stringify({ ...body, seq, ts: date })).join('\n');
  const transfer = await openPanel(page, 'data-controls');
  await transfer.getByLabel('Session file').setInputFiles({ name: 'fixture.jsonl', mimeType: 'application/x-ndjson', buffer: Buffer.from(lines) });
  await transfer.getByRole('button', { name: 'Import session', exact: true }).click();
  await transfer.getByText('Choose an existing absolute workspace on the execution host.').waitFor();
  await transfer.getByLabel('Replacement workspace (optional)').fill(home);
  await transfer.getByRole('button', { name: 'Import session', exact: true }).click();
  await transfer.getByText(`Imported ${title}`, { exact: true }).waitFor();
  const id = await page.evaluate(async title => (await window.sun.call('listSessions')).find(item => item.title === title).id, title);

  await transfer.getByLabel('Session to export').selectOption(id);
  const destination = join(home, `${surface.replaceAll(' ', '-')}-download.sunbundle`);
  await app.evaluate(({ session }, path) => {
    globalThis.__sunTransferDownload = new Promise(resolve => {
      session.defaultSession.once('will-download', (_event, item) => {
        const name = item.getFilename();
        item.setSavePath(path);
        item.once('done', (_event, state) => resolve({ name, state }));
      });
    });
  }, destination);
  await transfer.getByRole('button', { name: 'Download session bundle' }).click();
  const download = await Promise.race([
    app.evaluate(() => globalThis.__sunTransferDownload),
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error('Session bundle download did not finish')), 10_000).unref()),
  ]);
  assert.deepEqual(download, { name: `${id}.sunbundle`, state: 'completed' });
  const bytes = readFileSync(destination);
  assert.deepEqual([...bytes.subarray(0, 2)], [0x1f, 0x8b]);
  await transfer.getByLabel('Session file').setInputFiles({
    name: download.name, mimeType: 'application/octet-stream', buffer: bytes,
  });
  await transfer.getByRole('button', { name: 'Import session', exact: true }).click();
  await transfer.getByText(`Imported ${title}`, { exact: true }).waitFor();
  const copies = await page.evaluate(async title => (await window.sun.call('listSessions')).filter(item => item.title === title), title);
  assert.equal(copies.length, 2);
  assert.notEqual(copies[0].id, copies[1].id);

  const archive = archived => page.evaluate(({ id, archived }) => window.sun.call('setSessionFlags', id, { archived }), { id, archived });
  await archive(true);
  const archives = await openPanel(page, 'archives');
  await archives.getByLabel('Search archived chats').fill(title);
  const archivedRow = archives.locator(`[data-archive-id="${id}"]`);
  await archivedRow.getByRole('button', { name: 'Restore chat' }).click();
  await archives.getByText(`Restored ${title}`, { exact: true }).waitFor();
  assert.equal((await page.evaluate(async id => (await window.sun.call('listSessions')).find(item => item.id === id), id)).archived, undefined);

  await archive(true);
  const storage = await openPanel(page, 'storage');
  const row = storage.locator(`[data-storage-item="session:${id}"] input`);
  await row.check();
  await storage.getByRole('button', { name: 'Preview cleanup' }).click();
  await storage.getByRole('heading', { name: 'Review cleanup' }).waitFor();
  await archive(false);
  await storage.getByRole('button', { name: 'Move selected to trash' }).click();
  await storage.getByText('Storage changed. Preview the current selection again.').waitFor();
  assert.equal(await page.evaluate(async id => (await window.sun.call('listSessions')).some(item => item.id === id), id), true);
  await archive(true);
  await storage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await row.check();
  await storage.getByRole('button', { name: 'Preview cleanup' }).click();
  await storage.getByRole('button', { name: 'Move selected to trash' }).click();
  await storage.getByText('Moved 1 resources to trash. Skipped 0.').waitFor();
  await storage.getByRole('heading', { name: 'Recent trash operations' }).waitFor();
  assert.equal(await page.evaluate(async id => (await window.sun.call('listSessions')).some(item => item.id === id), id), false);
  if (surface === 'Electron') {
    assert.equal(await storage.getByLabel('Automatic cleanup age in days').inputValue(), '0');
    await storage.getByLabel('Days to keep items in trash').fill('8');
    await storage.getByRole('button', { name: 'Save changes', exact: true }).click();
    await storage.getByText('Saved', { exact: true }).waitFor();
    assert.equal(readConfig().storage.trashDays, 8);
  }
  console.log(`${surface} settings import JSONL with an explicit workspace, round-trip a bundle, restore the archive ID, reject stale cleanup, and move the confirmed log to trash.`);
}

async function hookControls(page, surface) {
  const workspace = join(home, `hooks-${surface.replaceAll(' ', '-')}`);
  const file = join(workspace, '.sun', 'hooks.json');
  const ran = join(workspace, 'reviewed-fixture.txt');
  const changed = join(workspace, 'changed-fixture.txt');
  mkdirSync(join(workspace, '.sun'), { recursive: true });
  writeFileSync(file, JSON.stringify({
    sessionStart: [{ id: 'fixture-start', command: 'touch reviewed-fixture.txt; printf reviewed-output' }],
    postToolUse: [{ id: 'bad-matcher', matcher: '^(a+)+$', command: 'false' }],
  }));
  await openSettings(page);
  const panel = await openPanel(page, 'hooks');
  await panel.getByLabel('Hook workspace').fill(workspace);
  await panel.getByRole('button', { name: 'Load hooks' }).click();
  await panel.getByText('Invalid or unsupported matcher', { exact: true }).waitFor();
  const row = panel.locator('[data-hook-id]').filter({ hasText: 'fixture-start' });
  await row.getByText('Needs review', { exact: false }).waitFor();
  await panel.getByRole('button', { name: 'Preview fixture' }).click();
  await panel.locator('[data-hook-payload]').waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Run reviewed hook' }).isEnabled(), false);
  assert.equal(existsSync(ran), false);
  await row.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Trust selected hooks' }).click();
  await panel.getByText('Hook review saved.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Preview fixture' }).click();
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Run reviewed hook' }).click();
  await panel.getByText('Completed · exit 0', { exact: true }).waitFor();
  assert.equal(await panel.locator('[data-hook-stdout]').textContent(), 'reviewed-output');
  assert.equal(existsSync(ran), true);
  writeFileSync(file, JSON.stringify({ sessionStart: [{ id: 'fixture-start', command: 'touch changed-fixture.txt' }] }));
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Run reviewed hook' }).click();
  await panel.getByText('The hook changed. Reload and review the latest definition.').waitFor();
  assert.equal(existsSync(changed), false);
  const ready = join(workspace, 'cancel-ready.txt');
  const late = join(workspace, 'cancel-late.txt');
  writeFileSync(file, JSON.stringify({
    sessionStart: [{ id: 'fixture-start', command: 'touch cancel-ready.txt; (sleep 0.6; touch cancel-late.txt) & wait' }],
  }));
  await panel.getByRole('button', { name: 'Load hooks' }).click();
  await row.getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Trust selected hooks' }).click();
  await panel.getByText('Hook review saved.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Preview fixture' }).click();
  page.once('dialog', dialog => dialog.accept());
  await panel.getByRole('button', { name: 'Run reviewed hook' }).click();
  for (let i = 0; i < 40 && !existsSync(ready); i++) await delay(15);
  assert.equal(existsSync(ready), true);
  await panel.getByRole('button', { name: 'Cancel hook run' }).click();
  await panel.getByText('Cancelled · exit 130', { exact: true }).waitFor();
  await delay(620);
  assert.equal(existsSync(late), false);
  console.log(`${surface} hooks show matcher diagnostics, preview without effects, execute or cancel after review, and reject stale trust after editing the source.`);
}

function trashCrash() {
  const crashHome = mkdtempSync(join(tmpdir(), 'sun-trash-crash-'));
  const storage = new URL('../../../packages/core/dist/settings/storage.js', import.meta.url).href;
  const first = join(crashHome, 'attachments', 'owner', 'first.png');
  const second = join(crashHome, 'attachments', 'owner', 'second.png');
  mkdirSync(join(crashHome, 'attachments', 'owner'), { recursive: true });
  writeFileSync(first, 'old first');
  writeFileSync(second, 'old second');
  const run = script => spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...env, SUN_HOME: crashHome }, encoding: 'utf8',
  });
  try {
    const killed = run(`
      import { renameSync } from 'node:fs';
      import { StorageManager } from ${JSON.stringify(storage)};
      const manager = new StorageManager({ rename(from, to) {
        renameSync(from, to);
        process.kill(process.pid, 'SIGKILL');
      } });
      const ids = manager.inventory().items.map(item => item.id);
      manager.move({ ids, revision: manager.preview(ids).revision });
    `);
    assert.equal(killed.signal, 'SIGKILL', killed.stderr);
    assert.equal([first, second].filter(existsSync).length, 1);
    writeFileSync(first, 'new first');
    writeFileSync(second, 'new second');
    const restored = run(`
      import { StorageManager } from ${JSON.stringify(storage)};
      const manager = new StorageManager();
      manager.reconcile();
      console.log(JSON.stringify(manager.operations()[0]));
    `);
    assert.equal(restored.status, 0, restored.stderr);
    const operation = JSON.parse(restored.stdout);
    assert.deepEqual([operation.moved, operation.skipped, operation.pending], [1, 1, 0]);
    assert.equal(readFileSync(first, 'utf8'), 'new first');
    assert.equal(readFileSync(second, 'utf8'), 'new second');
    console.log('A real SIGKILL after the first rename leaves a recoverable journal. Restart keeps both replacement files.');
  } finally {
    rmSync(crashHome, { recursive: true, force: true });
  }
}

async function browserProfileLifecycle() {
  const executable = findChrome();
  if (!executable) {
    console.log('Browser profile lifecycle skipped because Chromium is unavailable.');
    return;
  }
  const isolated = mkdtempSync(join(tmpdir(), 'sun-browser-storage-'));
  const profile = join(isolated, 'browser', 'profiles', 'offline-fixture');
  mkdirSync(profile, { recursive: true });
  const browser = spawn(executable, [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const closed = once(browser, 'close');
  const previousHome = process.env.SUN_HOME;
  try {
    for (let i = 0; i < 80 && !existsSync(join(profile, 'DevToolsActivePort')); i++) await delay(100);
    assert.equal(existsSync(join(profile, 'DevToolsActivePort')), true);
    process.env.SUN_HOME = isolated;
    const { StorageManager } = await import('../../../packages/core/dist/settings/storage.js');
    const manager = new StorageManager();
    const row = () => manager.inventory(true).items.find(item => item.label === 'offline-fixture');
    assert.equal(row()?.reason, 'ACTIVE');
    browser.kill();
    await closed;
    const stopped = row();
    assert.equal(stopped?.reason, undefined);
    const ids = [stopped.id];
    const preview = manager.preview(ids, true);
    assert.throws(() => manager.move({ ids, revision: preview.revision, includeProfiles: true }), /confirmation/i);
    assert.equal(manager.move({ ids, revision: preview.revision, includeProfiles: true, confirmProfiles: true }).moved, 1);
    assert.equal(existsSync(profile), false);
    console.log('A real Chromium profile stays protected while running and moves to trash only after exit and explicit profile confirmation.');
  } finally {
    process.env.SUN_HOME = previousHome;
    browser.kill();
    await closed.catch(() => undefined);
    rmSync(isolated, { recursive: true, force: true });
  }
}

async function miniStopsRun(page, provider) {
  assert.equal(await page.evaluate(async () => (await window.sun.call('appInfo')).mode), 'gateway');
  assert.equal(await page.evaluate(async () => (await window.sun.call('getPersonalInstructions'))), 'Instructions fixture');
  assert.equal(await page.getByLabel('Default mode', { exact: true }).inputValue(), 'assistant');
  await assert.rejects(page.evaluate(() => window.sun.call('getMiniSnapshot')), /DESKTOP_METHOD_UNAVAILABLE/);

  const miniSettings = await openPanel(page, 'mini');
  await miniSettings.getByLabel('Enable Mini').check();
  await miniSettings.getByRole('button', { name: 'Save changes' }).click();
  await miniSettings.getByText('Saved', { exact: true }).waitFor();
  await miniSettings.getByText('Global shortcut', { exact: false }).waitFor();
  const started = Promise.withResolvers();
  let cancelled = false;
  provider.push(request => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => {
      cancelled = true;
      reject(request.signal.reason);
    }, { once: true });
    started.resolve();
  }));
  const run = host.createSession({ cwd: home, mode: 'coding' });
  await host.send(run.id, 'Mini real stop fixture');
  await Promise.race([started.promise, new Promise((_resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Mock provider never started')), 5000);
    timeout.unref();
  })]);

  const opening = app.waitForEvent('window');
  await miniSettings.getByRole('button', { name: 'Show Mini' }).click();
  const mini = await opening;
  mini.setDefaultTimeout(12_000);
  await mini.getByRole('button', { name: 'Stop run', exact: true }).waitFor();
  const panel = await app.browserWindow(mini);
  assert.equal(await panel.evaluate(window => window.isAlwaysOnTop()), true);
  await assert.rejects(mini.evaluate(() => window.sun.call('listSessions')), /MINI_METHOD_UNAVAILABLE/);
  const session = host.listSessions().find(item => item.id === run.id);
  await mini.getByText(session.title, { exact: true }).waitFor();

  await mini.getByRole('button', { name: 'Open chat', exact: true }).click();
  await page.locator('.chat-title h2').filter({ hasText: session.title }).waitFor();
  await openSettings(page);
  await openPanel(page, 'mini');
  await page.getByRole('button', { name: 'Show Mini' }).click();
  await mini.getByRole('button', { name: 'Stop run', exact: true }).click();
  await mini.getByText('No active run', { exact: true }).waitFor();
  assert.equal(cancelled, true);
  assert.equal(host.listSessions().find(item => item.id === run.id).status, 'aborted');

  const closed = mini.waitForEvent('close');
  await miniSettings.getByLabel('Enable Mini').uncheck();
  await miniSettings.getByRole('button', { name: 'Save changes' }).click();
  await closed;
  await miniSettings.getByText('Saved', { exact: true }).waitFor();
  console.log('Electron Mini is isolated, opens the active chat, aborts the live gateway provider request, and closes when disabled.');
}

async function notificationAndVoice(page) {
  await page.evaluate(() => {
    window.__settingsAlerts = [];
    window.__settingsPermissionRequests = 0;
    globalThis.Notification = class {
      static permission = 'default';
      static requestPermission() {
        window.__settingsPermissionRequests++;
        this.permission = 'granted';
        return Promise.resolve(this.permission);
      }
      constructor(title, options) { window.__settingsAlerts.push({ title, ...options }); }
    };
    document.hasFocus = () => false;
  });
  await openSettings(page);
  const notifications = await openPanel(page, 'notifications');
  await notifications.getByText('Permission not requested', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__settingsPermissionRequests), 0);
  await notifications.getByRole('button', { name: 'Allow notifications', exact: true }).click();
  await notifications.getByText('Allowed', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__settingsPermissionRequests), 1);
  const summary = host.createSession({ mode: 'coding', cwd: home, title: 'Settings voice fixture', model: 'fixture/model' });
  await host.send(summary.id, 'Offline notification fixture');
  await host.wait(summary.id);
  await page.waitForFunction(() => window.__settingsAlerts.length === 1);
  const terminal = host.getEvents(summary.id).findLast(event => event.type === 'run/status' && event.status === 'idle');
  host.broadcast({ kind: 'event', sessionId: summary.id, event: terminal });
  await page.locator('[data-nav="chat"]').click();
  const latest = host.listSessions().find(session => session.id === summary.id);
  assert.ok(latest);
  await page.locator('.session').filter({ hasText: latest.title }).click();

  let uploads = 0;
  await page.route('**/api/call', route => {
    if (route.request().postDataJSON()?.method === 'transcribe') uploads++;
    return route.continue();
  });
  await page.evaluate(() => {
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => { throw new DOMException('fixture denial', 'NotAllowedError'); },
    });
  });
  await page.locator('[title="Voice input"]').click();
  await page.getByText('Microphone permission was denied. You can still type your message.').waitFor();
  assert.equal(await page.locator('.composer textarea').isEnabled(), true);
  await page.evaluate(() => {
    window.__stoppedVoiceTracks = 0;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
      configurable: true, value: async () => ({ getTracks: () => [{ stop: () => window.__stoppedVoiceTracks++ }] }),
    });
    globalThis.MediaRecorder = class {
      state = 'inactive';
      mimeType = 'audio/webm';
      start() {
        this.state = 'recording';
        this.ondataavailable({ data: new Blob(['fixture audio']) });
      }
      stop() { this.state = 'inactive'; this.onstop?.(); }
    };
  });
  await page.locator('[title="Voice input"]').click();
  await page.getByRole('button', { name: 'Cancel voice input' }).click();
  assert.equal(await page.evaluate(() => window.__stoppedVoiceTracks), 1);
  assert.equal(uploads, 0);
  assert.equal(await page.evaluate(() => window.__settingsAlerts.length), 1);
  await openSettings(page);
  const usage = await openPanel(page, 'usage');
  await usage.getByLabel('Session').selectOption(summary.id);
  await usage.getByText('Unknown price', { exact: true }).waitFor();
  assert.equal(await usage.getByText('Estimated total', { exact: false }).count(), 0);

  host.switchModel(summary.id, 'fixture/priced');
  await host.send(summary.id, 'Priced token fixture');
  await host.wait(summary.id);
  await usage.getByRole('button', { name: 'Refresh', exact: true }).click();
  await usage.getByText('Priced subtotal estimate · $0.0003', { exact: true }).waitFor();
  await usage.getByText('Unknown price', { exact: true }).waitFor();
  console.log('Gateway renderer explicitly requests notification permission, deduplicates alerts, and cancels denied or unfinished audio. Unknown prices remain unknown in mixed usage.');
}

try {
  const pluginDir = join(home, 'plugins', 'fixture');
  const pluginMarker = join(home, 'plugin-imported');
  const pluginStarted = join(home, 'plugin-started');
  const pluginFinish = join(home, 'plugin-finish');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(join(pluginDir, 'package.json'), JSON.stringify({
    sun: { requestedActions: ['tools', 'network'] }, private: fixtureKey,
  }));
  writeFileSync(join(pluginDir, 'index.mjs'), `
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(pluginMarker)}, 'imported');
    export default api => api.registerTool({
      name: 'fixture_plugin_tool', description: 'Fixture', parameters: { type: 'object' }, risk: 'read',
      execute: async ({ wait }) => {
        if (wait) {
          writeFileSync(${JSON.stringify(pluginStarted)}, 'started');
          for (let i = 0; i < 2400 && !existsSync(${JSON.stringify(pluginFinish)}); i++) {
            await new Promise(resolve => setTimeout(resolve, 5));
          }
        }
        return 'ok';
      },
    });
  `);
  writeFileSync(config, JSON.stringify({
    ui: { language: 'en', theme: 'dark', startPage: 'settings' },
    maxSteps: 60,
    defaultModel: 'fixture/model',
    pricing: { 'fixture/priced': { input: 1, output: 2 } },
    titles: 'first-message',
    unknownPreference: { keep: true },
    plugins: { disabled: ['fixture'] },
    providers: {
      fixture: { type: 'openai', models: ['model', 'priced'], baseUrl: `https://fixture:${fixtureKey}@example.invalid/v1`, apiKey: fixtureKey },
    },
  }));
  assert.throws(() => runCli('briefing', 'enable', '--at', '99:99'), /INVALID/);
  assert.equal(readConfig().briefing, undefined);
  runCli('briefing', 'enable', '--at', '7:30');
  assert.deepEqual(readConfig().briefing, { enabled: true, hour: 7, minute: 30 });
  runCli('mcp', 'add', 'apple');
  assert.equal(readConfig().taint.untrusted[0], 'mcp__apple__*');
  console.log('CLI rejects invalid times and persists briefing and connector settings.');
  const cliPlugin = JSON.parse(runCli('plugins', 'list', '--local'))[0];
  assert.equal(cliPlugin.status, 'disabled');
  assert.deepEqual(cliPlugin.requestedActions, ['tools', 'network']);
  assert.equal(JSON.stringify(cliPlugin).includes(fixtureKey), false);
  assert.equal(JSON.parse(runCli('plugins', 'enable', 'fixture', '--local')).plugin.status, 'inactive');
  assert.equal(JSON.parse(runCli('plugins', 'disable', 'fixture', '--local')).plugin.status, 'disabled');
  assert.equal(existsSync(pluginMarker), false);
  console.log('CLI inspected and edited the plugin without importing JavaScript.');

  trashCrash();
  await browserProfileLifecycle();
  app = await launch();
  const page = await app.firstWindow();
  page.setDefaultTimeout(12_000);
  await page.waitForURL(/#settings\/general$/);
  await openSettings(page);
  await resize(page, 1440);
  await searchMaxSteps(page, 'MAX steps');
  const desktopSnapshot = await page.evaluate(v => window.sun.call('getSettings', v), version);
  assert.equal(JSON.stringify(desktopSnapshot).includes(fixtureKey), false);
  const cliCaps = JSON.parse(runCli('capabilities', '--local'));
  const descriptorIds = caps => caps.map(cap => cap.id);
  assert.equal(cliCaps.protocolVersion, version);
  assert.deepEqual(descriptorIds(cliCaps.capabilities), descriptorIds(desktopSnapshot.capabilities));
  assert.equal(cliCaps.capabilities.find(cap => cap.id === 'native.mini').reasonCode, 'SURFACE_UNSUPPORTED');
  assert.equal(desktopSnapshot.capabilities.find(cap => cap.id === 'native.mini').state, 'available');
  assert.deepEqual(await page.evaluate(v => window.sun.call('listCapabilities', v), version), desktopSnapshot.capabilities);
  await assert.rejects(page.evaluate(v => window.sun.call('captureAppshot', v), version), /CAPABILITY_DISABLED|CAPABILITY_UNAVAILABLE/);
  await assert.rejects(page.evaluate(v => window.sun.call('getSettings', v), version + 1), /SETTINGS_PROTOCOL_MISMATCH/);
  await assert.rejects(page.evaluate(() => window.sun.call('getConfig')), /Unknown method|not allowed|protocol mismatch/i);
  const latest = await page.evaluate(async ({ revision, version }) => window.sun.call('updateSettings', {
    expectedRevision: revision, scope: 'host', changes: { maxSteps: 31 },
  }, version), { ...desktopSnapshot, version });
  assert.equal(latest.ok, true);
  await page.getByLabel('Max steps per run').fill('42');
  await page.getByLabel('Auto-resume interval (minutes)').fill('23');
  assert.equal(readConfig().maxSteps, 31);
  assert.equal(readConfig().autoResume, undefined);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByText('Settings changed elsewhere.', { exact: false }).waitFor();
  assert.equal(readConfig().maxSteps, 31);
  await page.getByRole('button', { name: 'Reload settings' }).click();
  await page.getByRole('heading', { name: 'Review conflicting settings' }).waitFor();
  assert.equal(await page.getByText('Current value').count(), 2);
  await page.getByRole('button', { name: 'Apply my edits' }).click();
  await page.getByText('Saved', { exact: true }).waitFor();
  assert.equal(readConfig().maxSteps, 42);
  assert.equal(readConfig().autoResume.intervalMinutes, 23);
  console.log('Electron settings retain the two-field draft on conflict and save it atomically after reload.');

  await page.getByLabel('Max steps per run').fill('-1');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('status').filter({ hasText: 'This setting has an invalid value.' }).waitFor();
  assert.equal(await page.getByLabel('Max steps per run').inputValue(), '-1');
  assert.equal(await page.getByText('Saved', { exact: true }).count(), 0);
  assert.equal(readConfig().maxSteps, 42);
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('[data-settings-section="sandbox"]').click();
  assert.equal(await page.getByLabel('Max steps per run').inputValue(), '-1');
  page.once('dialog', dialog => dialog.accept());
  await page.locator('[data-settings-section="sandbox"]').click();
  await page.locator('[data-settings-panel="sandbox"]').waitFor();
  await page.evaluate(() => history.back());
  await page.locator('[data-settings-panel="general"]').waitFor();
  assert.equal(await page.getByLabel('Max steps per run').inputValue(), '42');

  await page.locator('[data-settings-section="sandbox"]').click();
  await page.locator('[data-settings-section="general"]').click();
  await page.getByLabel('Max steps per run').fill('65');
  const stayDialog = page.waitForEvent('dialog');
  await page.evaluate(() => history.back());
  await (await stayDialog).dismiss();
  await page.waitForURL(/#settings\/general$/);
  assert.equal(await page.getByLabel('Max steps per run').inputValue(), '65');
  const discardDialog = page.waitForEvent('dialog');
  await page.evaluate(() => history.back());
  await (await discardDialog).accept();
  await page.locator('[data-settings-panel="sandbox"]').waitFor();
  assert.equal(readConfig().maxSteps, 42);

  await resize(page, 800);
  await language(page, 'zh-CN');
  await searchMaxSteps(page, '最大步数', 'zh-CN');
  await language(page, 'en', true);
  console.log('Electron settings pass English and Chinese search, focus, invalid save, discard and Back at 1440 and 800 pixels.');

  await appearanceAndKeyboard(page);
  await globalShortcutRollback(page);
  await personalControls(page);
  await dataControls(page, 'Electron');
  await hookControls(page, 'Electron');
  await pluginControls(page, 'Electron');
  await browserPermissionControls(page, 'Electron');
  console.log('Electron applies appearance, remaps in-app shortcuts, and retains the old OS binding after registration failure.');

  const usage = { inputTokens: 100, outputTokens: 100 };
  const provider = new MockProvider([
    { text: 'Offline fixture finished', toolCalls: [], usage },
    { text: 'Priced fixture finished', toolCalls: [], usage },
  ]);
  host = new HarnessHost({ connectMcp: false, providerFactory: () => ({ provider, model: 'fixture' }) });
  await host.init();
  gateway = await startGateway(host, { port: 0, webRoot });
  const web = app.waitForEvent('window');
  await app.evaluate(({ BrowserWindow }, url) => {
    const view = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
    void view.loadURL(url);
  }, `${gateway.url}/#token=${gateway.token}`);
  const webPage = await web;
  webPage.setDefaultTimeout(12_000);
  await openSettings(webPage);
  assert.equal(await webPage.evaluate(() => localStorage.getItem('sun-token')), null);
  assert.equal(new URL(webPage.url()).hash.includes('token'), false);
  const webCookie = (await webPage.context().cookies([`${gateway.url}/api/health`])).find(cookie => cookie.name.startsWith('sun_gateway_'));
  assert.equal(webCookie?.httpOnly, true);
  assert.equal(webCookie?.sameSite, 'Strict');
  assert.notEqual(webCookie?.value, gateway.token);
  console.log('Gateway web exchanges the URL token for an opaque HttpOnly session and removes it from renderer storage.');
  await resize(webPage, 1440);
  await searchMaxSteps(webPage, 'MAX steps');
  const webSnapshot = await webPage.evaluate(v => window.sun.call('getSettings', v), version);
  assert.equal(JSON.stringify(webSnapshot).includes(fixtureKey), false);
  assert.deepEqual(descriptorIds(webSnapshot.capabilities), descriptorIds(desktopSnapshot.capabilities));
  assert.equal(webSnapshot.capabilities.find(cap => cap.id === 'native.mini').reasonCode, 'SURFACE_UNSUPPORTED');
  assert.equal(await webPage.locator('[data-settings-section="mini"]').count(), 0);
  await assert.rejects(webPage.evaluate(() => window.sun.call('showMini')), /Unknown method/);
  assert.deepEqual(Object.keys(webSnapshot.values), Object.keys(desktopSnapshot.values));
  await assert.rejects(webPage.evaluate(v => window.sun.call('captureAppshot', v), version), /Unknown method/);
  assert.equal(webSnapshot.capabilities.find(cap => cap.id === 'native.appshots').reasonCode, 'SURFACE_UNSUPPORTED');
  assert.equal(webSnapshot.capabilities.find(cap => cap.id === 'native.credentials').reasonCode, 'SURFACE_UNSUPPORTED');
  assert.equal(await webPage.locator('[data-settings-section="passwords"]').count(), 0);
  await assert.rejects(webPage.evaluate(v => window.sun.call('listDesktopCredentials', v), version), /Unknown method/);
  assert.equal(webSnapshot.capabilities.find(cap => cap.id === 'native.computer-use').reasonCode, 'SURFACE_UNSUPPORTED');
  assert.equal(await webPage.locator('[data-settings-section="computer-use"]').count(), 0);
  await assert.rejects(webPage.evaluate(v => window.sun.call('inspectComputerUse', v), version), /Unknown method/);
  console.log('CLI, Electron, and gateway share capability IDs. Version mismatch and native-only routes are rejected.');
  await webPage.goto(`${gateway.url}/#settings/providers`);
  await webPage.locator('[data-settings-panel="providers"]').waitFor();
  await webPage.evaluate(() => history.back());
  await webPage.locator('[data-settings-panel="general"]').waitFor();
  await resize(webPage, 800);
  await language(webPage, 'zh-CN');
  await searchMaxSteps(webPage, '最大步数', 'zh-CN');
  assert.equal(readConfig().ui.language, 'zh-CN');
  assert.deepEqual(readConfig().unknownPreference, { keep: true });
  assert.equal(readConfig().providers.fixture.apiKey, fixtureKey);
  console.log('Gateway web settings pass direct routes, Back, bilingual search and layout at 1440 and 800 pixels.');
  await language(webPage, 'en', true);
  await appearanceAndKeyboard(webPage);
  await notificationAndVoice(webPage);
  await dataControls(webPage, 'Gateway web');
  await hookControls(webPage, 'Gateway web');
  let drainingSession;
  await browserPermissionControls(webPage, 'Gateway web');
  await pluginControls(webPage, 'Gateway web', {
    start: async () => {
      provider.push({ text: '', toolCalls: [{ id: 'drain-fixture', name: 'fixture_plugin_tool', arguments: '{"wait":true}' }] });
      drainingSession = host.createSession({ cwd: home });
      await host.send(drainingSession.id, 'Run the plugin fixture');
      for (let i = 0; i < 60 && !existsSync(pluginStarted); i++) await delay(20);
      assert.equal(existsSync(pluginStarted), true);
    },
    finish: async () => {
      writeFileSync(pluginFinish, 'finish');
      if (drainingSession) await host.wait(drainingSession.id);
    },
  });
  const disconnected = webPage.locator('[data-connection="stale"]').waitFor();
  gateway.server.closeAllConnections();
  await disconnected;
  await assert.rejects(webPage.evaluate(() => window.sun.call('createSession', { title: 'Stale web mutation' })), /GATEWAY_CONNECTION_STALE/);
  host.createSession({ title: 'During web interruption' });
  await webPage.waitForFunction(async () => (await window.sun.call('connectionStatus')).state === 'ready');
  await webPage.locator('[data-nav="chat"]').click();
  await webPage.getByText('During web interruption', { exact: true }).waitFor();
  console.log('Gateway web pauses host actions during a lost event stream and refreshes sessions before enabling them again.');

  await openSettings(webPage);
  await openPanel(webPage, 'review');
  await webPage.getByLabel('Minimum severity to display').selectOption('high');
  await webPage.getByRole('button', { name: 'Save changes', exact: true }).click();
  await webPage.getByText('Saved', { exact: true }).waitFor();
  const reviewWorkspace = join(home, 'review-fixture');
  mkdirSync(reviewWorkspace);
  const reviewSession = host.createSession({ cwd: reviewWorkspace, title: 'Review fixture', mode: 'coding', approval: 'full-auto' });
  provider.push({
    text: '', toolCalls: [{ id: 'review-write', name: 'write_file', arguments: JSON.stringify({ path: 'gate.js', content: 'export const gate = false;\n' }) }],
  }, { text: 'Finished the fixture.', toolCalls: [] });
  await host.send(reviewSession.id, 'Create a review fixture.');
  await host.wait(reviewSession.id);
  const common = { path: 'gate.js', startLine: 1, endLine: 1, evidence: 'export const gate = false;' };
  provider.push({ text: JSON.stringify({ findings: [
    { ...common, id: 'high', severity: 'high', title: 'Gate always closed', explanation: 'The constant disables every request.' },
    { ...common, id: 'low', severity: 'low', title: 'Lower priority fixture', explanation: 'The display threshold hides this finding.' },
  ] }), toolCalls: [] });
  await webPage.locator('[data-nav="chat"]').click();
  await webPage.locator('.session-title').getByText('Review fixture', { exact: true }).click();
  await webPage.getByRole('button', { name: 'Review', exact: true }).click();
  await webPage.getByText('Gate always closed', { exact: true }).waitFor();
  await webPage.getByText('1 finding is below the display threshold.', { exact: true }).waitFor();
  assert.equal(await webPage.getByText('Lower priority fixture', { exact: true }).count(), 0);
  writeFileSync(join(reviewWorkspace, 'gate.js'), 'export const gate = true;\n');
  await webPage.getByRole('button', { name: 'Check review status' }).click();
  await webPage.locator('[data-review-state="stale"]').waitFor();
  console.log('Gateway web persists review settings, filters structured findings, and marks the report stale after a file changes.');

  const gitWorkspace = join(home, 'worktree-fixture');
  mkdirSync(join(gitWorkspace, '.sun'), { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: gitWorkspace, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'fixture@example.test');
  git('config', 'user.name', 'Fixture');
  writeFileSync(join(gitWorkspace, '.sun', 'hooks.json'), JSON.stringify({
    sessionStart: [{ id: 'setup-fixture', worktreeSetup: true, command: 'printf x >> setup.txt' }],
  }));
  git('add', '-A');
  git('commit', '-qm', 'Fixture');
  git('tag', 'baseline');
  const clean = host.createSession({ cwd: gitWorkspace, worktree: true, worktreeBase: 'baseline', title: 'Clean worktree' });
  const setup = host.createSession({ cwd: gitWorkspace, worktree: true, sandbox: 'off', title: 'Setup worktree' });
  const stale = host.createSession({ cwd: gitWorkspace, worktree: true, title: 'Stale worktree' });
  const cliPreview = JSON.parse(runCli('worktree', 'preview', clean.id, '--local'));
  assert.equal(cliPreview.items[0].state, 'ready');
  await openSettings(webPage);
  const worktrees = await openPanel(webPage, 'worktrees');
  const rowFor = (page, branch) => page.locator('[data-worktree-state]').filter({ has: page.getByText(branch, { exact: true }) });
  await rowFor(webPage, stale.worktree.branch).getByRole('checkbox').check();
  await worktrees.getByRole('button', { name: 'Preview worktree cleanup' }).click();
  const confirmCleanup = worktrees.getByRole('button', { name: 'Confirm worktree cleanup' });
  await confirmCleanup.waitFor();
  writeFileSync(join(stale.cwd, 'untracked.txt'), 'preserve it');
  await confirmCleanup.click();
  await worktrees.getByText('The worktree inventory changed. Preview cleanup again.').waitFor();
  assert.equal(readFileSync(join(stale.cwd, 'untracked.txt'), 'utf8'), 'preserve it');
  await rowFor(webPage, stale.worktree.branch).getByRole('checkbox').uncheck();
  await rowFor(webPage, clean.worktree.branch).getByRole('checkbox').check();
  await worktrees.getByRole('button', { name: 'Preview worktree cleanup' }).click();
  await confirmCleanup.click();
  await worktrees.getByText('Worktrees removed · 1. Retained · 0.').waitFor();
  assert.equal(existsSync(clean.cwd), false);
  const setupRow = rowFor(webPage, setup.worktree.branch);
  await setupRow.getByRole('button', { name: 'Inspect setup hooks' }).click();
  await setupRow.getByText('printf x >> setup.txt', { exact: true }).waitFor();
  webPage.once('dialog', dialog => dialog.accept());
  await setupRow.getByRole('button', { name: 'Trust setup command' }).click();
  webPage.once('dialog', dialog => dialog.accept());
  await setupRow.getByRole('button', { name: 'Run worktree setup' }).click();
  await setupRow.getByText('Setup completed', { exact: true }).waitFor();
  assert.equal(readFileSync(join(setup.cwd, 'setup.txt'), 'utf8'), 'x');
  assert.equal(await setupRow.getByRole('button', { name: 'Run worktree setup' }).count(), 0);
  console.log('Gateway web rejected stale cleanup, removed a clean worktree, and ran a trusted setup once. CLI preview matched the host inventory.');
  await browserFileTransfers(webPage, 'Gateway web', provider);
  await webPage.locator('[data-nav="chat"]').click();
  await webPage.locator('.session-title').getByText('Review fixture', { exact: true }).click();
  await webPage.getByRole('button', { name: 'Capture Appshot', exact: true }).click();
  await webPage.getByText('Appshots require the supported macOS desktop app and a local execution host.', { exact: true }).waitFor();
  console.log('Gateway web explains why Appshot capture requires the macOS desktop and exposes no native capture method.');
  await openSettings(webPage);
  const executionSession = host.createSession({ title: 'Web execution fixture', cwd: home, sandbox: 'off' });
  const execution = await openPanel(webPage, 'execution-targets');
  const targets = await webPage.evaluate(version => window.sun.call('executionTargets', version), version);
  const local = targets.find(target => target.kind === 'local');
  assert.equal(local.health, 'ready');
  assert.equal(targets.find(target => target.kind === 'container').kind, 'container');
  await execution.getByLabel('Execution target', { exact: true }).selectOption(local.id);
  await execution.getByLabel('Target session').selectOption(executionSession.id);
  await execution.getByLabel('Shell command').fill('printf web-execution-fixture');
  await execution.getByRole('button', { name: 'Review job', exact: true }).click();
  await execution.getByRole('button', { name: 'Start reviewed job', exact: true }).click();
  const job = execution.locator('[data-execution-job]');
  await job.waitFor();
  await execution.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
  await job.getByText('Succeeded', { exact: true }).waitFor();
  await job.getByRole('button', { name: 'View job output', exact: true }).click();
  await job.getByText('web-execution-fixture', { exact: true }).waitFor();
  console.log('Gateway web separates the host and Local Docker and launches a reviewed job in the selected local session.');


  await app.close();
  app = undefined;
  app = await launch(true);
  const attached = await app.firstWindow();
  attached.setDefaultTimeout(12_000);
  await attached.waitForURL(/#settings\/general$/);
  await attached.getByLabel('Default mode', { exact: true }).waitFor();
  await miniStopsRun(attached, provider);
  await attached.locator('[data-nav="chat"]').click();
  await attached.locator('.session-title').getByText('Review fixture', { exact: true }).click();
  await attached.locator('[data-review-state="stale"]').waitFor();
  await attached.getByText('Gate always closed', { exact: true }).waitFor();
  console.log('Electron reopens the persisted review and identifies the changed digest.');
  await openSettings(attached);
  await openPanel(attached, 'worktrees');
  await rowFor(attached, setup.worktree.branch).getByText('Setup completed', { exact: true }).waitFor();
  await rowFor(attached, stale.worktree.branch).getByText('Has uncommitted files', { exact: false }).waitFor();
  console.log('Electron shows the persisted setup outcome and the protected dirty worktree.');
  await browserFileTransfers(attached, 'Electron', provider);
  await app.close();
  app = undefined;
  const broken = '{"approval":';
  writeFileSync(config, broken);
  app = await launch();
  const recovery = await app.firstWindow();
  await recovery.getByRole('heading', { name: /Configuration recovery|配置恢复/ }).waitFor();
  assert.equal(readFileSync(config, 'utf8'), broken);
  console.log('Desktop opens configuration recovery and preserves malformed bytes.');
} finally {
  if (app) {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.destroy())).catch(() => undefined);
    await app.close();
  }
  await gateway?.close();
  await host?.dispose();
  rmSync(home, { recursive: true, force: true });
}
