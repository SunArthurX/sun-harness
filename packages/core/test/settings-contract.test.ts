import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, saveConfig } from '../src/config.js';
import { SessionLog } from '../src/log.js';
import { deriveMessages } from '../src/messages.js';
import { configFixtures, fakeSecret, FakeWindowCapture, fixturePng, sessionWithAttachment } from './fixtures/settings.js';

let root: string;
let configFile: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'sun-settings-contract-'));
  const sunHome = join(root, 'state');
  mkdirSync(sunHome);
  vi.stubEnv('SUN_HOME', sunHome);
  configFile = join(sunHome, 'config.json');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe('settings compatibility fixtures', () => {
  it('fills absent settings from defaults', () => {
    writeFileSync(configFile, configFixtures.minimal);
    expect(loadConfig().ui.language).toBe('system');
  });

  it('reads legacy config and preserves unknown keys during a preference edit', () => {
    writeFileSync(configFile, configFixtures.legacy);
    expect(loadConfig().defaultModel).toBe('fixture/model');
    saveConfig({ ui: { language: 'zh-CN' } });
    expect(loadConfig().ui.language).toBe('zh-CN');
    expect(JSON.parse(readFileSync(configFile, 'utf8')).futureSetting).toEqual({ preserve: ['untouched'] });
  });

  it('rejects malformed JSON without changing the original bytes', () => {
    writeFileSync(configFile, configFixtures.invalidJson);
    expect(() => loadConfig()).toThrow(/Invalid JSON/);
    expect(() => saveConfig({ ui: { language: 'zh-CN' } })).toThrow();
    expect(readFileSync(configFile, 'utf8')).toBe(configFixtures.invalidJson);
  });

  it('exercises all three independent credential carriers in the legacy format', () => {
    writeFileSync(configFile, configFixtures.secretBearing);
    const provider = loadConfig().providers.fixture;
    expect(provider.apiKey).toBe(fakeSecret);
    expect(provider.headers?.Authorization).toBe(`Bearer ${fakeSecret}`);
    expect(new URL(provider.baseUrl).password).toBe(fakeSecret);
  });
});

describe('attachment and native fixtures', () => {
  it('replays owned bytes from disk and reports missing bytes after restart', () => {
    const { id, path } = sessionWithAttachment(root);
    expect(deriveMessages(SessionLog.open(id).all())).toEqual([{
      role: 'user',
      content: 'Inspect the test window.',
      images: [{ mime: 'image/png', data: fixturePng.toString('base64') }],
    }]);
    unlinkSync(path);
    expect(deriveMessages(SessionLog.open(id).all())).toEqual([{
      role: 'user',
      content: 'Inspect the test window.\n[1 attached image(s) no longer available]',
    }]);
  });

  it('models capture denial, missing support and cancellation without touching the desktop', async () => {
    const adapter = new FakeWindowCapture();
    expect((await adapter.capture()).bytes).toEqual(fixturePng);
    adapter.state = 'denied';
    expect(adapter.probe()).toBe('denied');
    await expect(adapter.capture()).rejects.toThrow('denied');
    adapter.state = 'unavailable';
    await expect(adapter.capture()).rejects.toThrow('unavailable');
    await expect(adapter.capture(AbortSignal.abort(new Error('cancelled')))).rejects.toThrow('cancelled');
    expect(adapter.calls).toBe(3);
  });
});
