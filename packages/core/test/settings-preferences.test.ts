import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hostMethods } from '../src/gateway.js';
import { HarnessHost } from '../src/host.js';
import { MockProvider } from '../src/providers/mock.js';
import { isQuietAt, shortcutIssues, USER_PROFILE_MAX } from '../src/settings/preferences.js';

let home: string;
let host: HarnessHost | undefined;
const options = { loadPlugins: false, connectMcp: false, shellHooks: false };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'sun-preferences-'));
  vi.stubEnv('SUN_HOME', home);
});
afterEach(async () => {
  await host?.dispose();
  host = undefined;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe('everyday preference persistence', () => {
  it('fills legacy defaults, applies user settings and restores them from disk', async () => {
    const file = join(home, 'config.json');
    writeFileSync(file, JSON.stringify({ ui: { language: 'en', future: true } }));
    host = new HarnessHost(options);
    expect(host.getSettings().values.ui).toMatchObject({
      language: 'en', theme: 'system', textScale: 1, reducedMotion: 'system', startPage: 'chat', mini: false, readAloud: false,
    });
    const result = host.updateSettings({
      scope: 'user', expectedRevision: host.getSettings().revision,
      changes: { 'ui.theme': 'dark', 'ui.textScale': 1.25, 'ui.startPage': 'settings', 'ui.notifications.quietHours.timeZone': 'Asia/Shanghai' },
    });
    expect(result).toMatchObject({ ok: true, apply: 'immediate' });
    expect(JSON.parse(readFileSync(file, 'utf8')).ui.future).toBe(true);
    await host.dispose();
    host = new HarnessHost(options);
    expect(host.getSettings().values.ui).toMatchObject({ theme: 'dark', textScale: 1.25, startPage: 'settings',
      notifications: { quietHours: { timeZone: 'Asia/Shanghai' } } });
  });

  it('rejects invalid time zones, scale, and reserved or colliding shortcuts without a write', () => {
    host = new HarnessHost(options);
    for (const changes of [
      { 'ui.textScale': 1.6 },
      { 'ui.notifications.quietHours.timeZone': 'Mars/Olympus' },
      { 'ui.notifications.quietHours.start': '24:00' },
      { 'ui.shortcuts.palette': 'Meta+Q' },
      { 'ui.shortcuts.palette': 'Primary+N' },
    ]) {
      expect(host.updateSettings({ scope: 'user', expectedRevision: 'missing', changes })).toMatchObject({ ok: false, code: 'INVALID' });
      expect(host.getSettings().revision).toBe('missing');
    }
  });

  it('respects the configured default mode and preserves explicit overrides', () => {
    host = new HarnessHost(options);
    expect(host.updateSettings({ scope: 'host', expectedRevision: 'missing', changes: { defaultMode: 'assistant' } })).toMatchObject({ ok: true });
    expect(host.createSession({ repoCwd: home })).toMatchObject({ mode: 'assistant', cwd: join(home, 'workspace') });
    expect(host.createSession({ mode: 'coding', repoCwd: home })).toMatchObject({ mode: 'coding', cwd: home });
    expect(host.createSession({ cwd: home })).toMatchObject({ mode: 'assistant', cwd: home });
  });

  it('blocks transcription before provider access when voice is disabled', async () => {
    host = new HarnessHost(options);
    const result = host.updateSettings({ scope: 'host', expectedRevision: 'missing', changes: { 'voice.enabled': false } });
    expect(result).toMatchObject({ ok: true, snapshot: { values: { voice: { enabled: false } } } });
    await expect(host.transcribe('', 'audio/webm')).rejects.toThrow(/CAPABILITY_DISABLED/);
  });

  it('omits new memory input and extraction while keeping the explicit profile', async () => {
    mkdirSync(join(home, 'memory'));
    writeFileSync(join(home, 'memory', 'MEMORY.md'), 'memory-only-sentinel');
    writeFileSync(join(home, 'memory', 'USER.md'), 'explicit-profile-sentinel');
    writeFileSync(join(home, 'memory', 'INSTRUCTIONS.md'), 'explicit-instructions-sentinel');
    writeFileSync(join(home, 'config.json'), JSON.stringify({ titles: 'first-message' }));
    const provider = new MockProvider([{ text: 'done', toolCalls: [] }]);
    host = new HarnessHost({ ...options, providerFactory: () => ({ provider, model: 'fixture' }) });
    expect(host.updateSettings({ scope: 'host', expectedRevision: host.getSettings().revision, changes: { 'memory.enabled': false } })).toMatchObject({ ok: true });
    const session = host.createSession({ cwd: home, mode: 'assistant' });
    await host.send(session.id, 'Try my preferences.');
    await host.wait(session.id);
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0].system).toContain('explicit-profile-sentinel');
    expect(provider.requests[0].system).toContain('# Personal instructions\nexplicit-instructions-sentinel');
    expect(host.getEvents(session.id).find(event => event.type === 'request/header')).toMatchObject({
      systemPrompt: provider.requests[0].system,
    });
    expect(provider.requests[0].system).not.toContain('memory-only-sentinel');
    expect(await host.extractMemories(session.id)).toEqual({ added: 0 });
    expect(readFileSync(join(home, 'memory', 'MEMORY.md'), 'utf8')).toBe('memory-only-sentinel');
  });
  it('keeps extracted facts out of the profile and rejects stale note replacements', async () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ titles: 'first-message' }));
    const provider = new MockProvider([
      { text: 'Done.', toolCalls: [] },
      { text: '{"memories":[{"text":"Extracted fact sentinel","kind":"fact","core":true}]}', toolCalls: [] },
    ]);
    host = new HarnessHost({ ...options, providerFactory: () => ({ provider, model: 'fixture' }) });
    const methods = hostMethods(host, { mode: 'gateway' });
    expect(methods.setUserProfile('Explicit profile', '')).toBe(true);
    expect(methods.setUserProfile('Stale profile', '')).toBe(false);
    expect(methods.getUserProfile()).toBe('Explicit profile\n');
    expect(methods.setPersonalInstructions('x'.repeat(USER_PROFILE_MAX + 1), '')).toBe(true);
    expect(methods.getPersonalInstructions()).toBe('x'.repeat(USER_PROFILE_MAX));
    expect(methods.setPersonalInstructions('Explicit instructions', 'x'.repeat(USER_PROFILE_MAX))).toBe(true);

    const session = host.createSession({ cwd: home, mode: 'assistant' });
    await host.send(session.id, 'Extract facts from this turn.');
    await host.wait(session.id);
    await vi.waitFor(() => expect(methods.getMemory(true)).toContain('Extracted fact sentinel'));
    expect(methods.getUserProfile()).toBe('Explicit profile\n');
    expect(methods.getPersonalInstructions()).toBe('Explicit instructions');
    expect(methods.setMemory('Overwrite', '')).toBe(false);
    expect(methods.getMemory(true)).toContain('Extracted fact sentinel');
  });
});

