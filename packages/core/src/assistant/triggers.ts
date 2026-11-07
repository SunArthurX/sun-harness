import { watch, type FSWatcher } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

export interface TriggerDef {
  id: string;
  /** watch: files changed under `path` · webhook: POST /trigger/<id> on the gateway. */
  kind: 'watch' | 'webhook';
  /** Prompt template: {{files}} (watch) and {{payload}} (webhook) are replaced. */
  prompt: string;
  mode?: string;
  cwd?: string;
  path?: string;
  /** Only react to file names matching this regular expression (watch). */
  match?: string;
  debounceMs?: number;
  /** Environment variable holding the shared secret callers send as X-Sun-Trigger-Secret (webhook). */
  secretEnv?: string;
  enabled?: boolean;
}

const expand = (p: string) => resolve(p.startsWith('~/') ? homedir() + p.slice(1) : p);

export function renderTrigger(t: TriggerDef, vars: { files?: string[]; payload?: string }): string {
  return t.prompt
    .replace(/\{\{files\}\}/g, (vars.files ?? []).map((f) => `- ${f}`).join('\n') || '(none)')
    .replace(/\{\{payload\}\}/g, vars.payload ?? '');
}

/** File-watch triggers: debounce bursts of changes into one firing with the list of changed files. */
export class TriggerWatchers {
  private watchers: FSWatcher[] = [];

  start(defs: TriggerDef[], fire: (t: TriggerDef, files: string[]) => void): void {
    this.stop();
    for (const t of defs) {
      if (t.kind !== 'watch' || t.enabled === false || !t.path) continue;
      const root = expand(t.path);
      const re = t.match ? new RegExp(t.match) : undefined;
      let pending = new Set<string>();
      let timer: NodeJS.Timeout | undefined;
      try {
        const w = watch(root, { recursive: true }, (_ev, name) => {
          if (!name || name.split(/[\\/]/).some((part) => part.startsWith('.')) || (re && !re.test(String(name)))) return;
          pending.add(`${root}/${name}`);
          clearTimeout(timer);
          timer = setTimeout(() => {
            const files = [...pending];
            pending = new Set();
            fire(t, files);
          }, t.debounceMs ?? 2000);
        });
        this.watchers.push(w);
      } catch {
        // missing folder: skip this trigger
      }
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
  }
}
