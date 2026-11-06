// Bundle the CLI (core + all runtime deps) into one self-contained ESM file: packages/cli/dist/sun.mjs.
// The bundle can run from anywhere (e.g. ~/.sun/bin), which launchd needs: background jobs cannot read
// TCC-protected folders such as ~/Downloads without an interactive permission prompt.
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await build({
  entryPoints: [join(root, 'packages/cli/src/index.ts')],
  outfile: join(root, 'packages/cli/dist/sun.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
});
console.log('bundled packages/cli/dist/sun.mjs');
