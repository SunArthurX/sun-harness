import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { shq } from '../src/sandbox.js';
import { createShellHooks, inspectHooks, reviewHookTrust, runHook } from '../src/hooks.js';
import { HarnessHost, homePath, MockProvider } from '../src/index.js';
import { tempHome, tempWorkspace, testConfig } from './helpers.js';

let cwd: string;
let source: string;
const write = (value: unknown) => writeFileSync(source, JSON.stringify(value));

beforeEach(() => {
  tempHome();
  cwd = tempWorkspace();
  mkdirSync(join(cwd, '.sun'));
  source = join(cwd, '.sun', 'hooks.json');
});

describe('hook review boundary', () => {
  it('keeps a legacy hook inert, requires its displayed digest, and invalidates trust after editing', async () => {
    write({ sessionStart: [{ command: 'printf "initial"; touch reviewed.txt' }] });
    const runner = createShellHooks(cwd);
    const original = inspectHooks(cwd).hooks[0];
    expect(original.status).toBe('untrusted');
    expect(await runner.sessionStart('fixture')).toBe('');
    expect(existsSync(join(cwd, 'reviewed.txt'))).toBe(false);
    reviewHookTrust(cwd, [{ id: original.id, digest: original.digest, trust: true }]);
    expect(await runner.sessionStart('fixture')).toBe('initial');
    expect(existsSync(join(cwd, 'reviewed.txt'))).toBe(true);
    write({ sessionStart: [{ command: 'touch edited.txt' }] });
    const edited = inspectHooks(cwd).hooks[0];
    expect(edited.id).toBe(original.id);
    expect(edited.digest).not.toBe(original.digest);
    expect(edited.status).toBe('untrusted');
    expect(() => reviewHookTrust(cwd, [{ id: original.id, digest: original.digest, trust: true }])).toThrow(/stale/i);
    expect(await runner.sessionStart('fixture')).toBe('');
    expect(existsSync(join(cwd, 'edited.txt'))).toBe(false);
  });

  it('rechecks trust between hooks in the same event', async () => {
    write({ sessionStart: [
      { command: `printf '%s' '{}' > ${shq(source)}` },
      { command: 'touch stale-dispatch.txt' },
    ] });
    reviewHookTrust(cwd, inspectHooks(cwd).hooks.map(({ id, digest }) => ({ id, digest, trust: true })));
    await createShellHooks(cwd).sessionStart('fixture');
    expect(existsSync(join(cwd, 'stale-dispatch.txt'))).toBe(false);
  });

  it('validates matchers and fails closed for malformed or unreviewed policy hooks', async () => {
    write({ preToolUse: [
      { id: 'dangerous', matcher: '^(a+)+$', command: 'touch invalid.txt', onFailure: 'block' },
      { id: 'valid', matcher: '^(bash|edit_file)$', command: 'touch valid.txt' },
      { id: 'long', matcher: 'x'.repeat(257), command: 'touch long.txt' },
    ] });
    const inspected = inspectHooks(cwd);
    expect(inspected.hooks.map(hook => hook.explicitId)).toEqual(['valid']);
    expect(inspected.diagnostics.map(issue => issue.code)).toEqual(['INVALID_MATCHER', 'INVALID_MATCHER']);
    const runner = createShellHooks(cwd);
    const payload = { cwd, tool: 'bash', args: {}, sessionId: 'fixture' };
    expect(await runner.preToolUse!(payload)).toMatchObject({ block: expect.stringMatching(/failing closed/) });
    expect(existsSync(join(cwd, 'invalid.txt'))).toBe(false);
    expect(existsSync(join(cwd, 'valid.txt'))).toBe(false);
    writeFileSync(source, '{broken json');
    expect(inspectHooks(cwd).diagnostics[0]).toMatchObject({ code: 'INVALID_SOURCE', policy: true });
    expect(await runner.preToolUse!(payload)).toMatchObject({ block: expect.stringMatching(/failing closed/) });
    write({ preToolUse: [{ matcher: '^bash$', command: 'touch untrusted.txt', onFailure: 'block' }] });
    expect(await createShellHooks(cwd).preToolUse!(payload)).toMatchObject({ block: expect.stringMatching(/not trusted/) });
    expect(existsSync(join(cwd, 'untrusted.txt'))).toBe(false);
  });

  it('reviews a batch atomically and refuses duplicate explicit IDs', () => {
    write({ sessionStart: [{ id: 'one', command: 'true' }, { id: 'two', command: 'true' }] });
    const [one, two] = inspectHooks(cwd).hooks;
    expect(() => reviewHookTrust(cwd, [
      { id: one.id, digest: one.digest, trust: true },
      { id: two.id, digest: '0'.repeat(64), trust: true },
    ])).toThrow(/stale/i);
    expect(inspectHooks(cwd).hooks.every(hook => hook.status === 'untrusted')).toBe(true);
    write({ sessionStart: [{ id: 'one', command: 'true' }, { id: 'one', command: 'false' }] });
    expect(inspectHooks(cwd).hooks).toEqual([]);
    expect(inspectHooks(cwd).diagnostics.map(issue => issue.code)).toEqual(['DUPLICATE_ID', 'DUPLICATE_ID']);
  });
});


