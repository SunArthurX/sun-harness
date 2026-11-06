import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HarnessHost, MockProvider, defaultConfig, PROVIDER_PRESETS, type MockStep, type SunConfig } from '../src/index.js';

export function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sun-test-'));
  process.env.SUN_HOME = join(dir, 'home');
  mkdirSync(process.env.SUN_HOME, { recursive: true });
  return dir;
}

export function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sun-ws-'));
  mkdirSync(join(dir, '.git'));
  return dir;
}

export function testConfig(patch: Partial<SunConfig> = {}): SunConfig {
  return {
    ...defaultConfig(),
    providers: { ...PROVIDER_PRESETS },
    defaultModel: 'mock/a',
    approval: 'full-auto',
    ...patch,
  };
}

export function call(name: string, args: unknown, id = `c_${Math.random().toString(36).slice(2, 8)}`) {
  return { id, name, arguments: JSON.stringify(args) };
}

/** Host whose every model ref maps to scripted providers keyed by ref. */
export async function mockHost(scripts: Record<string, MockStep[]>, patch: Partial<SunConfig> = {}) {
  const providers = new Map<string, MockProvider>();
  for (const [ref, steps] of Object.entries(scripts)) providers.set(ref, new MockProvider(steps, ref));
  const host = new HarnessHost({
    config: testConfig(patch),
    providerFactory: (ref) => {
      let p = providers.get(ref);
      if (!p) providers.set(ref, (p = new MockProvider([], ref)));
      return { provider: p, model: ref };
    },
    loadPlugins: false,
    connectMcp: false,
    shellHooks: false,
  });
  await host.init();
  return { host, providers };
}
