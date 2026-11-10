import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';

export function runIsolatedTests(cwd, files) {
  const workspace = realpathSync(cwd);
  const quote = value => JSON.stringify(value);
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    '(deny file-write*)',
    '(allow file-write* (literal "/dev/null") (regex #"^/dev/(fd/|stdout|stderr)"))',
    `(deny file-read-data (subpath ${quote(homedir())}) (subpath ${quote(realpathSync(tmpdir()))}))`,
    `(allow file-read-data (subpath ${quote(workspace)}))`,
  ].join('\n');
  if (process.platform !== 'darwin') throw new Error('This qualification judge requires macOS sandbox-exec.');
  return spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '--test', ...files], {
    cwd: workspace, encoding: 'utf8', timeout: 20_000, env: { PATH: '/usr/bin:/bin' },
  });
}