describe('bounded hook process execution', () => {
  it('scrubs inherited variables and bounds the combined output', async () => {
    vi.stubEnv('FIXTURE_HOOK_PRIVATE', 'synthetic-secret');
    try {
      const result = await runHook({ command: 'printf "%s" "${FIXTURE_HOOK_PRIVATE-unset}"' }, {}, cwd);
      expect(result).toMatchObject({ state: 'completed', code: 0, stdout: 'unset' });
      const oversized = await runHook({ command: 'head -c 40000 /dev/zero; head -c 40000 /dev/zero >&2' }, {}, cwd);
      expect(oversized).toMatchObject({ state: 'output-limit' });
      expect(Buffer.byteLength(oversized.stdout) + Buffer.byteLength(oversized.stderr)).toBeLessThanOrEqual(64 * 1024);
    } finally { vi.unstubAllEnvs(); }
  });

  it('kills a delayed descendant when the hook times out', async () => {
    const result = await runHook({ command: "(sleep 0.55; touch late-timeout.txt) & touch started.txt; wait", timeoutMs: 220 }, {}, cwd);
    expect(existsSync(join(cwd, 'started.txt'))).toBe(true);
    expect(result).toMatchObject({ state: 'timed-out', code: 124 });
    await delay(450);
    expect(existsSync(join(cwd, 'late-timeout.txt'))).toBe(false);
  });

  it('kills a delayed descendant when a running hook is cancelled', async () => {
    const controller = new AbortController();
    const pending = runHook({ command: '(sleep 0.55; touch late-cancel.txt) & touch ready.txt; wait' }, {}, cwd, { signal: controller.signal });
    await vi.waitFor(() => expect(existsSync(join(cwd, 'ready.txt'))).toBe(true));
    controller.abort();
    expect(await pending).toMatchObject({ state: 'cancelled', code: 130 });
    await delay(560);
    expect(existsSync(join(cwd, 'late-cancel.txt'))).toBe(false);
  });
});


