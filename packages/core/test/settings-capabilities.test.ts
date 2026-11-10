import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessHost } from '../src/host.js';
import { GatewayClient, hostMethods, startGateway, type RunningGateway } from '../src/gateway.js';
import { SETTINGS_PROTOCOL_VERSION as v } from '../src/settings/protocol.js';
import { MockProvider } from '../src/providers/mock.js';
import type { ModelResponse } from '../src/providers/types.js';
import { call } from './helpers.js';

let home: string;
let host: HarnessHost | undefined;
let gateway: RunningGateway | undefined;
const hostOptions = { loadPlugins: false, connectMcp: false, shellHooks: false };
const ids = (values: { id: string }[]) => values.map(item => item.id);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sun-capabilities-'));
  vi.stubEnv('SUN_HOME', home);
});
afterEach(async () => {
  await gateway?.close();
  await host?.dispose();
  host = undefined;
  gateway = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('capability transport', () => {
  it('exposes the same descriptor IDs and redacted settings shape on host, IPC and HTTP', async () => {
    host = new HarnessHost(hostOptions);
    const cli = host.getSettings();
    const ipc = hostMethods(host, { mode: 'local', surface: 'desktop' });
    const desktop = ipc.getSettings(v);
    gateway = await startGateway(host, { port: 0 });
    const client = new GatewayClient(gateway);
    const web = await client.call('getSettings', v);
    expect(cli.protocolVersion).toBe(v);
    expect(ipc.appInfo().settingsProtocolVersion).toBe(v);
    expect((await client.call('appInfo')).settingsProtocolVersion).toBe(v);
    expect(ids(cli.capabilities)).toEqual(ids(desktop.capabilities));
    expect(ids(cli.capabilities)).toEqual(ids(web.capabilities));
    expect(cli.values).toEqual(desktop.values);
    expect(cli.values).toEqual(web.values);
    expect(await client.call('listCapabilities', v)).toEqual(web.capabilities);
    expect(web.capabilities).toContainEqual(expect.objectContaining({ id: 'native.appshots', state: 'unavailable', reasonCode: 'SURFACE_UNSUPPORTED' }));
    expect(web.capabilities).toContainEqual(expect.objectContaining({ id: 'extension.mcp', state: 'disabled' }));
    expect(web.capabilities).toContainEqual(expect.objectContaining({ id: 'core.settings.general', state: 'available', configKeys: expect.arrayContaining(['ui.language']) }));
  });

  it('checks protocol before reading configuration or committing a settings edit', async () => {
    host = new HarnessHost(hostOptions);
    gateway = await startGateway(host, { port: 0 });
    const client = new GatewayClient(gateway);
    const patch = { expectedRevision: 'missing', scope: 'host', changes: { maxSteps: 20 } };
    await expect(client.call('updateSettings', patch, v + 1)).rejects.toThrow(/SETTINGS_PROTOCOL_MISMATCH/);
    expect(host.getSettings().revision).toBe('missing');
    writeFileSync(join(home, 'config.json'), '{ invalid');
    await expect(client.call('getSettings')).rejects.toThrow(/SETTINGS_PROTOCOL_MISMATCH/);
    await expect(client.call('listCapabilities', v + 1)).rejects.toThrow(/SETTINGS_PROTOCOL_MISMATCH/);
    await expect(client.call('constructor')).rejects.toThrow(/Unknown method/);
  });

  it('checks native status again at dispatch and never forwards native calls over HTTP', async () => {
    let enabled = true;
    const capture = vi.fn(async () => ({
      appId: 'fixture', title: 'Fixture', windowId: '1', mime: 'image/png' as const, width: 1, height: 1,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6Q0AAAAASUVORK5CYII=',
    }));
    host = new HarnessHost({ ...hostOptions, nativeCapabilities: {
      appshots: { status: () => enabled ? 'available' : 'disabled', capture, render: async image => image },
    } });
    const ipc = hostMethods(host, { mode: 'local', surface: 'desktop' });
    expect(ipc.listCapabilities(v)).toContainEqual(expect.objectContaining({ id: 'native.appshots', state: 'available' }));
    const chat = host.createSession({ cwd: home });
    await expect(ipc.captureAppshot(v, chat.id)).resolves.toMatchObject({ appId: 'fixture' });
    enabled = false;
    await expect(ipc.captureAppshot(v, chat.id)).rejects.toThrow(/CAPABILITY_DISABLED/);
    await expect(ipc.inspectComputerUse(v)).rejects.toThrow(/CAPABILITY_UNAVAILABLE/);
    gateway = await startGateway(host, { port: 0 });
    enabled = true;
    const client = new GatewayClient(gateway);
    await expect(client.call('captureAppshot', v)).rejects.toThrow(/Unknown method/);
    await expect(client.call('inspectComputerUse', v)).rejects.toThrow(/Unknown method/);
    for (const method of ['prepareAppshot', 'cancelAppshot', 'sendAppshotMessage']) {
      await expect(client.call(method, v, chat.id)).rejects.toThrow(/Unknown method/);
    }
    expect(capture).toHaveBeenCalledTimes(1);
  });
});

describe('extension lifecycle', () => {
  function install(name: string, code: string, manifest?: object): string {
    const dir = join(home, 'plugins', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), code);
    if (manifest) writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest));
    return dir;
  }

  it('inspects static declarations without running plugin code or exposing private manifest data', async () => {
    const marker = join(home, 'imported');
    const code = `import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'imported'); export default () => {};`;
    install('declared', code, { sun: { requestedActions: ['tools', 'network'] }, private: 'SECRET_MANIFEST_FIELD' });
    install('malformed', code, { sun: { requestedActions: ['SECRET_ACTION_FIELD'] } });
    install('legacy', 'export default () => {};');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: { disabled: ['declared'], settings: { declared: { key: 'SECRET_SETTINGS_FIELD' } } } }));
    host = new HarnessHost({ ...hostOptions, loadPlugins: true });
    expect(host.pluginStates).toEqual([
      expect.objectContaining({ name: 'declared', manifest: 'declared', status: 'disabled', requestedActions: ['tools', 'network'] }),
      expect.objectContaining({ name: 'legacy', manifest: 'undeclared', status: 'inactive' }),
      expect.objectContaining({ name: 'malformed', manifest: 'invalid', status: 'error', error: 'INVALID_MANIFEST' }),
    ]);
    expect(JSON.stringify(host.pluginStates)).not.toMatch(/SECRET_|sun-capabilities-/);
    expect(existsSync(marker)).toBe(false);
    await host.init();
    expect(existsSync(marker)).toBe(false);
    expect(host.pluginStates.find(p => p.name === 'legacy')?.status).toBe('loaded');
  });

  it('revokes queued dispatch while a started call drains and persists both lifecycle outcomes', async () => {
    const began = join(home, 'began');
    const finish = join(home, 'finish');
    const neighbor = join(home, 'neighbor');
    const delivered = join(home, 'delivered-events');
    const privateArgument = 'PRIVATE_TOOL_ARGUMENT';
    install('fixture', `import { appendFileSync, existsSync } from 'node:fs';
      export default api => {
        api.registerTool({name:'fixture_tool', description:'Fixture', parameters:{type:'object'}, risk:'exec',
          execute: async ({value}) => {
            appendFileSync(${JSON.stringify(began)}, value + '\\n');
            for (let i = 0; i < 1000 && !existsSync(${JSON.stringify(finish)}); i++) {
              await new Promise(resolve => setTimeout(resolve, 5));
            }
            return 'FIXTURE_FINISHED';
          }
        });
        api.registerKnowledgeProvider({id:'fixture_kb',name:'Fixture',search:async () => []});
        api.registerMode({id:'fixture_mode',label:'Fixture',description:'Fixture',prompt:'Fixture mode prompt.'});
        api.registerPromptSection('Fixture', 'Fixture prompt section.');
        api.onSessionEvent((_id, event) => {
          if (event.type === 'user/message') appendFileSync(${JSON.stringify(delivered)}, 'delivered\\n');
        });
      };`, { sun: { requestedActions: ['tools', 'knowledge', 'modes', 'prompts'] } });
    install('neighbor', `import { appendFileSync } from 'node:fs';
      export default () => appendFileSync(${JSON.stringify(neighbor)}, 'activated\\n');`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      titles: 'first-message', approval: 'suggest', unrelated: { keep: true }, plugins: { settings: { fixture: { token: 'SECRET_PLUGIN_TOKEN' } } },
    }));
    const provider = new MockProvider([
      { text: '', toolCalls: [call('fixture_tool', { value: privateArgument }, 'started')] },
      { text: '', toolCalls: [call('fixture_tool', { value: 'QUEUED' }, 'queued')] },
      { text: '', toolCalls: [call('fixture_tool', { value: 'FUTURE' }, 'future')] },
    ]);
    host = new HarnessHost({ ...hostOptions, loadPlugins: true, providerFactory: () => ({ provider, model: 'test' }) });
    await host.init();
    gateway = await startGateway(host, { port: 0 });
    const client = new GatewayClient(gateway);
    const release = host.registerApprover();
    const started = host.createSession({ cwd: home });
    const queued = host.createSession({ cwd: home });
    const future = host.createSession({ cwd: home });
    const events: string[] = [];
    const unsubscribe = host.subscribe(e => {
      if (e.kind === 'plugins') events.push(e.plugins.find(p => p.name === 'fixture')?.status ?? '');
    });
    const approve = (id: string) => {
      const pending = host!.pendingApprovals().find(item => item.callId === id)!;
      expect(host!.approve(id, 'allow', pending.promptId)).toBe(true);
    };
    try {
      const kb = host.knowledgeProviders().find(p => p.id === 'fixture_kb')!;
      const { revision } = await client.call('getSettings', v);
      const disable = { name: 'fixture', enabled: false, expectedRevision: revision };
      await expect(client.call('setPluginEnabled', disable, v + 1)).rejects.toThrow(/SETTINGS_PROTOCOL_MISMATCH/);
      expect(host.updateSettings({ expectedRevision: revision, scope: 'host', changes: { 'plugins.disabled': ['fixture'] } })).toMatchObject({ ok: false, code: 'INVALID' });
      await host.send(started.id, 'Start the tool');
      await vi.waitFor(() => expect(host!.pendingApprovals().map(p => p.callId)).toContain('started'));
      approve('started');
      await vi.waitFor(() => expect(existsSync(began)).toBe(true));
      await host.send(queued.id, 'Queue the tool');
      await vi.waitFor(() => expect(host!.pendingApprovals().map(p => p.callId)).toContain('queued'));
      expect(await client.call('setPluginEnabled', disable, v)).toMatchObject({ ok: true, apply: 'immediate', audit: 'recorded' });
      expect(await client.call('setPluginEnabled', disable, v)).toMatchObject({ ok: false, code: 'CONFLICT' });
      expect(await client.call('listPlugins')).toContainEqual(expect.objectContaining({
        name: 'fixture', status: 'draining', enabled: false, inFlight: 1, contributes: { tools: [], modes: [], knowledge: [], prompts: [] },
      }));
      expect(host.listCapabilities()).toContainEqual(expect.objectContaining({ id: 'extension.plugin.fixture', state: 'disabled', reasonCode: 'PLUGIN_DRAINING' }));
      expect(host.listModes().map(m => m.id)).not.toContain('fixture_mode');
      expect(host.knowledgeProviders().map(p => p.id)).not.toContain('fixture_kb');
      await expect(kb.search('Fixture', 1)).rejects.toThrow(/CAPABILITY_DISABLED/);
      const enable = { ...disable, enabled: true, expectedRevision: host.getSettings().revision };
      expect(await client.call('setPluginEnabled', enable, v)).toEqual({ ok: false, code: 'BUSY' });
      await host.send(future.id, 'Call after disabling');
      await host.wait(future.id);
      expect(host.getEvents(future.id).find(e => e.type === 'tool/result')).toMatchObject({ isError: true, output: expect.stringMatching(/Unknown tool/) });
      expect(JSON.stringify(provider.requests.at(-1))).not.toContain('Fixture prompt section.');
      expect(readFileSync(delivered, 'utf8')).toBe('delivered\ndelivered\n');
      approve('queued');
      await host.wait(queued.id);
      expect(host.getEvents(queued.id).find(e => e.type === 'tool/result')).toMatchObject({ isError: true, output: expect.stringMatching(/CAPABILITY_DISABLED/) });
      expect(readFileSync(began, 'utf8')).toBe(privateArgument + '\n');
      writeFileSync(finish, '');
      await host.wait(started.id);
      expect(host.getEvents(started.id).find(e => e.type === 'tool/result')).toMatchObject({ isError: false, output: 'FIXTURE_FINISHED' });
      expect(events).toEqual(['draining', 'disabled']);
      const audit = readFileSync(join(home, 'settings', 'audit.jsonl'), 'utf8');
      expect(audit).not.toMatch(/PRIVATE_TOOL_ARGUMENT|SECRET_PLUGIN_TOKEN/);
      expect(audit.trim().split('\n').map(line => JSON.parse(line)).filter(event => event.kind === 'plugin/lifecycle')).toEqual([
        expect.objectContaining({ name: 'fixture', status: 'draining', inFlight: 1 }),
        expect.objectContaining({ name: 'fixture', status: 'disabled', inFlight: 0 }),
      ]);
      expect(JSON.parse(readFileSync(join(home, 'config.json'), 'utf8'))).toMatchObject({
        unrelated: { keep: true }, plugins: { disabled: ['fixture'], settings: { fixture: { token: 'SECRET_PLUGIN_TOKEN' } } },
      });
      const restarted = new HarnessHost({ ...hostOptions, loadPlugins: true });
      expect(restarted.pluginStates.find(p => p.name === 'fixture')).toMatchObject({ status: 'disabled', inFlight: 0 });
      await restarted.dispose();
      expect(await client.call('setPluginEnabled', enable, v)).toMatchObject({ ok: true, apply: 'immediate' });
      expect(host.pluginStates.find(p => p.name === 'fixture')).toMatchObject({ status: 'loaded', enabled: true });
      expect(readFileSync(neighbor, 'utf8')).toBe('activated\n');
    } finally {
      writeFileSync(finish, '');
      unsubscribe();
      release();
      for (const { id } of [started, queued, future]) host.abort(id);
      await Promise.all([started, queued, future].map(({ id }) => host!.wait(id)));
    }
  });

  it('discards registrations when a plugin is disabled during asynchronous activation', async () => {
    const began = join(home, 'activating');
    const finish = join(home, 'finish');
    install('slow', `import { existsSync, writeFileSync } from 'node:fs';
      export default async api => {
        writeFileSync(${JSON.stringify(began)}, '');
        for (let i = 0; i < 1000 && !existsSync(${JSON.stringify(finish)}); i++) {
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        api.registerMode({id:'should_be_discarded',label:'Slow',description:'Fixture',prompt:'Fixture'});
      };`);
    host = new HarnessHost({ ...hostOptions, loadPlugins: true });
    const loading = host.init();
    try {
      await vi.waitFor(() => expect(existsSync(began)).toBe(true));
      const ipc = hostMethods(host, { mode: 'local', surface: 'desktop' });
      expect(await ipc.setPluginEnabled({ name: 'slow', enabled: false, expectedRevision: host.getSettings().revision }, v)).toMatchObject({ ok: true });
      expect(ipc.listPlugins()[0]).toMatchObject({ status: 'draining', inFlight: 1 });
    } finally {
      writeFileSync(finish, '');
      await loading;
    }
    expect(host.pluginStates[0]).toMatchObject({ status: 'disabled', inFlight: 0 });
    expect(host.listModes().map(m => m.id)).not.toContain('should_be_discarded');
  });

  it('publishes loaded, disabled, and error states without publishing failed tools', async () => {
    const marker = join(home, 'broken-tool-ran');
    for (const name of ['ready', 'disabled', 'broken']) {
      const dir = join(home, 'plugins', name);
      mkdirSync(dir, { recursive: true });
      const code = name === 'broken'
        ? `import { writeFileSync } from 'node:fs';
          export default api => {
            api.registerTool({ name: 'broken_tool', description: 'Broken', parameters: {type:'object'}, risk: 'read',
              execute: async () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); return 'ran'; } });
            throw Error('PRIVATE_FIXTURE_PLUGIN_ERROR');
          };`
        : 'export default () => {};';
      writeFileSync(join(dir, 'index.mjs'), code);
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({ plugins: { disabled: ['disabled'] }, titles: 'first-message' }));
    const provider = new MockProvider([{ text: '', toolCalls: [call('broken_tool', {})] }]);
    host = new HarnessHost({ ...hostOptions, loadPlugins: true, providerFactory: () => ({ provider, model: 'test' }) });
    await host.init();
    const capabilities = host.listCapabilities();
    expect(capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'extension.plugin.ready', state: 'available' }),
      expect.objectContaining({ id: 'extension.plugin.disabled', state: 'disabled' }),
      expect.objectContaining({ id: 'extension.plugin.broken', state: 'error' }),
    ]));
    expect(JSON.stringify(capabilities)).not.toContain('PRIVATE_FIXTURE_PLUGIN_ERROR');
    const session = host.createSession({ cwd: home });
    await host.send(session.id, 'Call the failed extension');
    await host.wait(session.id);
    const result = host.getEvents(session.id).find(e => e.type === 'tool/result');
    expect(result).toMatchObject({ output: expect.stringMatching(/Unknown tool/) });
    expect(existsSync(marker)).toBe(false);
  });

  it('revokes a stale approved tool call after reloading a disabled plugin', async () => {
    const dir = join(home, 'plugins', 'fixture');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.mjs'), `export default api => api.registerTool({
      name: 'fixture_tool', description: 'Fixture', parameters: { type: 'object' }, risk: 'exec',
      execute: async () => 'PLUGIN_EXECUTED'
    });`);
    writeFileSync(join(home, 'config.json'), JSON.stringify({ titles: 'first-message', approval: 'suggest' }));
    const provider = new MockProvider([{ text: '', toolCalls: [call('fixture_tool', {}, 'fixture-call')] }]);
    host = new HarnessHost({ ...hostOptions, loadPlugins: true, providerFactory: () => ({ provider, model: 'test' }) });
    await host.init();
    const release = host.registerApprover();
    const session = host.createSession({ cwd: home });
    try {
      await host.send(session.id, 'Call the fixture');
      await vi.waitFor(() => expect(host!.pendingApprovals()).toHaveLength(1));
      writeFileSync(join(home, 'config.json'), JSON.stringify({ titles: 'first-message', approval: 'suggest', plugins: { disabled: ['fixture'] } }));
      await host.reloadPlugins();
      expect(host.listCapabilities()).toContainEqual(expect.objectContaining({ id: 'extension.plugin.fixture', state: 'disabled' }));
      const pending = host.pendingApprovals()[0];
      expect(host.approve(pending.callId, 'allow', pending.promptId)).toBe(true);
      await host.wait(session.id);
      const result = host.getEvents(session.id).find(e => e.type === 'tool/result');
      expect(result).toMatchObject({ output: expect.stringMatching(/CAPABILITY_DISABLED/) });
      expect(JSON.stringify(result)).not.toContain('PLUGIN_EXECUTED');
    } finally {
      host.abort(session.id);
      release();
      await host.wait(session.id);
    }
  });
});
