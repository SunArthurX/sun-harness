import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = '/Users/sunqingguang/Downloads/06.code/sun-harness/apps/desktop';
const require = createRequire(join(repo, 'package.json'));
const home = mkdtempSync(join(tmpdir(), 'sun-sigterm-'));
const child = spawn(require('electron'), [`--user-data-dir=${join(home, 'electron')}`, join(repo, 'out/main/index.js')], {
  env: { ...process.env, SUN_HOME: home, SUN_NO_GATEWAY: '1', SUN_SKIP_SHELL_ENV: '1' }, stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 5000));
const t = Date.now();
child.kill('SIGTERM');
const exited = await Promise.race([new Promise((r) => child.once('exit', () => r(true))), new Promise((r) => setTimeout(() => r(false), 10000))]);
console.log(exited ? `exited ${Date.now() - t} ms after one SIGTERM` : 'still running 10 s after one SIGTERM');
if (!exited) child.kill('SIGKILL');
