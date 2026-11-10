import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SETTINGS_PROTOCOL_VERSION as v } from '../src/settings/protocol.js';
import { HarnessHost } from '../src/host.js';
import { GatewayClient, hostMethods, startGateway, type RunningGateway } from '../src/gateway.js';
import { MockProvider } from '../src/providers/mock.js';
import type { ModelResponse } from '../src/providers/types.js';
import { configFixtures, fakeSecret } from './fixtures/settings.js';

let root: string;
let config: string;
let gateway: RunningGateway | undefined;
const openHost = () => new HarnessHost({ loadPlugins: false, connectMcp: false, shellHooks: false });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sun-settings-service-'));
  vi.stubEnv('SUN_HOME', root);
  config = join(root, 'config.json');
});
afterEach(async () => {
  await gateway?.close();
  gateway = undefined;
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('settings service and transport', () => {
  it('hides legacy secrets at the gateway and rejects both obsolete RPCs', async () => {
    writeFileSync(config, configFixtures.secretBearing);
    gateway = await startGateway(openHost(), { port: 0 });
    const client = new GatewayClient(gateway);
    const snapshot = await client.call('getSettings', v);
    expect(JSON.stringify(snapshot)).not.toContain(fakeSecret);
    expect(snapshot).toMatchObject({ values: { providers: { fixture: { configured: true, source: 'file', baseUrl: '' } } } });
    await expect(client.call('getConfig')).rejects.toThrow(/protocol mismatch/i);
    await expect(client.call('updateConfig', { approval: 'full-auto' })).rejects.toThrow(/protocol mismatch/i);
    expect(readFileSync(config, 'utf8')).toBe(configFixtures.secretBearing);
  });

  it('rejects a stale page and leaves unrelated unknown fields intact', () => {
    writeFileSync(config, configFixtures.legacy);
    const calls = hostMethods(openHost(), { mode: 'local' });
    const first = calls.getSettings(v);
    expect(first.origins['ui.language']).toMatchObject({ source: 'default' });
    const change = { expectedRevision: first.revision, scope: 'user', changes: { 'ui.language': 'zh-CN' } };
    expect(calls.updateSettings(change, v)).toMatchObject({
      ok: true, apply: 'immediate', snapshot: { values: { ui: { language: 'zh-CN' } }, origins: { 'ui.language': { source: 'user' } } },
    });
    expect(calls.updateSettings({ ...change, changes: { 'ui.language': 'en' } }, v)).toMatchObject({ ok: false, code: 'CONFLICT' });
    expect(JSON.parse(readFileSync(config, 'utf8')).futureSetting).toEqual({ preserve: ['untouched'] });
    expect(openHost().getSettings().values.ui.language).toBe('zh-CN');
  });

  it('rejects unknown, invalid, mixed-scope and credential-bearing edits as a unit', () => {
    writeFileSync(config, configFixtures.legacy);
    const host = openHost();
    const expectedRevision = host.getSettings().revision;
    for (const [key, value] of [
      ['maxSteps', -1], ['maxSteps', Infinity], ['ui.language', 'en'], ['defaultModel', 'unknown/missing'],
      ['providers.fixture.apiKey', fakeSecret], ['providers.__proto__.models', ['bad']],
      ['providers.fixture.baseUrl', `https://u:${fakeSecret}@example.invalid`], ['newKey', true],
    ] as const) {
      expect(host.updateSettings({ scope: 'host', expectedRevision, changes: { [key]: value, approval: 'suggest' } })).toMatchObject({
        ok: false, code: 'INVALID',
      });
      expect(readFileSync(config, 'utf8')).toBe(configFixtures.legacy);
    }
  });

  it('keeps private legacy values on disk and audits only key names and revisions', () => {
    writeFileSync(config, configFixtures.secretBearing);
    const host = openHost();
    const expectedRevision = host.getSettings().revision;
    expect(host.updateSettings({ expectedRevision, scope: 'host', changes: { maxSteps: 12 } })).toMatchObject({ ok: true, audit: 'recorded' });
    const audit = readFileSync(join(root, 'settings', 'audit.jsonl'), 'utf8');
    expect(audit).not.toContain(fakeSecret);
    expect(audit.trim().split('\n').map(row => JSON.parse(row))).toMatchObject([
      { keys: ['maxSteps'], before: expectedRevision, outcome: 'prepared' },
      { keys: ['maxSteps'], before: expectedRevision, outcome: 'committed', after: host.getSettings().revision },
    ]);
    expect(readFileSync(config, 'utf8')).toContain(fakeSecret);
  });

  it('refuses to save when the audit cannot be prepared', () => {
    writeFileSync(config, configFixtures.legacy);
    const host = openHost();
    mkdirSync(join(root, 'settings', 'audit.jsonl'), { recursive: true });
    expect(host.updateSettings({ expectedRevision: host.getSettings().revision, scope: 'host', changes: { maxSteps: 12 } })).toMatchObject({ ok: false, code: 'IO_ERROR' });
    expect(readFileSync(config, 'utf8')).toBe(configFixtures.legacy);
  });

  it('keeps host changes out of an active run while applying language immediately', async () => {
    writeFileSync(config, JSON.stringify({ titles: 'first-message' }));
    const reply = Promise.withResolvers<ModelResponse>();
    const provider = new MockProvider([() => reply.promise]);
    const host = new HarnessHost({
      loadPlugins: false, connectMcp: false, shellHooks: false,
      providerFactory: () => ({ provider, model: 'fixture/model' }),
    });
    const session = host.createSession({ cwd: root });
    try {
      await host.send(session.id, 'Test pending turn');
      const expectedRevision = host.getSettings().revision;
      expect(host.updateSettings({ expectedRevision, scope: 'host', changes: { approval: 'suggest' } })).toEqual({
        ok: false, code: 'BUSY',
      });
      expect(host.updateSettings({ expectedRevision, scope: 'user', changes: { 'ui.language': 'zh-CN' } })).toMatchObject({
        ok: true, apply: 'immediate',
      });
      expect(host.config.approval).toBe('auto-edit');
      reply.resolve({ text: 'done', toolCalls: [] });
      await host.wait(session.id);
      expect(host.updateSettings({ expectedRevision: host.getSettings().revision, scope: 'host', changes: { approval: 'suggest' } })).toMatchObject({
        ok: true, apply: 'next-turn',
      });
      expect(host.config.approval).toBe('suggest');
    } finally {
      reply.resolve({ text: 'done', toolCalls: [] });
      await host.wait(session.id);
      await host.dispose();
    }
  });

  it('preserves invalid and future-version documents for manual recovery', () => {
    for (const bytes of [configFixtures.invalidJson, configFixtures.invalidValues, '{"settingsSchemaVersion":999}']) {
      writeFileSync(config, bytes);
      expect(openHost).toThrow(/configuration|invalid JSON/i);
      expect(readFileSync(config, 'utf8')).toBe(bytes);
    }
  });
});
