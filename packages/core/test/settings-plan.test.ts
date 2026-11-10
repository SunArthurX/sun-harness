import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const cwd = fileURLToPath(new URL('../../../', import.meta.url));
describe('settings execution pack integrity', () => {
  it('validates coverage and task evidence offline', () => {
    const output = execFileSync(process.execPath, ['scripts/check-settings-plan.mjs'], { cwd, encoding: 'utf8' });
    expect(output).toContain('Plan integrity passed');
  });
  it('rejects plan drift using adversarial mutations', () => {
    execFileSync(process.execPath, ['--test', 'scripts/check-settings-plan.test.mjs'], { cwd, stdio: 'pipe' });
  });
});
