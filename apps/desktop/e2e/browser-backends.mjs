// Run after pnpm build. Uses only temporary profiles and local HTTP fixtures.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { BrowserManager, DEFAULT_BROWSER, dockerImageExists, findChrome } from '@sun/core';
import { CdpConnection, browserWsUrl } from '../../../packages/core/dist/browser/cdp.js';

const home = mkdtempSync(join(tmpdir(), 'sun-browser-backends-'));
process.env.SUN_HOME = home;
const server = createServer((request, response) => {
  if (request.url === '/artifact') {
    if (request.headers.cookie !== 'fixture=ready') { response.writeHead(401).end(); return; }
    response.end('profile-authenticated fixture');
    return;
  }
  response.end(`<!doctype html><title>Backend transfer fixture</title><label>Backend file <input type="file"></label>
    <output></output><script>document.querySelector('input').onchange = async ({ target }) => {
      document.querySelector('output').textContent = await target.files[0].text();
    };</script>`);
});
await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
const port = server.address().port;

function grant(browser, origin) {
  for (const action of ['browse', 'upload', 'download']) {
    const { revision } = browser.permissions.snapshot();
    assert.equal(browser.permissions.update({ expectedRevision: revision, origin, action, decision: 'allow' }).ok, true);
  }
}

async function transfers(browser, origin, session) {
  grant(browser, origin);
  const snapshot = await browser.navigate(session, origin);
  assert.match(snapshot, /Backend transfer fixture/);
  const line = snapshot.split('\n').find(value => /Backend file|Choose File/i.test(value) && value.includes('[ref='));
  const ref = /\[ref=(e\w+)\]/.exec(line)?.[1];
  assert.ok(ref, snapshot);
  const data = Buffer.from('approved bytes').toString('base64');
  const approval = browser.approveUpload(session, { target: browser.previewUpload(session), name: 'backend.txt', data });
  await browser.upload(session, ref, approval.handle);
  assert.equal(await browser.evaluate(session, 'document.querySelector("output").textContent'), 'approved bytes');
  const artifact = await browser.download(session, `${origin}/artifact`);
  assert.equal(readFileSync(artifact.path, 'utf8'), 'profile-authenticated fixture');
}

