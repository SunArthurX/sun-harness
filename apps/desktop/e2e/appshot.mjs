// Run after pnpm --filter @sun/desktop run package on macOS.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SETTINGS_PROTOCOL_VERSION as version } from '@sun/core';
import { chromium } from 'playwright-core';
import { stripTypeScriptTypes } from 'node:module';

assert.equal(process.platform, 'darwin');
const release = join(import.meta.dirname, '..', 'release');
const boundaryOnly = process.argv.includes('--boundary-only');
const packaged = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? join(release, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'sun-harness.app'));
const helper = join(packaged, 'Contents', 'Resources', 'sun-appshot');
assert.equal(existsSync(helper), true, 'The signed app must contain its Appshot helper.');
execFileSync('codesign', ['--verify', '--deep', '--strict', packaged]);
const home = mkdtempSync(join(tmpdir(), 'sun-appshot-e2e-'));
writeFileSync(join(home, 'config.json'), JSON.stringify({
  defaultModel: 'missing/offline-fixture', fallbackModels: [], ui: { startPage: 'settings', language: 'en' },
}));
async function freePort() {
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

const [inspector, devtools] = await Promise.all([freePort(), freePort()]);
execFileSync('/usr/bin/open', [
  '-n', '-a', packaged, '--env', `SUN_HOME=${home}`, '--env', 'SUN_SKIP_SHELL_ENV=1', '--env', 'SUN_NO_GATEWAY=1',
  '--args', `--user-data-dir=${join(home, 'electron')}`, `--inspect=127.0.0.1:${inspector}`, `--remote-debugging-port=${devtools}`,
]);

async function endpoint(port) {
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${url}/json/list`);
      if (response.ok) return await response.json();
    } catch { /* The packaged process is still starting. */ }
    await delay(100);
  }
  throw new Error('The isolated packaged fixture did not open its test interface.');
}

let browser;
let mainSocket;
let fixturePid;
let commandId = 0;
const app = {
  async evaluate(fn, value, timeoutMs = 5000) {
    const id = ++commandId;
    const expression = `(${fn.toString()})(process.getBuiltinModule('node:module').createRequire(process.execPath)('electron'), ${JSON.stringify(value)})`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { mainSocket.removeEventListener('message', listener); reject(new Error('Main-process fixture call timed out.')); }, timeoutMs);
      function listener(event) {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timeout);
        mainSocket.removeEventListener('message', listener);
        if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
        else resolve(message.result?.result?.value);
      }
      mainSocket.addEventListener('message', listener);
      mainSocket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  },
};
const title = 'Sun Appshot isolated fixture';
try {
  const [targets] = await Promise.all([endpoint(inspector), endpoint(devtools)]);
  mainSocket = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    mainSocket.addEventListener('open', resolve, { once: true });
    mainSocket.addEventListener('error', reject, { once: true });
  });
  const identity = await app.evaluate(() => ({ home: process.env.SUN_HOME, pid: process.pid }));
  assert.equal(identity.home, home);
  fixturePid = identity.pid;
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${devtools}`);
  const page = browser.contexts()[0].pages()[0];
  assert.equal(await page.evaluate(() => window.sun.call('appInfo').then(info => info.home)), home);
  page.setDefaultTimeout(12_000);
  await page.locator('[data-settings-panel="general"]').waitFor();
  const chat = await page.evaluate(({ cwd, title }) => window.sun.call('createSession', { cwd, title }), { cwd: home, title });
  const call = (method, ...args) => page.evaluate(({ method, args }) => window.sun.call(method, ...args), { method, args });
  const rawEvents = () => call('getEvents', chat.id);
  const attachmentRoot = join(home, 'attachments', chat.id);
  assert.equal(existsSync(attachmentRoot), false);
  await assert.rejects(call('captureAppshot', version, chat.id), /CAPABILITY_DISABLED/);
  await page.locator('[data-settings-section="appshots"]').click();
  const settings = page.locator('[data-settings-panel="appshots"]');
  await settings.getByLabel('Enable Appshots', { exact: true }).check();
  await settings.getByLabel('Global Appshot shortcut').fill('Primary+Shift+Y');
  await settings.getByRole('button', { name: 'Save changes' }).click();
  await settings.getByText('Saved', { exact: true }).waitFor();
  assert.equal(await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Command+Shift+Y')), true);

  const probe = await app.evaluate((_electron, helper) => {
    const { execFileSync } = process.getBuiltinModule('node:child_process');
    return execFileSync(helper, ['probe'], { encoding: 'utf8' }).trim();
  }, helper);
  if (boundaryOnly) {
    const source = readFileSync(join(import.meta.dirname, '../src/main/capture.ts'), 'utf8');
    const compiled = stripTypeScriptTypes(source.replace(/^import .+\n/gm, '').replace(/^export /gm, ''));
    const edit = await app.evaluate(({ nativeImage }, compiled) => {
      const prepareAppshotImage = new Function('nativeImage', 'APPSHOT_MAX_BYTES', 'execFile', 'promisify',
        `${compiled}\nreturn prepareAppshotImage;`)(nativeImage, 10 * 1024 * 1024,
        process.getBuiltinModule('node:child_process').execFile, process.getBuiltinModule('node:util').promisify);
      const width = 4;
      const height = 4;
      const pixels = Buffer.from(Array.from({ length: width * height }, () => [45, 75, 180, 255]).flat());
      const input = nativeImage.createFromBitmap(pixels, { width, height, scaleFactor: 1 }).toPNG().toString('base64');
      const rect = { x: 1, y: 1, width: 2, height: 2 };
      const prepared = prepareAppshotImage({ mime: 'image/png', data: input, width, height }, {
        crop: rect, masks: [rect], includeText: false,
      });
      const edited = nativeImage.createFromBuffer(Buffer.from(prepared.data, 'base64')).toBitmap();
      return { width: prepared.width, height: prepared.height,
        opaque: edited.length === 16 && edited.every((byte, index) => byte === (index % 4 === 3 ? 255 : 0)) };
    }, compiled);
    assert.deepEqual(edit, { width: 2, height: 2, opaque: true });
    assert.equal(existsSync(attachmentRoot), false);
    assert.equal((await rawEvents()).some(event => event.type === 'user/message'), false);
    console.log(`Signed app passed default-off and OS shortcut checks. Native Electron masking passed on synthetic pixels. Packaged Screen Recording preflight: ${probe}.`);
  } else {
    assert.equal(probe, 'available', 'The packaged app needs Screen Recording access to run this acceptance check.');
    await app.evaluate(async ({ BrowserWindow, app }, title) => {
      app.setActivationPolicy('regular');
      await app.dock.show();
      const fixture = new BrowserWindow({ title, width: 460, height: 320, backgroundColor: '#e04235' });
      await fixture.loadURL(`data:text/html,${encodeURIComponent(`<title>${title}</title><main style="color:white;background:#e04235;padding:60px">Offline pixel fixture</main>`)}`);
      globalThis.sunAppshotFixtureWindow = fixture;
      fixture.show();
      fixture.moveTop();
      fixture.focus();
      app.focus({ steal: true });
    }, title);
    const foreground = () => app.evaluate(({ BrowserWindow }, { helper, title }) => {
      const { spawnSync } = process.getBuiltinModule('node:child_process');
      const result = spawnSync(helper, ['probe', String(process.pid)], { encoding: 'utf8' });
      return {
        focus: BrowserWindow.getAllWindows().some(window => window.getTitle() === title && window.isFocused()),
        available: result.stdout.trim(), reason: result.stderr.trim(),
      };
    }, { helper, title });
    let current = await foreground();
    for (let attempt = 0; attempt < 16 && current.available !== 'available'; attempt++) {
      await delay(150);
      current = await foreground();
    }
    assert.deepEqual(current, { focus: true, available: 'available', reason: '' });
    let captured;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        captured = await app.evaluate(async ({ BrowserWindow, app }, { version, id }) => {
          const fixture = globalThis.sunAppshotFixtureWindow;
          const renderer = BrowserWindow.getAllWindows().find(window => window !== fixture);
          if (!fixture.isFocused()) {
            app.focus({ steal: true });
            fixture.moveTop();
            fixture.focus();
            await new Promise(resolve => setTimeout(resolve, 150));
          }
          return renderer.webContents.executeJavaScript(`window.sun.call('captureAppshot', ${version}, ${JSON.stringify(id)})`);
        }, { version, id: chat.id }, 17_000);
        break;
      } catch (error) {
        if (attempt === 2 || !String(error).includes('APPSHOT_FOREGROUND_CHANGED')) throw error;
      }
    }
    assert.equal(captured.title, title);
    assert.ok(captured.width >= 460 && captured.height >= 320);
    assert.equal(existsSync(attachmentRoot), false);
    const rect = { x: 20, y: 20, width: 96, height: 72 };
    const edited = await call('prepareAppshot', version, chat.id, captured.id, { crop: rect, masks: [rect], includeText: true });
    assert.equal(edited.metadata.text, undefined);
    assert.equal(edited.width, rect.width);
    assert.equal(edited.height, rect.height);
    const opaque = await app.evaluate(({ nativeImage }, data) => {
      const bytes = nativeImage.createFromBuffer(Buffer.from(data, 'base64')).toBitmap();
      return bytes.length > 0 && bytes.every((value, index) => value === (index % 4 === 3 ? 255 : 0));
    }, edited.data);
    assert.equal(opaque, true);
    assert.equal(existsSync(attachmentRoot), false);
    await call('cancelAppshot', version, chat.id, edited.id);
    assert.equal((await rawEvents()).some(event => event.type === 'user/message'), false);

    await app.evaluate(({ BrowserWindow, app }, title) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.getTitle() === title) window.close();
      }
      const main = BrowserWindow.getAllWindows()[0];
      app.focus({ steal: true });
      main.show();
      main.focus();
    }, title);
    await page.locator('[data-nav="chat"]').click();
    await page.locator('.session-title').getByText(title, { exact: true }).click();
    await page.getByRole('button', { name: 'Capture Appshot', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Review Appshot' });
    await preview.waitFor();
    assert.equal(existsSync(attachmentRoot), false);
    const privateImage = preview.getByRole('img', { name: 'Private Appshot preview' });
    const raw = (await privateImage.getAttribute('src')).split(',')[1];
    const drag = async mode => {
      await preview.getByRole('button', { name: mode, exact: true }).click();
      await privateImage.scrollIntoViewIfNeeded();
      const { x, y, width, height } = await privateImage.boundingBox();
      await page.mouse.move(x + width * 0.2, y + height * 0.2);
      await page.mouse.down();
      await page.mouse.move(x + width * 0.6, y + height * 0.6, { steps: 4 });
      await page.mouse.up();
    };
    await drag('Cover area');
    await preview.locator('.appshot-mask').waitFor();
    await drag('Crop area');
    await preview.locator('.appshot-crop').waitFor();
    await preview.getByRole('button', { name: 'Attach prepared Appshot' }).click();
    const attached = page.getByRole('img', { name: 'Prepared Appshot' });
    await attached.waitFor();
    const prepared = (await attached.getAttribute('src')).split(',')[1];
    assert.ok(prepared !== raw, 'The prepared thumbnail must differ from the raw preview.');
    const preparedBytes = Buffer.from(prepared, 'base64');
    const preparedHash = createHash('sha256').update(preparedBytes).digest('hex');
    assert.equal(existsSync(attachmentRoot), false);
    await page.getByRole('button', { name: 'Send ↵' }).click();
    await page.waitForFunction(async id => (await window.sun.call('getEvents', id)).some(event => event.type === 'user/message'), chat.id);
    const message = (await rawEvents()).find(event => event.type === 'user/message');
    assert.equal(message.images.length, 1);
    const [receipt] = message.images;
    assert.equal(receipt.appshot.bytes, preparedBytes.length);
    assert.equal(receipt.appshot.sha256, preparedHash);
    assert.ok(readFileSync(receipt.path).equals(preparedBytes), 'Only the displayed prepared bytes may be persisted.');
    assert.deepEqual(readdirSync(attachmentRoot), [receipt.path.split('/').at(-1)]);
    const logged = JSON.stringify(await rawEvents());
    assert.equal(logged.includes(captured.data) || logged.includes(raw), false);
    console.log('Signed macOS Appshot captures one fixture window, applies an opaque crop and mask, cancels without persistence, and sends only the prepared attachment.');
  }
} finally {
  if (mainSocket?.readyState === WebSocket.OPEN) {
    await app.evaluate(({ BrowserWindow, app }) => {
      BrowserWindow.getAllWindows().forEach(window => window.destroy());
      setTimeout(() => app.quit(), 50);
    }).catch(() => undefined);
    mainSocket.close();
  }
  await browser?.close().catch(() => undefined);
  for (let attempt = 0; fixturePid && attempt < 25; attempt++) {
    try { process.kill(fixturePid, 0); }
    catch { fixturePid = undefined; break; }
    await delay(100);
  }
  if (fixturePid) {
    const ownsProcess = () => {
      const { stdout } = spawnSync('/bin/ps', ['-p', String(fixturePid), '-o', 'args='], { encoding: 'utf8' });
      return stdout?.includes(`--user-data-dir=${join(home, 'electron')}`);
    };
    try {
      if (ownsProcess()) {
        process.kill(fixturePid, 'SIGTERM');
        await delay(400);
      }
      if (ownsProcess()) process.kill(fixturePid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
