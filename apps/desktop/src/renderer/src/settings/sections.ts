import type { CapabilityStatus, SettingScope } from '@sun/core';
import { tk } from '../i18n';
import { zhCN } from '../locale-zh-CN';

export const GROUPS = [
  { id: 'personal', label: tk('Personal') },
  { id: 'integrations', label: tk('Integrations') },
  { id: 'coding', label: tk('Coding') },
] as const;

export const FIELD_LABELS = {
  'storage.trashDays': tk('Days to keep items in trash'),
  'storage.autoCleanupDays': tk('Automatic cleanup age in days'),
  'ui.language': tk('Language'),
  defaultMode: tk('Default mode'),
  'ui.theme': tk('Theme'),
  'ui.textScale': tk('Text scale'),
  'ui.reducedMotion': tk('Motion'),
  'ui.startPage': tk('Startup page'),
  'ui.notifications.completion': tk('Notify when a run finishes'),
  'ui.notifications.pause': tk('Notify when a run pauses'),
  'ui.notifications.failure': tk('Notify when a run fails'),
  'ui.notifications.approval': tk('Notify when approval is needed'),
  'ui.notifications.quietHours.enabled': tk('Quiet hours'),
  'ui.notifications.quietHours.timeZone': tk('Quiet hours time zone'),
  'ui.notifications.quietHours.start': tk('Quiet hours start'),
  'ui.notifications.quietHours.end': tk('Quiet hours end'),
  'memory.enabled': tk('Recall and extract memories'),
  'voice.enabled': tk('Enable voice input'),
  'voice.stt': tk('Transcription model'),
  'ui.readAloud': tk('Read responses aloud'),
  'ui.shortcuts.palette': tk('Command palette shortcut'),
  'ui.shortcuts.newChat': tk('New chat shortcut'),
  'ui.shortcuts.mini': tk('Global Mini shortcut'),
  'ui.shortcuts.appshot': tk('Global Appshot shortcut'),
  'ui.appshots': tk('Enable Appshots'),
  'ui.mini': tk('Enable Mini'),
  defaultModel: tk('Default model'),
  fallbackModels: tk('Fallback chain (used when a model runs out of quota)'),
  'autoResume.enabled': tk('Auto-resume paused sessions'),
  'autoResume.intervalMinutes': tk('Auto-resume interval (minutes)'),
  approval: tk('Approval'),
  denyInsteadOfPrompting: tk('Deny instead of prompting (the agent is told why and keeps going; headless runs always do this)'),
  maxSteps: tk('Max steps per run'),
  'review.model': tk('Review model'),
  'review.minimumSeverity': tk('Minimum severity to display'),
  'review.rules': tk('Review rule sources'),
  'review.diffBytes': tk('Diff budget in bytes'),
  'review.completionGate': tk('Require a complete review before finishing'),
  'sandbox.mode': tk('Shell sandbox mode'),
  'sandbox.network': tk('Network policy'),
  'sandbox.allow': tk('Allowed hosts (comma separated, *.domain for subdomains)'),
  'sandbox.autoApprove': tk('In auto-edit, run sandboxed shell commands without asking'),
  providerEndpoint: tk('Provider endpoint'),
  providerModels: tk('Models (comma separated)'),
  'kb.roots': tk('Personal KB folders (comma separated)'),
  'kb.embeddings.enabled': tk('Hybrid retrieval (BM25 + embeddings; note chunks are sent to the embedding provider)'),
  'kb.embeddings.model': tk('Embedding model'),
  'kb.company.enabled': tk('Company knowledge base (reserved HTTP provider)'),
  'kb.company.baseUrl': tk('Company knowledge endpoint'),
  'briefing.enabled': tk('Prepare a briefing every day'),
  'briefing.hour': tk('Briefing hour'),
  'briefing.minute': tk('Briefing minute'),
  'intel.hour': tk('Intel hour'),
  'intel.minute': tk('Intel minute'),
} as const;

export type FieldId = keyof typeof FIELD_LABELS;
interface Section {
  id: string;
  label: string;
  group: typeof GROUPS[number]['id'];
  capability: string;
  scope?: SettingScope;
  link?: 'extensions';
  fields: readonly FieldId[];
  aliases?: readonly string[];
}

