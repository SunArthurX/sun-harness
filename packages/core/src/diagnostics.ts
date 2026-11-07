import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { lspDiagnostics, type LspConfig } from './lsp.js';

type TsModule = {
  /** Missing in TypeScript 7 (native), which has no JavaScript API. */
  transpileModule?(src: string, o: { fileName: string; reportDiagnostics: boolean; compilerOptions: Record<string, unknown> }): {
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
  // TypeScript 7 (native) has no JavaScript API; a global TypeScript ≤ 6 can still check the project.
  if (!ts?.transpileModule) ts = globalTypescript();
  tsCache.set(cwd, ts);
  return ts;
}

interface Lsp {
  service: any;
  files: Set<string>;
}

const services = new Map<string, Lsp | null>();

/**
 * Type diagnostics through the project's own TypeScript language service (what TS language servers run), one cached
 * service per tsconfig; script versions follow file mtimes, so later edits are picked up incrementally.
 */
export function typeDiagnostics(cwd: string, file: string): string[] | undefined {
  const ts: any = projectTypescript(cwd);
  if (!ts?.createLanguageService) return undefined;
  const config = ts.findConfigFile(dirname(file), ts.sys.fileExists, 'tsconfig.json');
  if (!config) return undefined;
  let lsp = services.get(config);
  if (lsp === undefined) {
    try {
      const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(config, ts.sys.readFile).config, ts.sys, dirname(config));
      if (parsed.fileNames.length > 3000) lsp = null;
      else {
        const files = new Set<string>(parsed.fileNames.map((f: string) => resolve(f)));
        const host = {
          getScriptFileNames: () => [...files],
          getScriptVersion: (f: string) => {
            try {
              return String(statSync(f).mtimeMs);
            } catch {
              return '0';
            }
          },
          getScriptSnapshot: (f: string) => (existsSync(f) ? ts.ScriptSnapshot.fromString(readFileSync(f, 'utf8')) : undefined),
          getCurrentDirectory: () => dirname(config),
          getCompilationSettings: () => parsed.options,
          getDefaultLibFileName: (o: unknown) => ts.getDefaultLibFilePath(o),
          fileExists: ts.sys.fileExists,
          readFile: ts.sys.readFile,
          readDirectory: ts.sys.readDirectory,
          directoryExists: ts.sys.directoryExists,
          getDirectories: ts.sys.getDirectories,
        };
        lsp = { service: ts.createLanguageService(host, ts.createDocumentRegistry()), files };
      }
    } catch {
      lsp = null;
    }
    services.set(config, lsp);
  }
  if (!lsp) return undefined;
  const abs = resolve(file);
  lsp.files.add(abs);
  try {
    const diags = [...lsp.service.getSyntacticDiagnostics(abs), ...lsp.service.getSemanticDiagnostics(abs)];
    return diags.slice(0, 8).map((d: any) => {
      const line = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : '?';
      return `line ${line}: TS${d.code} ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
    });
  } catch {
    return undefined;
  }
}

let globalTs: TsModule | null | undefined;
function globalTypescript(): TsModule | null {
  if (globalTs !== undefined) return globalTs;
  globalTs = null;
  const root = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  if (root && existsSync(join(root, 'typescript', 'package.json'))) {
    try {
      const t = createRequire(join(root, 'noop.js'))('typescript') as TsModule;
      if (t.transpileModule) globalTs = t;
    } catch {
      globalTs = null;
    }
  }
  return globalTs;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length;
}

/**
 * Per-file diagnostics run right after an edit, so the model sees a broken file in the same tool result instead of
 * several steps later: TypeScript syntax + types through the language service when the project has a tsconfig, syntax
 * checks otherwise. Test failures are the verify gate's job.
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
  if (['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
    const typed = typeDiagnostics(cwd, file);
    if (typed) return typed.length ? typed.join('\n') : undefined;
  }
  if (['.ts', '.tsx', '.mts', '.cts', '.jsx'].includes(ext)) {
    const ts = projectTypescript(cwd);
    if (!ts?.transpileModule) return undefined;
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

/** Text appended to an edit tool result when the edited files have errors: language server first, then local checks. */
export async function diagnosticsNote(cwd: string, files: string[], lsp?: LspConfig): Promise<string> {
  const parts: string[] = [];
  for (const f of files) {
    const fromServer = lsp && existsSync(f) ? await lspDiagnostics(f, lsp, cwd) : undefined;
    const d = fromServer
      ? fromServer
          .filter((x) => x.severity === 1)
          .slice(0, 8)
          .map((x) => `line ${x.line}: ${x.code !== undefined ? `${x.source ?? ''}${x.code} ` : ''}${x.message.split('\n')[0]}`)
          .join('\n') || undefined
      : syntaxDiagnostics(cwd, f);
    if (d) parts.push(`${f}:\n${d}`);
  }
  return parts.length ? `\n\nWARNING: errors after this edit (syntax or types) — fix them before continuing:\n${parts.join('\n')}` : '';
}
