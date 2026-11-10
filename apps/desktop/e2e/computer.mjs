// Signed macOS acceptance with an isolated native window and a loopback model fixture.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createListener } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SETTINGS_PROTOCOL_VERSION as version } from '@sun/core';
import { chromium } from 'playwright-core';

assert.equal(process.platform, 'darwin');
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const release = arch === 'arm64' ? 'mac-arm64' : 'mac';
const packaged = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--'))
  ?? join(import.meta.dirname, '../release/computer-verified', release, 'sun-harness.app'));
const preflightOnly = process.argv.includes('--preflight-only');
const fixtureId = 'dev.sun-harness.computer-fixture';
const home = realpathSync(mkdtempSync(join(tmpdir(), 'sun-computer-e2e-')));
const fixture = join(home, 'Sun Computer Fixture.app');
const marker = join(home, 'fixture-state.json');
const rival = join(home, 'Sun Computer Other Fixture.app');
const rivalMarker = join(home, 'other-fixture-state.json');
const profile = `--user-data-dir=${join(home, 'electron')}`;
let browser;
let inspector;
let inspectorCall = 0;
let desktopPid;
let state;
let rivalState;
let modelError;
let requests = 0;

const model = createServer((req, res) => {
  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', async () => {
    try {
      const request = JSON.parse(body);
      requests++;
      const tools = request.tools.map(tool => tool.function.name);
      assert.ok(tools.includes('computer_snapshot') && tools.includes('computer_act'));
      const prompt = String(request.messages.findLast(message => message.role === 'user')?.content);
      const writing = prompt.includes('Set the editable fixture field');
      const refusal = [
        ['stale observation', 'COMPUTER_SNAPSHOT_STALE'],
        ['foreground change', 'COMPUTER_TARGET_CHANGED'],
        ['emergency stop', 'COMPUTER_CONTROL_REQUIRED'],
        ['app grant revocation', 'COMPUTER_CONTROL_REQUIRED'],
      ].find(([scenario]) => prompt.includes(`Exercise ${scenario}`));
      const actionId = writing ? 'fixture-write' : 'fixture-press';
      const action = writing ? { kind: 'set-text', text: 'approved fixture text' } : { kind: 'press' };
      const label = writing ? 'Editable fixture field' : 'Count fixture press';
      const snapshot = request.messages.find(message => message.tool_call_id === 'fixture-snapshot');
      const completed = request.messages.find(message => message.tool_call_id === actionId);
      let delta;
      if (!snapshot) {
        await focusFixture(fixture, fixtureId);
        delta = toolCall('fixture-snapshot', 'computer_snapshot', {});
      }
      else if (refusal?.[0] === 'stale observation' && !request.messages.some(message => message.tool_call_id === 'fixture-resnapshot')) {
        await focusFixture(fixture, fixtureId);
        delta = toolCall('fixture-resnapshot', 'computer_snapshot', {});
      }
      else if (!completed) {
        const json = /<untrusted[^>]*>\n([\s\S]*?)\n<\/untrusted>/.exec(snapshot.content)?.[1] ?? snapshot.content;
        const observation = JSON.parse(json);
        assert.equal(observation.appId, fixtureId);
        assert.equal(JSON.stringify(observation).includes('PRIVATE_NATIVE_FIXTURE_SENTINEL'), false);
        assert.equal(JSON.stringify(observation).includes('Private fixture field'), false);
        const control = observation.controls.find(item => item.label === label && item.actions.includes(action.kind));
        assert.ok(control, 'The real AX snapshot must include the requested synthetic control.');
        delta = toolCall(actionId, 'computer_act', { ref: control.ref, ...action });
      } else {
        if (refusal) assert.ok(completed.content.includes(refusal[1]), `Expected ${refusal[1]} before native dispatch.`);
        else assert.equal(completed.content, 'applied');
        delta = { content: 'Fixture complete.' };
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) {
      modelError = error;
      res.writeHead(400).end('Invalid computer fixture request');
    }
  });
});
function toolCall(id, name, args) {
  return { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] };
}

