// Offline macOS acceptance with an isolated HTTPS site and synthetic passwords.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { GatewayClient, HarnessHost, MockProvider, SETTINGS_PROTOCOL_VERSION as version, startGateway } from '@sun/core';
import { _electron as electron } from 'playwright-core';

assert.equal(process.platform, 'darwin');
const require = createRequire(import.meta.url);
const home = mkdtempSync(join(tmpdir(), 'sun-credentials-e2e-'));
const path = fileURLToPath(new URL('../out/main/index.js', import.meta.url));
const packaged = process.argv[2];
if (packaged) execFileSync('codesign', ['--verify', '--deep', '--strict', packaged]);
const config = join(home, 'config.json');
const vault = join(home, 'credentials', 'vault.json');
const label = 'Credential acceptance account';
const sentinel = `fixture-password-${randomUUID()}`;
const replacement = `replacement-password-${randomUUID()}`;
const env = { ...process.env, SUN_HOME: home, SUN_SKIP_SHELL_ENV: '1', SUN_NO_GATEWAY: '1' };
process.env.SUN_HOME = home;
writeFileSync(config, JSON.stringify({ defaultModel: 'missing/fixture', fallbackModels: [], ui: { language: 'en', startPage: 'settings', appshots: true } }));
const keyFile = join(home, 'key.pem');
const certFile = join(home, 'cert.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyFile, '-out', certFile, '-nodes',
  '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
const tls = { key: readFileSync(keyFile), cert: readFileSync(certFile) };
const pin = createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`https://127.0.0.1:${server.address().port}`)));
let externalRequests = 0;
const otherServer = createServer(tls, (_req, res) => { externalRequests++; res.end('Outside the approved origin'); });
const other = await listen(otherServer);
let submissions = 0;
let validSubmission = false;
let redirects = 0;
const siteServer = createServer(tls, (req, res) => {
  if (req.url === '/submit' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      submissions++;
      validSubmission = new URLSearchParams(body).get('password') === sentinel;
      res.setHeader('Set-Cookie', 'fixture_session=active; HttpOnly; Secure; SameSite=Strict');
      res.writeHead(303, { Location: '/signed-in' }).end();
    });
    return;
  }
  if (req.url === '/redirect') {
    redirects++;
    return res.writeHead(302, { Location: `${other}/redirected` }).end();
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/signed-in') return res.end('<h1>Signed in privately</h1>');
  const action = req.url === '/cross-form' ? `${other}/submit` : '/submit';
  res.end(`<!doctype html><title>Fixture sign-in</title><form method="post" action="${action}">
    <input type="password" name="password" aria-label="Fixture password"><button>Submit privately</button></form>
    <output id="echo"></output><img src="${other}/cross-origin-image" alt="">
    <a href="${other}/outside">Outside</a><a href="/redirect">Redirect</a>
    <script>document.querySelector('input').addEventListener('input', event => {
      document.getElementById('echo').textContent = event.target.value; document.title = event.target.value;
    });</script>`);
});
const origin = await listen(siteServer);

let app;
let host;
let gateway;
const traces = [];
const noSecret = value => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value) ?? '');
  assert.equal(bytes.includes(sentinel) || bytes.includes(replacement), false, 'A secret reached an observable surface');
};
const launch = async () => {
  const running = await electron.launch({ executablePath: packaged ? join(packaged, 'Contents', 'MacOS', 'sun-harness') : require('electron'),
    args: [`--user-data-dir=${join(home, 'electron')}`, `--ignore-certificate-errors-spki-list=${pin}`, ...(packaged ? [] : [path])], env });
  for (const stream of [running.process().stderr, running.process().stdout]) stream?.on('data', bytes => traces.push(Buffer.from(bytes)));
  return running;
};

