import { GENERAL_SECTION, sectionById, type FieldId, type SectionId } from './sections';

const pages = ['chat', 'automations', 'knowledge', 'extensions', 'evolution', 'intel'] as const;
export type Page = typeof pages[number] | 'settings';
export type AppRoute =
  | { page: Exclude<Page, 'settings'> }
  | { page: 'settings'; section: SectionId; field?: FieldId };

export function routeHash(route: AppRoute): string {
  if (route.page !== 'settings') return route.page === 'chat' ? '#chat' : `#${route.page}`;
  return `#settings/${route.section}${route.field ? `/${encodeURIComponent(route.field)}` : ''}`;
}

export function parseRoute(hash: string): AppRoute {
  const [page, section, field] = hash.slice(1).split('/');
  if (page !== 'settings') return { page: pages.find(name => name === page) ?? 'chat' };
  const found = sectionById(section);
  if (found && 'link' in found) return { page: found.link };
  let decoded: string | undefined;
  try {
    decoded = field ? decodeURIComponent(field) : undefined;
  } catch {
    // Ignore malformed field links and open the section.
  }
  const matched = found?.fields.find(id => id === decoded);
  return { page: 'settings', section: found?.id ?? GENERAL_SECTION, ...(matched ? { field: matched } : {}) };
}

export const fieldDomId = (key: string) => `settings-field-${encodeURIComponent(key)}`;
