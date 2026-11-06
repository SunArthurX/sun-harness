import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { homePath } from './paths.js';

const CREDENTIAL_NAME = /(_API_KEY|_API_BASE|_BASE_URL|_TOKEN|_MODEL)$/;
const RC_FILES = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile'];

/** Parse `export NAME=value` / `NAME=value` lines. Lines needing evaluation ($(...), backticks, $VAR) are skipped. */
export function parseEnvLines(text: string, accept: (name: string) => boolean = () => true): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m || !accept(m[1])) continue;
    let v = m[2].trim();
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (/\$\(|`|\$[A-Za-z{]/.test(v)) continue;
    out[m[1]] = v;
  }
  return out;
}

/**
 * Fill missing credential env vars without running a shell: from ~/.sun/.env first, then shell rc files.
 * GUI apps and launchd jobs do not inherit the login shell, and sourcing an interactive rc can hang (e.g. conda hooks).
 */
export function importCredentialEnv(): string[] {
  const imported: string[] = [];
  const apply = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined && v) {
        process.env[k] = v;
        imported.push(k);
      }
    }
  };
  const dotenv = homePath('.env');
  if (existsSync(dotenv)) apply(parseEnvLines(readFileSync(dotenv, 'utf8')));
  for (const f of RC_FILES) {
    const p = join(homedir(), f);
    if (existsSync(p)) apply(parseEnvLines(readFileSync(p, 'utf8'), (n) => CREDENTIAL_NAME.test(n)));
  }
  return imported;
}
