import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';

type TsModule = {
  transpileModule(src: string, o: { fileName: string; reportDiagnostics: boolean; compilerOptions: Record<string, unknown> }): {
    diagnostics?: { start?: number; messageText: string | { messageText: string } }[];
  };
};

const tsCache = new Map<string, TsModule | null>();

function projectTypescript(cwd: string): TsModule | null {
  if (tsCache.has(cwd)) return tsCache.get(cwd)!;
  let ts: TsModule | null = null;
  try {
    ts = createRequire(join(cwd, 'package.json'))('typescript') as TsModule;
  } catch {
    ts = null;
  }
  tsCache.set(cwd, ts);
  return ts;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/**
 * Fast, per-file syntax diagnostics run right after an edit, so the model sees a broken file in the same
 * tool result instead of several steps later. Type and test errors are the verify gate's job.
 */
export function syntaxDiagnostics(cwd: string, file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  const ext = extname(file);
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 10_000 });
    if (r.error || r.status === 0) return undefined;
    // Python tracebacks end with the error; Node prints the location first.
    const lines = (r.stderr || r.stdout).trim().split('\n');
    return (cmd === 'python3' ? lines.slice(-6) : lines.slice(0, 8)).join('\n');
  };
  if (['.js', '.mjs', '.cjs'].includes(ext)) return run(process.execPath, ['--check', file]);
  if (ext === '.py') return run('python3', ['-c', 'import ast,sys; ast.parse(open(sys.argv[1]).read(), sys.argv[1])', file]);
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(file, 'utf8'));
      return undefined;
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.jsx'].includes(ext)) {
    const ts = projectTypescript(cwd);
    if (!ts) return undefined;
    const src = readFileSync(file, 'utf8');
    const out = ts.transpileModule(src, { fileName: file, reportDiagnostics: true, compilerOptions: { jsx: 'preserve' } });
    const diags = (out.diagnostics ?? []).slice(0, 8).map((d) => {
      const msg = typeof d.messageText === 'string' ? d.messageText : d.messageText.messageText;
      return `line ${d.start !== undefined ? lineOf(src, d.start) : '?'}: ${msg}`;
    });
    return diags.length ? diags.join('\n') : undefined;
  }
  return undefined;
}

/** Text appended to an edit tool result when the edited files no longer parse. */
export function diagnosticsNote(cwd: string, files: string[]): string {
  const parts: string[] = [];
  for (const f of files) {
    const d = syntaxDiagnostics(cwd, f);
    if (d) parts.push(`${f}:\n${d}`);
  }
  return parts.length ? `\n\nWARNING: syntax errors after this edit — fix them before continuing:\n${parts.join('\n')}` : '';
}