try {
  app = await launch();
  let page = await app.firstWindow();
  const call = (method, ...args) => page.evaluate(([method, args]) => window.sun.call(method, ...args), [method, args]);
  const settings = () => page.locator('[data-settings-panel="passwords"]');
  async function openSettings() {
    page.setDefaultTimeout(12_000);
    await page.locator('[data-settings-section="passwords"]').click();
    const add = settings().getByRole('button', { name: 'Add website password' });
    const unavailable = settings().getByText('The system vault is unavailable. Use browser takeover to sign in manually.', { exact: true });
    const failed = settings().getByText('The password vault could not be opened.', { exact: true });
    // A newly signed macOS bundle can be waiting for a native Keychain dialog.
    await add.or(unavailable).or(failed).waitFor({ timeout: 90_000 });
    assert.equal(await add.isVisible(), true, 'The signed desktop fixture must have access to its system vault.');
  }
  async function openPrivate(url) {
    await settings().getByRole('button', { name: 'Private sign-in', exact: true }).click();
    await settings().getByLabel('Sign-in page HTTPS address').fill(url);
    await settings().getByRole('button', { name: 'Open private sign-in' }).click();
    for (let attempt = 0; attempt < 80; attempt++) {
      const controls = app.windows().find(window => window.url().endsWith('#private-sign-in'));
      if (controls) {
        controls.setDefaultTimeout(12_000);
        await controls.getByRole('button', { name: 'Fill saved password' }).waitFor();
        return controls;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('The desktop did not open the trusted sign-in controls.');
  }
  const inspectPrivate = (url, value = '') => app.evaluate(async ({ webContents, session }, { url, value }) => {
    const contents = webContents.getAllWebContents().find(contents => contents.getURL() === url);
    if (!contents) return undefined;
    const details = await contents.executeJavaScript(`({ bridge: typeof window.sun, node: typeof window.require,
      matches: (document.querySelector('input')?.value || '') === ${JSON.stringify(value)},
      reflected: !!document.querySelector('output')?.textContent, signedIn: !!document.querySelector('h1') })`);
    const [privateCookies, defaultCookies] = await Promise.all([contents.session.cookies.get({ url }), session.defaultSession.cookies.get({ url })]);
    return { ...details, temporary: !contents.session.isPersistent(), privateCookies: privateCookies.length, defaultCookies: defaultCookies.length };
  }, { url, value });

  await openSettings();
  await settings().getByRole('button', { name: 'Add website password' }).click();
  await settings().getByLabel('Website HTTPS address').fill(`${origin}/login?fixture=1`);
  await settings().getByLabel('Account label').fill(label);
  await settings().getByLabel('Website password', { exact: true }).fill(sentinel);
  await settings().getByRole('button', { name: 'Save password' }).click();
  await settings().getByText(label, { exact: true }).waitFor();
  const initial = await call('listDesktopCredentials', version);
  assert.equal(initial.available, true);
  assert.deepEqual(Object.keys(initial.entries[0]).sort(), ['id', 'label', 'origin', 'revision']);
  assert.equal(initial.entries[0].origin, origin);
  noSecret(initial);
  noSecret(readFileSync(vault));
  assert.equal(statSync(vault).mode & 0o777, 0o600);
  await assert.rejects(call('openDesktopCredentialSignIn', version, initial.entries[0].id, initial.entries[0].revision, other), /CREDENTIAL_GRANT_INVALID/);
  await assert.rejects(call('fillPrivateSignIn', version), /CREDENTIAL_METHOD_UNAVAILABLE/);

  const chat = await call('createSession', { cwd: home, title: 'Credential boundary fixture' });
  let controls = await openPrivate(`${origin}/cross-form`);
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('No eligible password field. Open the password step or sign in manually.', { exact: true }).waitFor();
  assert.equal((await inspectPrivate(`${origin}/cross-form`)).matches, true);
  const crossFormClosing = controls.waitForEvent('close');
  await controls.getByRole('button', { name: 'Close', exact: true }).click();
  await crossFormClosing;

  controls = await openPrivate(`${origin}/redirect`);
  for (let attempt = 0; attempt < 80 && redirects === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(redirects, 1);
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('No eligible password field. Open the password step or sign in manually.', { exact: true }).waitFor();
  assert.equal(externalRequests, 0);
  const redirectClosing = controls.waitForEvent('close');
  await controls.getByRole('button', { name: 'Close', exact: true }).click();
  await redirectClosing;

  controls = await openPrivate(`${origin}/login`);
  const before = await inspectPrivate(`${origin}/login`);
  assert.deepEqual(before, { bridge: 'undefined', node: 'undefined', matches: true, reflected: false,
    signedIn: false, temporary: true, privateCookies: 0, defaultCookies: 0 });
  await assert.rejects(controls.evaluate(() => window.sun.call('listSessions')), /CREDENTIAL_METHOD_UNAVAILABLE/);
  const attemptExternal = selector => app.evaluate(({ webContents }, { url, selector }) =>
    webContents.getAllWebContents().find(contents => contents.getURL() === url)
      .executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click(); true`), { url: `${origin}/login`, selector });
  await attemptExternal('a[href$="/outside"]');
  assert.equal((await inspectPrivate(`${origin}/login`)).matches, true);
  const cap = (await call('listCapabilities', version)).find(item => item.id === 'native.appshots');
  assert.equal(cap.reasonCode, 'APPSHOT_PRIVATE_WINDOW');
  await assert.rejects(call('captureAppshot', version, chat.id), /APPSHOT_PRIVATE_WINDOW/);
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('Password filled. Submit the form on the website.', { exact: true }).waitFor();
  const after = await inspectPrivate(`${origin}/login`, sentinel);
  assert.equal(after.matches && after.reflected, true);
  assert.equal(submissions, 0);
  noSecret(await controls.locator('body').innerText());
  noSecret(await settings().innerText());

  host = new HarnessHost({ providerFactory: () => ({ provider: new MockProvider([]), model: 'fixture' }), loadPlugins: false, connectMcp: false });
  await host.init();
  gateway = await startGateway(host, { port: 0, advertise: false });
  const client = new GatewayClient(gateway);
  const capabilities = (await client.connection()).capabilities;
  assert.equal(capabilities.find(item => item.id === 'native.credentials')?.state, 'unavailable');
  for (const method of ['listDesktopCredentials', 'saveDesktopCredential', 'deleteDesktopCredential', 'openDesktopCredentialSignIn', 'fillPrivateSignIn']) {
    await assert.rejects(client.call(method, version), /Unknown method/);
  }
  const observed = await host.browser.snapshot(chat.id);
  assert.match(observed, /URL: about:blank/);
  noSecret(observed);
  noSecret(await call('getEvents', chat.id));
  const exported = await call('exportSessionBundle', chat.id);
  noSecret(gunzipSync(Buffer.from(Object.values(exported))));

  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find(contents => contents.getURL() === url)
    .executeJavaScript(`document.querySelector('form').requestSubmit(); true`), `${origin}/login`);
  await app.evaluate(async ({ webContents }, url) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (webContents.getAllWebContents().some(contents => contents.getURL() === url)) return;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('Private login did not complete.');
  }, `${origin}/signed-in`);
  const loggedIn = await inspectPrivate(`${origin}/signed-in`);
  assert.equal(validSubmission, true);
  assert.equal(submissions, 1);
  assert.equal(loggedIn.signedIn && loggedIn.privateCookies === 1 && loggedIn.defaultCookies === 0, true);
  assert.equal(externalRequests, 0);
  const closing = controls.waitForEvent('close');
  await controls.getByRole('button', { name: 'Close', exact: true }).click();
  await closing;
  await app.close();
  app = await launch();
  page = await app.firstWindow();
  await openSettings();
  await settings().getByText(label, { exact: true }).waitFor();
  controls = await openPrivate(`${origin}/login`);
  assert.equal((await inspectPrivate(`${origin}/login`)).privateCookies, 0);
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('Password filled. Submit the form on the website.', { exact: true }).waitFor();
  assert.equal((await inspectPrivate(`${origin}/login`, sentinel)).matches, true);
  const secondClosing = controls.waitForEvent('close');
  await controls.getByRole('button', { name: 'Close', exact: true }).click();
  await secondClosing;

  await settings().getByRole('button', { name: 'Replace password' }).click();
  await settings().getByLabel('Website password', { exact: true }).fill(replacement);
  await settings().getByRole('button', { name: 'Save password' }).click();
  controls = await openPrivate(`${origin}/login`);
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('Password filled. Submit the form on the website.', { exact: true }).waitFor();
  assert.equal((await inspectPrivate(`${origin}/login`, replacement)).matches, true);
  await settings().getByRole('button', { name: 'Remove password' }).click();
  await settings().getByRole('button', { name: 'Confirm password removal' }).click();
  await settings().getByRole('button', { name: 'Add website password' }).waitFor();
  await controls.getByRole('button', { name: 'Fill saved password' }).click();
  await controls.getByText('The saved password is unavailable. Close this window or sign in manually.', { exact: true }).waitFor();
  const removedClosing = controls.waitForEvent('close');
  await controls.getByRole('button', { name: 'Close', exact: true }).click();
  await removedClosing;
  assert.deepEqual((await call('listDesktopCredentials', version)).entries, []);
  await assert.rejects(call('openDesktopCredentialSignIn', version, initial.entries[0].id, initial.entries[0].revision, origin), /CREDENTIAL_GRANT_INVALID/);
  noSecret(readFileSync(vault));
  noSecret(readFileSync(config));
  noSecret(readFileSync(join(home, 'settings', 'audit.jsonl')));
  noSecret(Buffer.concat(traces));
  if (packaged) console.log('The isolated fixture used the signed desktop application bundle.');
  console.log('macOS Keychain-backed encryption persisted across Electron restart. Private HTTPS sign-in filled only on request and did not auto-submit.');
  console.log('Cross-origin access, gateway calls, agent observations, Appshots, exports, and logs revealed no synthetic password. Closing cleared the private login.');
} finally {
  await app?.close();
  await gateway?.close();
  await host?.dispose();
  await Promise.all([siteServer, otherServer].map(server => new Promise(resolve => server.close(resolve))));
  rmSync(home, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
}