describe('hook fixture host contract', () => {
  it('previews without execution, checks trust, and redacts credentials in the view and result', async () => {
    const secret = 'T07_FIXTURE_INLINE_SECRET';
    write({ preToolUse: [{ matcher: '^list_dir$', command: `touch fixture-ran.txt; printf '%s' ${secret}` }] });
    const config = testConfig();
    config.sandbox.mode = 'off';
    config.providers.fixture = { type: 'openai', baseUrl: 'https://example.invalid', models: ['test'], apiKey: secret };
    const host = new HarnessHost({ config, loadPlugins: false, connectMcp: false });
    try {
      const selected = host.listHooks(cwd).hooks[0];
      expect(selected.command).not.toContain(secret);
      const request = { cwd, id: selected.id, digest: selected.digest, fixture: 'read' as const, requestId: 'fixture-read' };
      const preview = await host.runHookFixture(request);
      expect(preview).toMatchObject({ matches: true, payload: { event: 'preToolUse', tool: 'list_dir' } });
      expect(preview.execution).toBeUndefined();
      expect(existsSync(join(cwd, 'fixture-ran.txt'))).toBe(false);
      await expect(host.runHookFixture({ ...request, execute: true })).rejects.toThrow(/DENIED/);
      host.reviewHooks(cwd, [{ id: selected.id, digest: selected.digest, trust: true }]);
      expect((await host.runHookFixture({ ...request, fixture: 'shell' })).matches).toBe(false);
      const result = await host.runHookFixture({ ...request, execute: true });
      expect(result.execution).toMatchObject({ state: 'completed', code: 0, stdout: '[REDACTED]' });
      expect(existsSync(join(cwd, 'fixture-ran.txt'))).toBe(true);
    } finally { await host.dispose(); }
  });

  it('cancels a host fixture by its execution ID', async () => {
    write({ sessionStart: [{ command: 'touch fixture-ready.txt; (sleep 0.5; touch fixture-late.txt) & wait' }] });
    const config = testConfig();
    config.sandbox.mode = 'off';
    const host = new HarnessHost({ config, loadPlugins: false, connectMcp: false });
    try {
      const hook = host.listHooks(cwd).hooks[0];
      host.reviewHooks(cwd, [{ id: hook.id, digest: hook.digest, trust: true }]);
      const pending = host.runHookFixture({ cwd, id: hook.id, digest: hook.digest, fixture: 'read', execute: true, requestId: 'cancel-fixture' });
      await vi.waitFor(() => expect(existsSync(join(cwd, 'fixture-ready.txt'))).toBe(true));
      expect(host.cancelHookFixture('not-running')).toBe(false);
      expect(host.cancelHookFixture('cancel-fixture')).toBe(true);
      expect((await pending).execution).toMatchObject({ state: 'cancelled' });
      expect(host.cancelHookFixture('cancel-fixture')).toBe(false);
      await delay(520);
      expect(existsSync(join(cwd, 'fixture-late.txt'))).toBe(false);
    } finally { await host.dispose(); }
  });

  it('aborts a running session-start hook before its delayed child or model call can run', async () => {
    write({ sessionStart: [{ command: 'touch startup-ready.txt; (sleep 0.5; touch startup-late.txt) & wait' }] });
    const config = testConfig();
    config.sandbox.mode = 'off';
    const provider = new MockProvider();
    const host = new HarnessHost({ config, loadPlugins: false, connectMcp: false, providerFactory: () => ({ provider, model: 'mock' }) });
    try {
      const hook = host.listHooks(cwd).hooks[0];
      host.reviewHooks(cwd, [{ id: hook.id, digest: hook.digest, trust: true }]);
      const session = host.createSession({ cwd });
      const send = host.send(session.id, 'First message');
      await vi.waitFor(() => expect(existsSync(join(cwd, 'startup-ready.txt'))).toBe(true));
      expect(host.isRunning(session.id)).toBe(true);
      host.abort(session.id);
      await send;
      const events = host.getEvents(session.id);
      expect(events).toContainEqual(expect.objectContaining({ type: 'hook/run', event: 'sessionStart', state: 'cancelled' }));
      expect(events.at(-1)).toMatchObject({ type: 'run/status', status: 'aborted' });
      expect(provider.requests).toHaveLength(0);
      await delay(520);
      expect(existsSync(join(cwd, 'startup-late.txt'))).toBe(false);
    } finally { await host.dispose(); }
  });

  it('keeps the trust store outside a macOS hook workspace write grant', async ({ skip }) => {
    const { resolveSandboxKind } = await import('../src/sandbox.js');
    if (resolveSandboxKind('auto') !== 'seatbelt') skip();
    const home = homePath();
    const protectedFile = homePath('settings', 'unexpected.txt');
    writeFileSync(homePath('hooks.json'), JSON.stringify({ sessionStart: [{ command: `touch ${shq(protectedFile)}` }] }));
    const host = new HarnessHost({ config: testConfig(), loadPlugins: false, connectMcp: false });
    try {
      const hook = host.listHooks(home).hooks[0];
      host.reviewHooks(home, [{ id: hook.id, digest: hook.digest, trust: true }]);
      const result = await host.runHookFixture({ cwd: home, id: hook.id, digest: hook.digest, fixture: 'read', execute: true, requestId: 'sandbox-trust' });
      expect(result.execution?.code).not.toBe(0);
      expect(existsSync(protectedFile)).toBe(false);
    } finally { await host.dispose(); }
  });
});
