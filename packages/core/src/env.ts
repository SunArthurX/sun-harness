import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { homePath } from './paths.js';

export const CREDENTIAL_NAME = /(_API_KEY|_API_BASE|_BASE_URL|_TOKEN|_MODEL)$/;
export const RC_FILES = ['.zshenv', '.zprofile', '.zshrc', '.bash_profile', '.bashrc', '.profile'];

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

/** nvm's default Node bin dir (alias like "24" or "v24.15.0" resolved to the newest matching install). */
function nvmBin(): string | undefined {
  const nvm = process.env.NVM_DIR || join(homedir(), '.nvm');
  const versions = join(nvm, 'versions', 'node');
  if (!existsSync(versions)) return undefined;
  const installed = readdirSync(versions).filter((v) => v.startsWith('v'));
  let alias = '';
  try {
    alias = readFileSync(join(nvm, 'alias', 'default'), 'utf8').trim().replace(/^v/, '');
  } catch {
    // no default alias
  }
  const byVersion = (a: string, b: string) => b.localeCompare(a, undefined, { numeric: true });
  const pick = installed.filter((v) => !alias || v.slice(1) === alias || v.slice(1).startsWith(`${alias}.`)).sort(byVersion)[0] ?? installed.sort(byVersion)[0];
  return pick ? join(versions, pick, 'bin') : undefined;
}

/**
 * GUI apps and launchd jobs get a minimal PATH (/usr/bin:/bin:…). Append the usual user tool locations
 * so the bash tool and MCP servers (npx, node, pnpm, uvx) work. Existing entries keep priority.
 */
export function augmentPath(): string[] {
  const home = homedir();
  const candidates = [
    dirname(process.execPath),
    nvmBin(),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, 'go', 'bin'),
  ].filter((d): d is string => !!d && existsSync(d));
  const current = (process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
  const added = [...new Set(candidates)].filter((d) => !current.includes(d) && !/Electron\.app|sun-harness\.app/.test(d));
  process.env.PATH = [...current, ...added].join(':');
  return added;
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