describe('local clock and shortcuts', () => {
  const quiet = { enabled: true, timeZone: 'America/New_York', start: '22:00', end: '07:00' };

  it('wraps overnight and honors exact local boundaries', () => {
    expect(isQuietAt(new Date('2026-01-12T03:00:00Z'), quiet)).toBe(true);
    expect(isQuietAt(new Date('2026-01-12T11:59:00Z'), quiet)).toBe(true);
    expect(isQuietAt(new Date('2026-01-12T12:00:00Z'), quiet)).toBe(false);
    expect(isQuietAt(new Date('2026-01-12T03:00:00Z'), { ...quiet, end: quiet.start })).toBe(false);
  });

  it('evaluates both repeated hours and handles the skipped spring hour', () => {
    const interval = { ...quiet, start: '01:00', end: '02:00' };
    expect(isQuietAt(new Date('2026-11-01T05:30:00Z'), interval)).toBe(true);
    expect(isQuietAt(new Date('2026-11-01T06:30:00Z'), interval)).toBe(true);
    expect(isQuietAt(new Date('2026-03-08T07:00:00Z'), interval)).toBe(false);
  });

  it('detects platform alias collisions and permits multiple unbound shortcuts', () => {
    expect(shortcutIssues({ palette: 'Primary+K', newChat: 'Ctrl+K', mini: '' })).toMatchObject({
      'ui.shortcuts.palette': 'SHORTCUT_CONFLICT', 'ui.shortcuts.newChat': 'SHORTCUT_CONFLICT',
    });
    expect(shortcutIssues({ palette: '', newChat: '', mini: '' })).toEqual({});
  });
});