export const SECTIONS = [
  {
    id: 'general', label: tk('General'), group: 'personal', capability: 'core.settings.general', scope: 'host',
    fields: ['defaultMode', 'defaultModel', 'fallbackModels', 'autoResume.enabled', 'autoResume.intervalMinutes', 'approval', 'denyInsteadOfPrompting', 'maxSteps'],
    aliases: [tk('Models'), tk('Run limits')],
  },
  {
    id: 'language', label: tk('Language'), group: 'personal', capability: 'core.settings.general', scope: 'user',
    fields: ['ui.language'], aliases: [tk('Interface language')],
  },
  {
    id: 'appearance', label: tk('Appearance'), group: 'personal', capability: 'core.settings.appearance', scope: 'user',
    fields: ['ui.theme', 'ui.textScale', 'ui.reducedMotion', 'ui.startPage'],
  },
  {
    id: 'notifications', label: tk('Notifications'), group: 'personal', capability: 'core.settings.notifications', scope: 'user',
    fields: ['ui.notifications.completion', 'ui.notifications.pause', 'ui.notifications.failure', 'ui.notifications.approval',
      'ui.notifications.quietHours.enabled', 'ui.notifications.quietHours.timeZone', 'ui.notifications.quietHours.start', 'ui.notifications.quietHours.end'],
  },
  {
    id: 'profile', label: tk('User profile'), group: 'personal', capability: 'core.settings.profile',
    fields: [],
  },
  {
    id: 'instructions', label: tk('Personal instructions'), group: 'personal', capability: 'core.settings.profile',
    fields: [],
  },
  {
    id: 'memory', label: tk('Memory'), group: 'personal', capability: 'core.settings.memory', scope: 'host',
    fields: ['memory.enabled'],
  },
  {
    id: 'voice', label: tk('Voice input'), group: 'personal', capability: 'core.settings.voice', scope: 'host',
    fields: ['voice.enabled', 'voice.stt'],
  },
  {
    id: 'read-aloud', label: tk('Read aloud'), group: 'personal', capability: 'core.settings.read-aloud', scope: 'user',
    fields: ['ui.readAloud'],
  },
  {
    id: 'shortcuts', label: tk('Keyboard shortcuts'), group: 'personal', capability: 'core.settings.shortcuts', scope: 'user',
    fields: ['ui.shortcuts.palette', 'ui.shortcuts.newChat'],
  },
  {
    id: 'mini', label: tk('Mini'), group: 'personal', capability: 'native.mini', scope: 'user',
    fields: ['ui.mini', 'ui.shortcuts.mini'],
  },
  {
    id: 'briefing', label: tk('Daily briefing'), group: 'personal', capability: 'core.settings.briefing', scope: 'host',
    fields: ['briefing.enabled', 'briefing.hour', 'briefing.minute'],
  },
  {
    id: 'archives', label: tk('Archived chats'), group: 'personal', capability: 'core.sessions.archive',
    fields: [], aliases: [tk('Restore archived session')],
  },
  {
    id: 'data-controls', label: tk('Data controls'), group: 'personal', capability: 'core.sessions.import',
    fields: [], aliases: [tk('Import session'), tk('Export session')],
  },
  {
    id: 'storage', label: tk('Storage'), group: 'personal', capability: 'core.storage', scope: 'host',
    fields: ['storage.trashDays', 'storage.autoCleanupDays'], aliases: [tk('Retention'), tk('Trash')],
  },
  { id: 'usage', label: tk('Usage'), group: 'personal', capability: 'core.usage', fields: [], aliases: [tk('Efficiency')] },
  {
    id: 'providers', label: tk('Providers & credentials'), group: 'integrations', capability: 'core.settings.providers', scope: 'host',
    fields: ['providerEndpoint', 'providerModels'], aliases: [tk('Providers'), tk('API credentials')],
  },
  {
    id: 'passwords', label: tk('Passwords'), group: 'integrations', capability: 'native.credentials',
    fields: [], aliases: [tk('Private sign-in'), tk('Website credentials')],
  },
  {
    id: 'knowledge', label: tk('Knowledge'), group: 'integrations', capability: 'core.settings.knowledge', scope: 'host',
    fields: ['kb.roots', 'kb.embeddings.enabled', 'kb.embeddings.model', 'kb.company.enabled', 'kb.company.baseUrl'],
  },
  {
    id: 'hooks', label: tk('Hooks'), group: 'integrations', capability: 'extension.hooks',
    fields: [], aliases: [tk('Hook trust'), tk('Fixture testing')],
  },
  {
    id: 'appshots', label: tk('Appshots'), group: 'integrations', capability: 'native.appshots', scope: 'user',
    fields: ['ui.appshots', 'ui.shortcuts.appshot'], aliases: [tk('Screen Recording'), tk('Capture Appshot')],
  },
  {
    id: 'computer-use', label: tk('Computer Use'), group: 'integrations', capability: 'native.computer-use',
    fields: [], aliases: [tk('Accessibility access'), tk('Native app control')],
  },
  {
    id: 'browser', label: tk('Browser permissions'), group: 'integrations', capability: 'core.settings.browser',
    fields: [], aliases: [tk('Browser'), tk('Browser profile')],
  },
  {
    id: 'execution-targets', label: tk('Execution targets'), group: 'integrations', capability: 'core.execution-jobs',
    fields: [], aliases: [tk('Remote jobs'), tk('Local Docker')],
  },
  {
    id: 'connections', label: tk('Connections'), group: 'integrations', capability: 'native.connections',
    fields: [], aliases: [tk('Remote gateway'), tk('Certificate fingerprint')],
  },
  {
    id: 'plugins', label: tk('Plugins'), group: 'integrations', capability: 'extension.plugins',
    fields: [], aliases: [tk('Plugin permissions'), tk('Requested actions')],
  },
  {
    id: 'extensions', label: tk('Skills · MCP · Plugins'), group: 'integrations', capability: 'extension.plugins',
    link: 'extensions', fields: [],
  },
  {
    id: 'worktrees', label: tk('Worktrees'), group: 'coding', capability: 'core.worktrees',
    fields: [], aliases: [tk('Worktree cleanup'), tk('Worktree setup')],
  },
  {
    id: 'review', label: tk('Code review'), group: 'coding', capability: 'core.settings.review', scope: 'host',
    fields: ['review.model', 'review.minimumSeverity', 'review.rules', 'review.diffBytes', 'review.completionGate'],
  },
  {
    id: 'sandbox', label: tk('Shell sandbox'), group: 'coding', capability: 'core.settings.sandbox', scope: 'host',
    fields: ['sandbox.mode', 'sandbox.network', 'sandbox.allow', 'sandbox.autoApprove'],
  },
  {
    id: 'intel', label: tk('Intel schedule'), group: 'coding', capability: 'core.settings.intel', scope: 'host',
    fields: ['intel.hour', 'intel.minute'],
  },
] as const satisfies readonly Section[];

