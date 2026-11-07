import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const has = (cmd: string) => spawnSync('which', [cmd]).status === 0;

function walkFor(dir: string, test: (name: string) => boolean, depth = 3): boolean {
  if (depth < 0 || !existsSync(dir)) return false;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    if (e.isFile() && test(e.name)) return true;
    if (e.isDirectory() && walkFor(join(dir, e.name), test, depth - 1)) return true;
  }
  return false;
}

/**
 * The commands that prove a change works in this project.
 * `.sun/project.json` {"verify": [...]} wins; otherwise detect from the project's own conventions.
 */
export function detectVerifyCommands(cwd: string): string[] {
  const project = join(cwd, '.sun', 'project.json');
  if (existsSync(project)) {
    try {
      const v = JSON.parse(readFileSync(project, 'utf8')).verify;
      if (Array.isArray(v)) return v.map(String);
    } catch {
      // fall through to detection
    }
  }
  const cmds: string[] = [];
  const pkgFile = join(cwd, 'package.json');
  let scripts: Record<string, string> = {};
  if (existsSync(pkgFile)) {
    try {
      scripts = JSON.parse(readFileSync(pkgFile, 'utf8')).scripts ?? {};
    } catch {
      scripts = {};
    }
  }
  const runner = existsSync(join(cwd, 'pnpm-lock.yaml')) ? 'pnpm' : existsSync(join(cwd, 'yarn.lock')) ? 'yarn' : 'npm';
  if (scripts.typecheck) cmds.push(`${runner} run -s typecheck`);
  else if (existsSync(join(cwd, 'tsconfig.json')) && has('tsc')) cmds.push('tsc --noEmit -p .');
  if (scripts.test && !/no test specified/.test(scripts.test)) cmds.push(`${runner} ${runner === 'npm' ? 'test --silent' : 'test'}`);
  else if (walkFor(cwd, (n) => /\.test\.(m?js|cjs|ts|mts)$/.test(n))) cmds.push("node --test");
  const pyTests = walkFor(cwd, (n) => /^test_.*\.py$|_test\.py$/.test(n));
  if (pyTests) cmds.push(has('pytest') ? 'python3 -m pytest -q' : existsSync(join(cwd, 'tests')) ? 'python3 -m unittest discover -s tests -q' : 'python3 -m unittest discover -q');
  if (existsSync(join(cwd, 'Cargo.toml'))) cmds.push('cargo test -q');
  if (existsSync(join(cwd, 'go.mod'))) cmds.push('go test ./...');
  return cmds;
}

export interface VerifyOutcome {
  passed: boolean;
  results: { command: string; code: number | null; output: string }[];
}

/** Run verify commands in order; stop at the first failure. Output is tail-truncated. */
export async function runVerify(cwd: string, commands: string[], timeoutMs = 300_000, signal?: AbortSignal): Promise<VerifyOutcome> {
  const results: VerifyOutcome['results'] = [];
  for (const command of commands) {
    const r = await new Promise<{ code: number | null; output: string }>((resolve) => {
      const child = spawn('bash', ['-c', command], { cwd, env: { ...process.env, CI: '1', PAGER: 'cat' } });
      let out = '';
      const add = (d: Buffer) => (out = (out + d.toString()).slice(-200_000));
      child.stdout.on('data', add);
      child.stderr.on('data', add);
      const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        resolve({ code, output: out.slice(-6000) });
      });
      child.on('error', (e) => resolve({ code: 127, output: e.message }));
    });
    results.push({ command, ...r });
    if (r.code !== 0) return { passed: false, results };
  }
  return { passed: true, results };
}
