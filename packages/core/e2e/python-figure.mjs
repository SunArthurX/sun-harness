// Run after pnpm build with a Python interpreter that has Matplotlib installed.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PythonKernel } from '../dist/index.js';

const workspace = await mkdtemp(join(tmpdir(), 'sun-python-figure-'));
const kernel = new PythonKernel(workspace);
try {
  const result = await kernel.run('import matplotlib\nimport matplotlib.pyplot as plt\nprint(matplotlib.__version__)\nplt.plot([0,1,2], [0,1,4])');
  assert.equal(result.error, null, result.error ?? result.stderr);
  assert.deepEqual(result.figures, ['figures/fig-1.png']);
  const png = await readFile(join(workspace, result.figures[0]));
  assert.ok(png.length > 1024);
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  console.log(`PythonKernel rendered a ${png.length}-byte PNG with real Matplotlib ${result.stdout.trim()}.`);
} finally {
  kernel.dispose();
  await rm(workspace, { recursive: true, force: true });
}
