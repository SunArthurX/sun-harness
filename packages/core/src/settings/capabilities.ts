import type { PluginState } from '../plugins.js';
import { pluginCapability } from '../plugins.js';
import type { AppshotAdapter } from './capture.js';
import type { DesktopComputerAdapter } from './computer.js';
import { settingChecks } from './schema.js';
import type { CapabilityStatus, CapabilitySurface } from './types.js';

type State = CapabilityStatus['state'];

export interface NativeCapabilityAdapters {
  appshots?: AppshotAdapter;
  computerUse?: DesktopComputerAdapter;
}

const surfaces: CapabilitySurface[] = ['desktop', 'web', 'cli'];
const settingsGroups = [
  ['general', ['ui.language', 'defaultModel', 'defaultMode', 'fallbackModels', 'approval', 'denyInsteadOfPrompting', 'maxSteps', 'autoResume.']],
  ['appearance', ['ui.theme', 'ui.textScale', 'ui.reducedMotion', 'ui.startPage']],
  ['notifications', ['ui.notifications.']],
  ['profile', []],
  ['memory', ['memory.enabled']],
  ['voice', ['voice.']],
  ['read-aloud', ['ui.readAloud']],
  ['shortcuts', ['ui.shortcuts.palette', 'ui.shortcuts.newChat']],
  ['providers', []],
  ['sandbox', ['sandbox.']],
  ['knowledge', ['kb.']],
  ['briefing', ['briefing.']],
  ['intel', ['intel.']],
  ['review', ['review.']],
] as const;

function coreCapability(id: string, configKeys: string[] = []): CapabilityStatus {
  return { id, owner: 'core', state: 'available', surface: [...surfaces], configKeys };
}

function managerCapability(id: string, enabled: boolean, configKeys: string[]): CapabilityStatus {
  return {
    id, owner: 'extension', state: enabled ? 'available' : 'disabled',
    ...(enabled ? {} : { reasonCode: 'FEATURE_DISABLED' }),
    surface: [...surfaces], configKeys,
  };
}

export function nativeCapability(
  id: 'native.appshots' | 'native.computer-use' | 'native.mini' | 'native.connections' | 'native.credentials',
  surface: CapabilitySurface,
  adapter?: { status(): State | { state: State; reasonCode: string } },
): CapabilityStatus {
  const descriptor: CapabilityStatus = {
    id, owner: 'native', state: 'unavailable', surface: ['desktop'],
    configKeys: id === 'native.mini' ? ['ui.mini', 'ui.shortcuts.mini']
      : id === 'native.appshots' ? ['ui.appshots', 'ui.shortcuts.appshot'] : [],
  };
  if (surface !== 'desktop') return { ...descriptor, reasonCode: 'SURFACE_UNSUPPORTED' };
  if (!adapter) return { ...descriptor, reasonCode: 'ADAPTER_MISSING' };
  try {
    const result = adapter.status();
    const state = typeof result === 'string' ? result : result.state;
    if (typeof result !== 'string' && /^[A-Z][A-Z0-9_]{0,60}$/.test(result.reasonCode)) {
      return { ...descriptor, state, reasonCode: result.reasonCode };
    }
    if (state === 'available') return { ...descriptor, state };
    if (state === 'disabled') return { ...descriptor, state, reasonCode: 'FEATURE_DISABLED' };
    if (state === 'unavailable') return { ...descriptor, reasonCode: 'PLATFORM_UNSUPPORTED' };
  } catch {
    // Diagnostics expose reason codes rather than adapter exception payloads.
  }
  return { ...descriptor, state: 'error', reasonCode: 'PROBE_FAILED' };
}

export async function invokeNative<T>(descriptor: CapabilityStatus, invoke: () => Promise<T>): Promise<T> {
  if (descriptor.state !== 'available') throw new Error(`CAPABILITY_${descriptor.state.toUpperCase()}: ${descriptor.id} (${descriptor.reasonCode})`);
  try {
    return await invoke();
  } catch {
    throw new Error(`CAPABILITY_ERROR: ${descriptor.id}`);
  }
}

export function describeCapabilities(input: {
  surface: CapabilitySurface;
  mcpEnabled: boolean;
  pluginsEnabled: boolean;
  hooksEnabled: boolean;
  plugins: PluginState[];
  browserAvailable(): boolean;
  native?: NativeCapabilityAdapters;
}): CapabilityStatus[] {
  const browser = coreCapability('core.browser', ['browser.mode']);
  try {
    if (!input.browserAvailable()) {
      browser.state = 'unavailable';
      browser.reasonCode = 'BROWSER_BACKEND_MISSING';
    }
  } catch {
    browser.state = 'error';
    browser.reasonCode = 'PROBE_FAILED';
  }
  return [
    ...settingsGroups.map(([id, keys]) => coreCapability(`core.settings.${id}`,
      Object.keys(settingChecks).filter(key => keys.some(prefix => prefix.endsWith('.') ? key.startsWith(prefix) : key === prefix)),
    )),
    browser,
    coreCapability('core.settings.browser'),
    coreCapability('core.execution-jobs'),
    coreCapability('core.sessions.archive'),
    coreCapability('core.sessions.import'),
    coreCapability('core.storage', ['storage.trashDays', 'storage.autoCleanupDays']),
    coreCapability('core.usage'),
    coreCapability('core.git'),
    coreCapability('core.worktrees'),
    coreCapability('core.code-review'),
    managerCapability('extension.mcp', input.mcpEnabled, ['mcp.enabled']),
    managerCapability('extension.plugins', input.pluginsEnabled, ['plugins.disabled']),
    managerCapability('extension.hooks', input.hooksEnabled, []),
    ...input.plugins.map(pluginCapability).sort((a, b) => a.id.localeCompare(b.id)),
    nativeCapability('native.appshots', input.surface, input.native?.appshots),
    nativeCapability('native.computer-use', input.surface, input.native?.computerUse),
    nativeCapability('native.mini', input.surface),
    nativeCapability('native.connections', input.surface),
    nativeCapability('native.credentials', input.surface),
  ];
}
