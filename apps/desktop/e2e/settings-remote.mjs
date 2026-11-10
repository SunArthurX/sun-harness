// Exercise a pinned execution host in a different home from the desktop.
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HarnessHost, MockProvider, SETTINGS_PROTOCOL_VERSION, createDevice, ensureTls, revokeDevice, startGateway } from '@sun/core';
import { _electron as electron } from 'playwright-core';

const config = home => join(home, 'config.json');
const fixture = (home, theme, maxSteps) => writeFileSync(config(home), JSON.stringify({
  ui: { language: 'en', theme, startPage: 'settings' }, maxSteps, titles: 'first-message', approval: 'suggest',
}));
const read = home => JSON.parse(readFileSync(config(home), 'utf8'));

if (process.argv[2] === '--gateway') {
  const tls = ensureTls();
  const provider = new MockProvider([{
    text: '', toolCalls: [{ id: 'cross-host-call', name: 'bash', arguments: '{"command":"echo approved"}' }],
  }]);
  const host = new HarnessHost({ providerFactory: () => ({ provider, model: 'fixture' }), loadPlugins: false, connectMcp: false });
  await host.init();
  const device = createDevice('desktop-fixture');
  let gateway = await startGateway(host, { tls, port: 0, advertise: false });
  const port = Number(new URL(gateway.url).port);
  process.send({ url: gateway.url, fingerprint: tls.fingerprint, token: device.token });
  process.on('message', async command => {
    try {
      if (command === 'pause') {
        await gateway.close();
        const { revision } = host.getSettings();
        assert.equal(host.updateSettings({ expectedRevision: revision, scope: 'host', changes: { maxSteps: 86 } }).ok, true);
        host.createSession({ title: 'Created during interruption' });
      }
      if (command === 'disconnect-target') await gateway.close();
      if (command === 'resume') gateway = await startGateway(host, { tls, port, advertise: false });
      if (command === 'revoke') revokeDevice(device.device.id);
      if (command === 'close') {
        await gateway.close();
        await host.dispose();
        process.disconnect();
        return;
      }
      process.send({ command });
    } catch (error) {
      process.send({ error: String(error) });
    }
  });
} else {
  const localHome = mkdtempSync(join(tmpdir(), 'sun-local-desktop-'));
  const remoteHome = mkdtempSync(join(tmpdir(), 'sun-remote-desktop-'));
  const cliHome = mkdtempSync(join(tmpdir(), 'sun-cli-desktop-'));
  fixture(localHome, 'dark', 41);
  fixture(remoteHome, 'light', 83);
  const env = { ...process.env, SUN_SKIP_SHELL_ENV: '1', SUN_NO_GATEWAY: '1' };
  const child = fork(fileURLToPath(import.meta.url), ['--gateway'], { env: { ...env, SUN_HOME: remoteHome } });
  let app;
  const receive = () => Promise.race([
    once(child, 'message').then(([message]) => { if (message.error) throw new Error(message.error); return message; }),
    once(child, 'exit').then(([code]) => { throw new Error('Fixture gateway exited with ' + code); }),
  ]);
  async function command(name) {
    const result = receive();
    child.send(name);
    assert.equal((await result).command, name);
  }
  try {
    const endpoint = await receive();
    const cli = fileURLToPath(new URL('../../../packages/cli/dist/index.js', import.meta.url));
    const add = token => execFileSync(process.execPath, [cli, 'remote', 'add', 'fixture', endpoint.url,
      '--token', token, '--fingerprint', endpoint.fingerprint], { env: { ...env, SUN_HOME: cliHome }, encoding: 'utf8' });
    assert.throws(() => add('sund_invalid_fixture'), /rejected the token/);
    assert.equal(existsSync(join(cliHome, 'remotes.json')), false);
    assert.match(add(endpoint.token), /Connected/);
    assert.ok(JSON.parse(readFileSync(join(cliHome, 'remotes.json'), 'utf8')).remotes[0].hostId);
    console.log('CLI checks the pinned protocol and credentials before persisting a remote profile.');
    const require = createRequire(import.meta.url);
    const launch = () => electron.launch({
      executablePath: require('electron'),
      args: ['--user-data-dir=' + join(localHome, 'electron'), fileURLToPath(new URL('../out/main/index.js', import.meta.url))],
      env: { ...env, SUN_HOME: localHome },
    });
    app = await launch();
    let page = await app.firstWindow();
    page.setDefaultTimeout(12_000);
    const call = (method, ...args) => page.evaluate(([name, values]) => window.sun.call(name, ...values), [method, args]);
    const panel = id => page.locator('[data-settings-panel="' + id + '"]');
    const open = async id => {
      await page.locator('[data-settings-section="' + id + '"]').click();
      await panel(id).waitFor();
    };
    await page.waitForURL(/#settings\/general$/);
    await open('connections');
    await page.getByLabel('HTTPS gateway address').fill(endpoint.url);
    await page.getByRole('button', { name: 'Preview certificate' }).click();
    await page.getByText(endpoint.fingerprint, { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Device token').isDisabled(), true);
    await page.getByLabel('I verified this fingerprint').check();
    await page.getByLabel('Connection name').fill('Fixture remote');
    await page.getByLabel('Device token').fill(endpoint.token);
    await page.getByRole('button', { name: 'Trust and connect' }).click();
    await page.locator('[data-connection="ready"]').waitFor();
    await page.getByRole('button', { name: 'Use this computer' }).waitFor();
    const connection = await call('listDesktopConnections');
    assert.equal(connection.selected, 'Fixture remote');
    assert.ok(connection.status.hostId);
    assert.equal(connection.profiles[0].fingerprint, endpoint.fingerprint);
    assert.equal(JSON.stringify(connection).includes(endpoint.token), false);
    const registry = join(localHome, 'remotes.json');
    assert.equal(statSync(registry).mode & 0o777, 0o600);
    assert.equal(JSON.parse(readFileSync(registry, 'utf8')).default, undefined);
    console.log('Electron confirms the real TLS fingerprint before attaching and exposes only redacted connection metadata.');

    const jobSession = await call('createSession', { title: 'Remote execution fixture', cwd: remoteHome, sandbox: 'off' });
    await call('selectDesktopConnection', null);
    await page.reload();
    await panel('connections').waitFor();
    await open('execution-targets');
    const execution = panel('execution-targets');
    const targetId = `remote-gateway:${connection.status.hostId}`;
    await execution.getByLabel('Execution target', { exact: true }).selectOption(targetId);
    await execution.getByLabel('Target session').selectOption(jobSession.id);
    const commandText = 'printf remote-only > target-artifact.txt; printf target-output';
    await execution.getByLabel('Shell command').fill(commandText);
    await execution.getByRole('button', { name: 'Review job', exact: true }).click();
    assert.equal(existsSync(join(remoteHome, 'target-artifact.txt')), false);
    await execution.getByRole('button', { name: 'Start reviewed job', exact: true }).click();
    const job = execution.locator('[data-execution-job]');
    await job.waitFor();
    await execution.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
    await job.getByText('Succeeded', { exact: true }).waitFor();
    await job.getByRole('button', { name: 'View job output', exact: true }).click();
    await job.getByText('target-output', { exact: true }).waitFor();
    const operationId = await job.getAttribute('data-execution-job');
    const mapping = readFileSync(join(localHome, 'execution-jobs', `${operationId}.json`), 'utf8');
    assert.equal(mapping.includes(commandText), false);
    assert.equal(mapping.includes(endpoint.token), false);
    assert.equal(JSON.parse(mapping).targetId, targetId);
    assert.equal(readFileSync(join(remoteHome, 'target-artifact.txt'), 'utf8'), 'remote-only');
    assert.equal(existsSync(join(localHome, 'target-artifact.txt')), false);
    await command('disconnect-target');
    await execution.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
    await execution.getByText('Offline', { exact: true }).waitFor();
    await job.getByRole('button', { name: 'View job output', exact: true }).click();
    await execution.getByText('Output is unavailable from the originating target.', { exact: true }).waitFor();
    await command('resume');
    await execution.getByRole('button', { name: 'Refresh jobs', exact: true }).click();
    const outputButton = job.getByRole('button', { name: 'View job output', exact: true });
    await outputButton.click();
    await outputButton.and(job.locator('button:enabled')).waitFor();
    assert.equal(await execution.getByText('Output is unavailable from the originating target.', { exact: true }).isVisible(), false);
    await job.getByText('target-output', { exact: true }).waitFor();
    console.log('Desktop launches over a pinned gateway, shows its offline state, and recovers output from the original target after reconnect.');
    await call('selectDesktopConnection', 'Fixture remote');
    await page.reload();
    await page.locator('[data-connection="ready"]').waitFor();


    await open('appearance');
    assert.equal(await page.getByLabel('Theme').inputValue(), 'dark');
    await page.getByLabel('Theme').selectOption('system');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    assert.equal(read(localHome).ui.theme, 'system');
    assert.equal(read(remoteHome).ui.theme, 'light');
    await open('general');
    let steps = page.getByLabel('Max steps per run');
    assert.equal(await steps.inputValue(), '83');
    await steps.fill('84');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Saved', { exact: true }).waitFor();
    assert.equal(read(localHome).maxSteps, 41);
    assert.equal(read(remoteHome).maxSteps, 84);
    console.log('Desktop user preference and host setting writes change only their respective configuration files.');

    await app.close();
    app = await launch();
    page = await app.firstWindow();
    page.setDefaultTimeout(12_000);
    await page.locator('[data-connection="ready"]').waitFor();
    assert.equal((await call('listDesktopConnections')).selected, 'Fixture remote');
    await panel('general').waitFor();
    steps = page.getByLabel('Max steps per run');
    assert.equal(await steps.inputValue(), '84');
    console.log('The selected remote and the local preferences survive an Electron restart.');

    await steps.fill('85');
    await command('pause');
    await page.locator('[data-connection="stale"]').waitFor();
    assert.equal(await steps.inputValue(), '85');
    assert.equal(await steps.isDisabled(), true);
    await assert.rejects(call('createSession', { title: 'Stale mutation' }), /GATEWAY_CONNECTION_STALE/);
    const stale = await call('getSettings', SETTINGS_PROTOCOL_VERSION);
    assert.equal(stale.values.maxSteps, 84);
    await command('resume');
    await page.locator('[data-connection="ready"]').waitFor();
    const refreshed = await call('getSettings', SETTINGS_PROTOCOL_VERSION);
    assert.equal(refreshed.values.maxSteps, 86);
    assert.ok((await call('listSessions')).some(item => item.title === 'Created during interruption'));
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByText('Settings changed elsewhere. Reload the latest values before applying your edit.').waitFor();
    assert.equal(await steps.inputValue(), '85');
    assert.equal(read(remoteHome).maxSteps, 86);
    await page.getByRole('button', { name: 'Discard edit' }).click();
    console.log('After an actual disconnect, host writes pause. Reconnect refreshes state and retains the draft revision.');

    const session = await call('createSession', { title: 'Remote approval' });
    await call('send', session.id, 'Check the approval boundary.');
    let approval;
    for (let attempt = 0; attempt < 30 && !approval; attempt++) {
      approval = (await call('pendingApprovals'))[0];
      if (!approval) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(approval.callId, 'cross-host-call');
    await command('revoke');
    await page.locator('[data-connection="unauthorized"]').waitFor();
    await assert.rejects(call('approve', approval.callId, 'allow', approval.promptId), /GATEWAY_CONNECTION_STALE/);
    await open('connections');
    const epoch = await page.evaluate(async () => {
      await window.sun.call('selectDesktopConnection', null);
      try { await window.sun.call('createSession', { title: 'Wrong host' }); }
      catch (error) { return String(error); }
      return '';
    });
    assert.match(epoch, /GATEWAY_VIEW_CHANGED/);
    await page.reload();
    await panel('connections').getByText('This computer', { exact: true }).waitFor();
    assert.equal((await call('listSessions')).length, 0);
    assert.equal(read(localHome).maxSteps, 41);
    console.log('Revocation rejects old approvals, and an old renderer cannot dispatch to the newly selected local host.');
  } finally {
    if (app) await app.close();
    if (child.connected) {
      const exited = once(child, 'exit');
      child.send('close');
      await exited;
    }
    rmSync(localHome, { recursive: true, force: true });
    rmSync(remoteHome, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  }
}
