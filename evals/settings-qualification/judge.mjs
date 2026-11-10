import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runIsolatedTests } from './sandbox.mjs';

const taskDir = process.argv[2];
const base = process.env.EVAL_BASE;
if (!taskDir || !base) throw new Error('Missing trusted task directory or base revision.');
const allowed = new Set(JSON.parse(readFileSync(join(taskDir, 'allow.json'), 'utf8')));
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(Boolean);
const hidden = new Set(readdirSync(join(taskDir, 'hidden')).map(file => `.eval-hidden/${file}`));
const changed = new Set([...git('diff', '--name-only', '-z', base, '--'), ...git('ls-files', '--others', '-z')]);
for (const file of changed) {
  if (hidden.has(file)) continue;
  if (!allowed.has(file) || !lstatSync(file).isFile()) throw new Error(`Change outside allowed fixture files: ${file}`);
}
const files = ['test/visible.test.mjs', ...hidden];
if (existsSync('test/additions.test.mjs')) files.push('test/additions.test.mjs');
const result = runIsolatedTests(process.cwd(), files);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
