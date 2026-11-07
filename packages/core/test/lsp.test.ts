import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_LSP, diagnosticsNote, disposeLspClients, lspDiagnostics } from '../src/index.js';

const hasServer = spawnSync('which', ['typescript-language-server']).status === 0;

describe.runIf(hasServer)('LSP diagnostics (typescript-language-server)', () => {
  afterAll(() => disposeLspClients());

  it('reports type errors after an edit and clears them after the fix', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'sun-lsp-'));
    writeFileSync(join(ws, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler' }, include: ['*.ts'] }));
    writeFileSync(join(ws, 'lib.ts'), 'export function twice(n: number): number {\n  return n * 2;\n}\n');
    writeFileSync(join(ws, 'main.ts'), "import { twice } from './lib';\nconst s: string = twice(2);\nexport { s };\n");
    const d = await lspDiagnostics(join(ws, 'main.ts'), DEFAULT_LSP, ws);
    expect(d?.some((x) => x.line === 2 && String(x.code) === '2322')).toBe(true);
    const note = await diagnosticsNote(ws, [join(ws, 'main.ts')], DEFAULT_LSP);
    expect(note).toMatch(/WARNING: errors after this edit[\s\S]*line 2: typescript2322 Type 'number' is not assignable to type 'string'/);
    writeFileSync(join(ws, 'main.ts'), "import { twice } from './lib';\nconst s: number = twice(2);\nexport { s };\n");
    expect((await lspDiagnostics(join(ws, 'main.ts'), DEFAULT_LSP, ws))?.filter((x) => x.severity === 1)).toEqual([]);
  }, 60_000);
});
