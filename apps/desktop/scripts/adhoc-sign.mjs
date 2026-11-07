// Ad-hoc sign the packaged app so it launches on Apple Silicon without a Developer ID.
// For distribution to other Macs, sign with a Developer ID and notarize instead.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const release = join(import.meta.dirname, '..', 'release');
const dirs = existsSync(release) ? readdirSync(release).filter((d) => d.startsWith('mac')) : [];
for (const d of dirs) {
  const app = join(release, d, 'sun-harness.app');
  if (!existsSync(app)) continue;
  const r = spawnSync('codesign', ['--force', '--deep', '--sign', '-', app], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  const v = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
  console.log(v.status === 0 ? `ad-hoc signed and verified ${app}` : `signed ${app} (verify: ${v.stderr.trim()})`);
}