export type SettingsSection = typeof SECTIONS[number];
export type SectionId = SettingsSection['id'];
export const GENERAL_SECTION: SectionId = 'general';
export const sectionById = (id: string) => SECTIONS.find(section => section.id === id);

export function visibleSections(capabilities: CapabilityStatus[]): SettingsSection[] {
  const ready = new Set(capabilities.filter(capability => capability.state === 'available').map(capability => capability.id));
  const appshotsCanBeEnabled = capabilities.some(capability => capability.id === 'native.appshots' && capability.reasonCode === 'APPSHOT_DISABLED');
  return SECTIONS.filter(section => ready.has(section.capability) || (section.id === 'appshots' && appshotsCanBeEnabled));
}

function normalized(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en').trim();
}

export interface SettingsMatch {
  section: SectionId;
  field?: FieldId;
}

export function searchSettings(query: string, sections: SettingsSection[]): SettingsMatch[] {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const matches = (labels: string[]) => {
    const text = normalized(labels.flatMap(label => [label, zhCN[label] ?? '']).join(' '));
    return terms.every(term => text.includes(term));
  };
  return sections.flatMap((section): SettingsMatch[] => {
    const labels = [section.label, ...('aliases' in section ? section.aliases : [])];
    const result: SettingsMatch[] = matches(labels) ? [{ section: section.id }] : [];
    for (const field of section.fields) {
      if (matches([FIELD_LABELS[field], field]) || (!result.length && matches([...labels, FIELD_LABELS[field]]))) {
        result.push({ section: section.id, field });
      }
    }
    return result;
  });
}
