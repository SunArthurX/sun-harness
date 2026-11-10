import { defaults, checks } from './schema.mjs';

export function createHost(saved = {}) {
  let state = { ...saved };
  let revision = 0;
  const get = () => ({
    revision,
    values: Object.fromEntries(Object.keys(defaults).map(key => [key, state[key] ?? defaults[key]])),
    origins: Object.fromEntries(Object.keys(defaults).map(key => [key, Object.hasOwn(state, key) ? 'user' : 'default'])),
  });
  return {
    get,
    update(expected, changes) {
      if (expected !== revision) return { ok: false, code: 'CONFLICT' };
      for (const [key, value] of Object.entries(changes)) {
        if (!Object.hasOwn(checks, key) || !checks[key](value)) return { ok: false, code: 'INVALID', key };
      }
      state = { ...state, ...changes };
      revision++;
      return { ok: true, snapshot: get() };
    },
    persist: () => ({ ...state }),
  };
}
