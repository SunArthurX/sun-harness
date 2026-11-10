// T12 toolchain spike. Uses a disposable copy of an existing app bundle and sends no native actions.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.platform, 'darwin');
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const source = resolve(process.argv[2] ?? join(import.meta.dirname, '../release', arch === 'arm64' ? 'mac-arm64' : 'mac', 'sun-harness.app'));
execFileSync('codesign', ['--verify', '--deep', '--strict', source]);
const home = realpathSync(mkdtempSync(join(tmpdir(), 'sun-computer-probe-')));
const bundle = join(home, 'sun-computer-probe.app');
const helper = join(bundle, 'Contents', 'Resources', 'sun-computer-probe');
const profile = `--user-data-dir=${join(home, 'profile')}`;
let socket;
let fixturePid;
let nextCall = 0;

function evaluate(fn, input) {
  const id = ++nextCall;
  const expression = `(${fn})(process.getBuiltinModule('node:module').createRequire(process.execPath)('electron'), ${JSON.stringify(input)})`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.removeEventListener('message', receive);
      reject(new Error('The isolated desktop fixture did not reply.'));
    }, 7000);
    function receive({ data }) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      clearTimeout(timeout);
      socket.removeEventListener('message', receive);
      if (message.error || message.result.exceptionDetails) reject(new Error('The isolated desktop fixture could not run the probe.'));
      else resolve(message.result.result.value);
    }
    socket.addEventListener('message', receive);
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

try {
  writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultModel: 'missing/fixture', fallbackModels: [] }));
  execFileSync('/usr/bin/ditto', [source, bundle]);
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier dev.sun-harness.desktop.computer-probe', join(bundle, 'Contents', 'Info.plist')]);
  execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${arch}-apple-macos13.0`,
    join(import.meta.dirname, 'fixtures', 'ComputerProbe.swift'), '-o', helper], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle]);
  console.log(`Built a macOS 13 deployment-target ${arch} helper and verified the disposable signed Electron bundle.`);

  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  execFileSync('/usr/bin/open', ['-n', '-a', bundle, '--env', `SUN_HOME=${home}`, '--env', 'SUN_SKIP_SHELL_ENV=1',
    '--env', 'SUN_NO_GATEWAY=1', '--args', profile, `--inspect=127.0.0.1:${port}`]);
  let target;
  for (let attempt = 0; attempt < 100 && !target; attempt++) {
    try { [target] = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(300) }).then(res => res.json()); }
    catch { await delay(100); }
  }
  assert.ok(target?.webSocketDebuggerUrl, 'The isolated desktop fixture must launch through LaunchServices.');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const identity = await evaluate(async ({ app, BrowserWindow }) => {
    await app.whenReady();
    if (process.env.SUN_NO_GATEWAY !== '1') return null;
    app.setActivationPolicy('regular');
    await app.dock.show();
    const window = new BrowserWindow({ title: 'Isolated Computer Use probe', width: 480, height: 360 });
    await window.loadURL('data:text/html,<title>Isolated Computer Use probe</title><h1>Offline fixture</h1>');
    window.show();
    window.focus();
    app.focus({ steal: true });
    return { pid: process.pid, home: process.env.SUN_HOME, resources: process.resourcesPath };
  });
  assert.equal(identity?.home, home);
  fixturePid = identity.pid;
  assert.equal(realpathSync(identity.resources), join(bundle, 'Contents', 'Resources'));
  const probe = expected => evaluate((_electron, { helper, expected }) => {
    const { execFileSync } = process.getBuiltinModule('node:child_process');
    return JSON.parse(execFileSync(helper, [String(expected)], { encoding: 'utf8', timeout: 2500, maxBuffer: 4096 }));
  }, { helper, expected });
  let status;
  for (let attempt = 0; attempt < 15; attempt++) {
    status = await probe(fixturePid);
    if (status.foreground === 'matched') break;
    await delay(100);
  }
  assert.equal(status.foreground, 'matched');
  for (const field of ['screenRecording', 'accessibility']) assert.match(status[field], /^(available|permission-required)$/);
  assert.equal(status.windowRole, status.accessibility === 'available' ? 'window' : 'not-inspected');
  const wrong = await probe(process.pid);
  assert.equal(wrong.foreground, 'mismatch');
  assert.equal(wrong.windowRole, 'not-inspected');
  console.log(`Packaged process reported Screen Recording ${status.screenRecording} and Accessibility ${status.accessibility}.`);
  console.log(`Foreground identity matched the isolated fixture. A mismatched process denied inspection. AX window role ${status.windowRole}.`);
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate(({ app }) => { setTimeout(() => app.exit(0), 50); }).catch(() => undefined);
    socket.close();
  }
  const ownsProcess = () => fixturePid && spawnSync('/bin/ps', ['-p', String(fixturePid), '-o', 'args='], { encoding: 'utf8' }).stdout?.includes(profile);
  for (let attempt = 0; ownsProcess() && attempt < 20; attempt++) await delay(100);
  if (ownsProcess()) {
    try { process.kill(fixturePid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await delay(400);
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 });
}