async function until(read, description) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (modelError) throw modelError;
    const result = await read();
    if (result) return result;
    await delay(100);
  }
  throw new Error(description);
}

async function freePort() {
  const listener = createListener();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address();
  await new Promise(resolve => listener.close(resolve));
  return port;
}

function stopFixture(pid, expected) {
  if (!pid) return;
  const { stdout } = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'args='], { encoding: 'utf8' });
  if (stdout?.includes(expected)) {
    try { process.kill(pid, 'SIGTERM'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

async function inspectMain(port) {
  const endpoint = await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(500) }).then(res => res.json()))[0]; }
    catch { return undefined; }
  }, 'The desktop main-process test endpoint did not start.');
  inspector = new WebSocket(endpoint.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    inspector.addEventListener('open', resolve, { once: true });
    inspector.addEventListener('error', reject, { once: true });
  });
  return evaluateMain("({ pid: process.pid, authorized: process.getBuiltinModule('node:module').createRequire(process.execPath)('electron').systemPreferences.isTrustedAccessibilityClient(false) })");
}

function evaluateMain(expression) {
  const id = ++inspectorCall;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('The main-process permission check did not reply.')), 5000);
    inspector.addEventListener('message', function result({ data }) {
      const message = JSON.parse(data);
      if (message.id !== id) return;
      inspector.removeEventListener('message', result);
      clearTimeout(timer);
      if (message.error || message.result?.exceptionDetails) reject(new Error('The main-process permission check failed.'));
      else resolve(message.result.result.value);
    });
    inspector.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
}

async function focusFixture(bundle, id) {
  execFileSync('/usr/bin/open', ['-a', bundle]);
  const helper = join(packaged, 'Contents', 'Resources', 'sun-computer');
  await until(() => evaluateMain(`(() => {
    const { execFileSync } = process.getBuiltinModule('node:child_process');
    const result = JSON.parse(execFileSync(${JSON.stringify(helper)}, [], {
      input: JSON.stringify({ command: 'probe', hostId: 'dev.sun-harness.desktop', hostPid: process.pid }), timeout: 2500,
    }));
    return result.target?.appId === ${JSON.stringify(id)};
  })()`), 'The requested synthetic window did not become foreground.');
}