async function externalBackend() {
  const chrome = findChrome();
  if (!chrome) { console.log('External DevTools fixture skipped because Chromium is unavailable.'); return; }
  const profile = join(home, 'external-profile');
  const proc = spawn(chrome, [
    '--headless=new', '--no-first-run', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const closed = once(proc, 'close');
  let cdp;
  let browser;
  try {
    const endpoint = join(profile, 'DevToolsActivePort');
    for (let i = 0; i < 100 && !existsSync(endpoint); i++) await delay(100);
    const [port] = readFileSync(endpoint, 'utf8').split('\n');
    const cdpUrl = `http://127.0.0.1:${port}`;
    cdp = await CdpConnection.connect(await browserWsUrl(cdpUrl));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Network.setCookie', { name: 'fixture', value: 'ready', url: origin }, sessionId);
    const config = { ...DEFAULT_BROWSER, mode: 'cdp', cdpUrl };
    const undelegated = new BrowserManager(() => config);
    await assert.rejects(undelegated.snapshot('external'), /BROWSER_CONTEXT_NOT_DELEGATED/);
    browser = new BrowserManager(() => ({ ...config, cdpAllowDownloadPolicy: true }));
    assert.equal(browser.profile().owner, 'external');
    await transfers(browser, origin, 'external');
    const contender = new BrowserManager(() => ({ ...config, cdpAllowDownloadPolicy: true }));
    await assert.rejects(contender.snapshot('other-owner'), /BROWSER_PROFILE_IN_USE/);
    await contender.dispose();
    await browser.dispose();
    const { targetInfos } = await cdp.send('Target.getTargets');
    assert.ok(targetInfos.some(target => target.targetId === targetId));
    console.log('External Chromium requires delegation, reuses its existing authenticated profile, transfers approved files, and preserves the original tab.');
  } finally {
    await browser?.dispose();
    cdp?.close();
    proc.kill();
    await closed.catch(() => undefined);
  }
}

async function dockerBackend() {
  const hostname = process.env.SUN_BROWSER_DOCKER_HOST ?? (process.platform === 'darwin' ? 'host.docker.internal' : undefined);
  if (!hostname || !dockerImageExists(DEFAULT_BROWSER.docker.image)) {
    console.log('Docker Chromium fixture skipped because the image or local fixture route is unavailable.');
    return;
  }
  const origin = `http://${hostname}:${port}`;
  const config = { ...DEFAULT_BROWSER, mode: 'docker', profile: `fixture-${process.pid}` };
  const browser = new BrowserManager(() => config);
  const profile = join(home, 'browser', 'docker-profiles', config.profile);
  mkdirSync(join(profile, 'Default'), { recursive: true });
  mkdirSync(join(profile, 'native-downloads'));
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({
    download: { default_directory: '/profile/native-downloads', prompt_for_download: false },
  }));
  const name = `sun-browser-${config.profile}`;
  execFileSync('docker', [
    'run', '-d', '--name', name, '--label', 'sun-harness=browser', '--shm-size=1g', '-v', `${realpathSync(profile)}:/profile`,
    '-p', '127.0.0.1::9223', '-p', '127.0.0.1::6080', config.docker.image,
  ], { timeout: 20_000, stdio: 'ignore' });
  try {
    await assert.rejects(browser.navigate('docker', origin), /BROWSER_PERMISSION_REQUIRED/);
    grant(browser, origin);
    await browser.navigate('docker', origin);
    const live = new URL(browser.vncUrl);
    assert.equal(live.hostname, '127.0.0.1');
    const noVnc = await fetch(live, { signal: AbortSignal.timeout(5000) });
    assert.equal(noVnc.ok, true);
    assert.match(await noVnc.text(), /noVNC/i);
    const stream = new URL('/websockify', live);
    stream.protocol = 'ws:';
    const socket = new WebSocket(stream, 'binary');
    socket.binaryType = 'arraybuffer';
    try {
      const [greeting] = await once(socket, 'message', { signal: AbortSignal.timeout(5000) });
      assert.match(Buffer.from(greeting.data).toString('ascii'), /^RFB \d+\.\d+\n/);
    } finally {
      socket.close();
    }
    await browser.evaluate('docker', 'document.cookie = "fixture=ready; path=/; max-age=3600"');
    const contender = new BrowserManager(() => config);
    await assert.rejects(contender.snapshot('docker-contender'), /BROWSER_PROFILE_IN_USE/);
    await contender.dispose();
    assert.match(await browser.snapshot('docker'), /Backend transfer fixture/);
    await browser.evaluate('docker', `(() => {
      const link = document.createElement('a');
      link.download = 'ambient-test.txt';
      link.href = URL.createObjectURL(new Blob(['blocked']));
      document.body.append(link);
      link.click();
    })()`);
    await delay(500);
    assert.equal(existsSync(join(profile, 'native-downloads', 'ambient-test.txt')), false);
    assert.equal(browser.profile().owner, 'managed');
    await browser.dispose();
    const reused = new BrowserManager(() => config);
    try {
      await transfers(reused, origin, 'docker-reuse');
    } finally {
      await reused.dispose();
    }
    assert.equal(execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' }).trim(), 'true');
    console.log('Docker Chromium serves noVNC and negotiates RFB on loopback, refuses a concurrent policy owner, blocks native downloads, and transfers approved bytes after reusing the authenticated profile.');
  } finally {
    await browser.dispose();
    browser.stopDockerProfile();
  }
}

try {
  await externalBackend();
  await dockerBackend();
} finally {
  server.close();
  rmSync(home, { recursive: true, force: true });
}
