import { describe, expect, it } from 'vitest';
import type { CapabilityStatus } from '@sun/core';
import { parseRoute, routeHash } from '../src/renderer/src/settings/routes';
import { SECTIONS, searchSettings, visibleSections } from '../src/renderer/src/settings/sections';

import { settingChecks } from '../../../packages/core/src/settings/schema';

const cap = (id: string, state: CapabilityStatus['state'] = 'available'): CapabilityStatus => ({
  id, state, owner: 'core', surface: ['desktop', 'web'], configKeys: [],
});

describe('settings navigation', () => {
  const caps = [cap('core.settings.general'), cap('core.settings.sandbox'), cap('core.settings.providers', 'disabled')];

  it('finds the same control in both languages', () => {
    const expected = { section: 'general', field: 'maxSteps' };
    for (const query of ['MAX steps', '最大步数']) {
      expect(searchSettings(query, visibleSections(caps))).toContainEqual(expect.objectContaining(expected));
    }
  });

  it('keeps absent and disabled capabilities out of navigation and search', () => {
    expect(visibleSections(caps).map(section => section.id)).toEqual(['general', 'language', 'sandbox']);
    expect(searchSettings('providers', visibleSections(caps))).toEqual([]);
  });

  it('searches personal controls and exposes native Mini only with a desktop adapter', () => {
    const personal = [cap('core.settings.appearance'), cap('core.settings.notifications'), cap('core.settings.shortcuts')];
    expect(searchSettings('外观', visibleSections(personal))).toContainEqual({ section: 'appearance' });
    expect(searchSettings('quiet hours', visibleSections(personal))).toContainEqual({ section: 'notifications', field: 'ui.notifications.quietHours.enabled' });
    expect(visibleSections(personal).map(section => section.id)).not.toContain('mini');
    expect(visibleSections([...personal, cap('native.mini')]).map(section => section.id)).toContain('mini');
  });

  it('ties searchable setting IDs to the host write allowlist', () => {
    const staticFields = SECTIONS.flatMap(section => [...section.fields]).filter(key => !['providerEndpoint', 'providerModels'].includes(key));
    expect(staticFields.filter(key => !Object.hasOwn(settingChecks, key))).toEqual([]);
  });

  it('normalizes legacy, invalid, and direct field routes without trusting unknown IDs', () => {
    expect(parseRoute('#settings')).toEqual({ page: 'settings', section: 'general' });
    expect(parseRoute('#settings/unknown')).toEqual({ page: 'settings', section: 'general' });
    expect(parseRoute('#settings/general/unknown')).toEqual({ page: 'settings', section: 'general' });
    expect(parseRoute(routeHash({ page: 'settings', section: 'general', field: 'maxSteps' })))
      .toEqual({ page: 'settings', section: 'general', field: 'maxSteps' });
    expect(parseRoute('#extensions')).toEqual({ page: 'extensions' });
  });
});