try {
  execFileSync('codesign', ['--verify', '--deep', '--strict', packaged]);
  assert.ok(existsSync(join(packaged, 'Contents', 'Resources', 'sun-computer')));
  mkdirSync(join(fixture, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(fixture, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
    <plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string>
    <key>CFBundleIdentifier</key><string>${fixtureId}</string><key>CFBundleName</key><string>Sun Computer Fixture</string>
    <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
  execFileSync('xcrun', ['swiftc', '-O', '-parse-as-library', '-target', `${arch}-apple-macos13.0`,
    join(import.meta.dirname, 'fixtures', 'ComputerWindow.swift'), '-o', join(fixture, 'Contents', 'MacOS', 'fixture')], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', fixture]);
  execFileSync('/usr/bin/open', ['-n', '-a', fixture, '--args', marker]);
  state = await until(() => existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')), 'The synthetic app did not open.');
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${model.address().port}`;
  writeFileSync(join(home, 'config.json'), JSON.stringify({ defaultModel: 'fixture/local', fallbackModels: [], titles: 'first-message',
    approval: 'suggest', ui: { language: 'en', startPage: 'settings' }, providers: { fixture: { type: 'openai', baseUrl, apiKey: 'offline-fixture', models: ['local'] } } }));
  const [port, inspectorPort] = await Promise.all([freePort(), freePort()]);
  execFileSync('/usr/bin/open', ['-n', '-a', packaged, '--env', `SUN_HOME=${home}`, '--env', 'SUN_SKIP_SHELL_ENV=1',
    '--env', 'SUN_NO_GATEWAY=1', '--args', profile, `--remote-debugging-port=${port}`, `--inspect=127.0.0.1:${inspectorPort}`]);
  desktopPid = await until(() => {
    const { stdout } = spawnSync('/bin/ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' });
    const line = stdout.split('\n').find(line => line.includes(join(packaged, 'Contents', 'MacOS', 'sun-harness')) && line.includes(profile));
    return line && Number(line.trim().split(/\s+/)[0]);
  }, 'The signed desktop process did not start.');
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }, 'The signed desktop fixture did not expose its test endpoint.');
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = browser.contexts()[0].pages()[0];
  page.setDefaultTimeout(15_000);
  const call = (method, ...args) => page.evaluate(([method, args]) => window.sun.call(method, ...args), [method, args]);
  assert.equal((await call('appInfo')).home, home);
  const session = await call('createSession', { cwd: home, title: 'Native control fixture' });
  const another = await call('createSession', { cwd: home, title: 'Second native control session' });
  await page.locator('[data-settings-section="computer-use"]').click();
  const panel = page.locator('[data-settings-panel="computer-use"]');
  const application = panel.getByLabel('Running application', { exact: true });
  await application.selectOption(fixtureId);
  await panel.getByRole('button', { name: 'Allow selected app' }).click();
  await panel.getByRole('button', { name: 'Revoke app access' }).waitFor();
  await panel.getByLabel('Control session', { exact: true }).selectOption(session.id);
  const inspected = await call('inspectComputerUse', version);
  assert.equal(inspected.grants.includes(fixtureId), true);
  const main = await inspectMain(inspectorPort);
  assert.equal(main.pid, desktopPid);
  console.log(`Accessibility authorized for signed desktop: ${main.authorized}. Native helper: ${inspected.authorized}.`);
  if (!inspected.authorized) {
    assert.equal(await panel.getByRole('button', { name: 'Start computer control' }).isDisabled(), true);
    await assert.rejects(call('beginComputerUse', version, session.id, fixtureId), /COMPUTER_OS_PERMISSION_REQUIRED/);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 0);
    console.log('The signed desktop exposes the local Computer Use panel and denies control before Accessibility authorization.');
    if (!preflightOnly) throw new Error('Grant Accessibility to this signed Sun Harness bundle to run positive native acceptance.');
  } else if (preflightOnly) {
    console.log('The signed desktop Computer Use panel detects Accessibility authorization.');
  } else {
    await panel.getByRole('button', { name: 'Start computer control' }).click();
    await page.getByRole('button', { name: 'Stop computer control' }).waitFor();
    await assert.rejects(call('beginComputerUse', version, another.id, fixtureId), /COMPUTER_CONTROL_BUSY/);
    await call('sendMessage', session.id, 'Observe the synthetic window, then press its count button once.');
    execFileSync('/usr/bin/open', ['-a', fixture]);
    const approval = await until(async () => (await call('pendingApprovals')).find(item => item.callId === 'fixture-press'), 'The real action did not reach runtime approval.');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 0);
    execFileSync('/usr/bin/open', ['-a', packaged]);
    assert.equal(await call('approve', approval.callId, 'allow', approval.promptId), true);
    execFileSync('/usr/bin/open', ['-a', fixture]);
    const events = await until(async () => {
      const events = await call('getEvents', session.id);
      return events.some(event => event.type === 'assistant/message' && event.text === 'Fixture complete.') && events;
    }, 'The native action did not produce an applied receipt.');
    const receipts = events.filter(event => event.type === 'computer/action');
    assert.deepEqual(receipts.map(event => event.outcome), ['dispatched', 'applied']);
    assert.equal(receipts[0].operationId, receipts[1].operationId);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 1);
    assert.ok(requests >= 3);
    assert.equal(JSON.stringify(events).includes('PRIVATE_NATIVE_FIXTURE_SENTINEL'), false);
    await page.getByRole('button', { name: 'Stop computer control' }).click();
    assert.equal(await call('computerOwner', version), undefined);
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 1);
    await call('beginComputerUse', version, another.id, fixtureId);
    await call('sendMessage', another.id, 'Set the editable fixture field to the approved text.');
    execFileSync('/usr/bin/open', ['-a', fixture]);
    const writeApproval = await until(async () => (await call('pendingApprovals')).find(item => item.callId === 'fixture-write'), 'The native text edit did not reach runtime approval.');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).textSet, false);
    assert.equal(await call('approve', writeApproval.callId, 'allow', writeApproval.promptId), true);
    await until(async () => {
      const events = await call('getEvents', another.id);
      return events.some(event => event.type === 'computer/action' && event.action === 'set-text' && event.outcome === 'applied')
        && JSON.parse(readFileSync(marker, 'utf8')).textSet;
    }, 'The approved native edit did not set the synthetic text field.');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 1);
    await call('stopComputerUse', version);
    const safety = async (scenario, interrupt) => {
      const test = await call('createSession', { cwd: home, title: `Native safety ${scenario}` });
      await call('beginComputerUse', version, test.id, fixtureId);
      await call('sendMessage', test.id, `Exercise ${scenario} on the synthetic count button.`);
      execFileSync('/usr/bin/open', ['-a', fixture]);
      const pending = await until(async () => (await call('pendingApprovals')).find(item => item.sessionId === test.id && item.callId === 'fixture-press'), 'The safety case did not reach approval.');
      await interrupt();
      assert.equal(await call('approve', pending.callId, 'allow', pending.promptId), true);
      const events = await until(async () => {
        const events = await call('getEvents', test.id);
        return events.some(event => event.type === 'assistant/message' && event.text === 'Fixture complete.') && events;
      }, `The ${scenario} case did not produce its refusal.`);
      assert.equal(events.some(event => event.type === 'computer/action'), false);
      assert.equal(JSON.parse(readFileSync(marker, 'utf8')).count, 1);
      await call('stopComputerUse', version);
    };
    await safety('stale observation', async () => undefined);
    await safety('foreground change', async () => {
      cpSync(fixture, rival, { recursive: true });
      execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleIdentifier dev.sun-harness.computer-other-fixture', join(rival, 'Contents', 'Info.plist')]);
      execFileSync('codesign', ['--force', '--sign', '-', rival], { stdio: 'ignore' });
      execFileSync('/usr/bin/open', ['-n', '-a', rival, '--args', rivalMarker]);
      rivalState = await until(() => existsSync(rivalMarker) && JSON.parse(readFileSync(rivalMarker, 'utf8')), 'The second synthetic app did not open.');
      await focusFixture(rival, 'dev.sun-harness.computer-other-fixture');
    });
    assert.equal(JSON.parse(readFileSync(rivalMarker, 'utf8')).count, 0);
    await safety('emergency stop', async () => { await page.getByRole('button', { name: 'Stop computer control' }).click(); });
    await safety('app grant revocation', async () => {
      const settings = await call('inspectComputerUse', version);
      await call('grantComputerUse', version, settings.revision, fixtureId, false);
    });
    const settings = await call('inspectComputerUse', version);
    await call('grantComputerUse', version, settings.revision, fixtureId, true);
    const privateUrl = `https://127.0.0.1:${model.address().port}`;
    const credential = await call('saveDesktopCredential', version, { origin: privateUrl, label: 'Private boundary fixture', password: 'fixture-only' });
    await call('beginComputerUse', version, session.id, fixtureId);
    await call('openDesktopCredentialSignIn', version, credential.id, credential.revision, privateUrl);
    assert.equal(await call('computerOwner', version), undefined);
    await assert.rejects(call('beginComputerUse', version, session.id, fixtureId), /COMPUTER_UNAVAILABLE/);
    console.log('The signed desktop observed a real AX window, waited for runtime approval, pressed its button once, edited its text field, persisted receipts, and stopped the lease.');
    console.log('The signed desktop dispatched no native input after a stale observation, foreground change, emergency stop, or app-grant revocation.');
    console.log('Opening the private sign-in window revoked the existing lease and blocked new native ownership.');
  }
} finally {
  inspector?.close();
  stopFixture(desktopPid, profile);
  stopFixture(state?.pid, marker);
  stopFixture(rivalState?.pid, rivalMarker);
  await browser?.close().catch(() => undefined);
  if (model.listening) await new Promise(resolve => model.close(resolve));
  rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
