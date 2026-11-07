import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface LspServerSpec {
  /** File extensions this server handles, e.g. [".ts", ".tsx"]. */
  extensions: string[];
  command: string;
  args: string[];
  /** LSP languageId per extension (default: derived from the extension). */
  languageIds?: Record<string, string>;
  /** Files that mark the project root for this server (nearest ancestor wins). */
  rootMarkers: string[];
}

export interface LspConfig {
  enabled: boolean;
  /** Milliseconds to wait for diagnostics after an edit. */
  timeoutMs: number;
  servers: Record<string, LspServerSpec>;
}

export const DEFAULT_LSP: LspConfig = {
  enabled: true,
  timeoutMs: 8000,
  servers: {
    typescript: {
      extensions: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'],
      command: 'typescript-language-server',
      args: ['--stdio'],
      languageIds: { '.ts': 'typescript', '.mts': 'typescript', '.cts': 'typescript', '.tsx': 'typescriptreact', '.jsx': 'javascriptreact' },
      rootMarkers: ['tsconfig.json', 'jsconfig.json', 'package.json'],
    },
    python: { extensions: ['.py'], command: 'pyright-langserver', args: ['--stdio'], rootMarkers: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
    go: { extensions: ['.go'], command: 'gopls', args: [], rootMarkers: ['go.mod'] },
    rust: { extensions: ['.rs'], command: 'rust-analyzer', args: [], rootMarkers: ['Cargo.toml'] },
  },
};

export interface LspDiagnostic {
  line: number;
  severity: number;
  message: string;
  code?: string | number;
  source?: string;
}

const has = (cmd: string) => spawnSync('which', [cmd]).status === 0;

/** tsserver for typescript-language-server: the project's TypeScript if it ships one (TS ≤ 6), else a global one. */
function tsserverPath(root: string): string | undefined {
  const local = join(root, 'node_modules', 'typescript', 'lib', 'tsserver.js');
  if (existsSync(local)) return local;
  const g = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }).stdout?.trim();
  const global = g ? join(g, 'typescript', 'lib', 'tsserver.js') : '';
  return global && existsSync(global) ? global : undefined;
}

function findRoot(file: string, markers: string[], fallback: string): string {
  let dir = dirname(resolve(file));
  for (;;) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    const up = dirname(dir);
    if (up === dir) return fallback;
    dir = up;
  }
}

/** A minimal LSP client: JSON-RPC 2.0 over stdio with Content-Length framing; full-text document sync. */
export class LspClient {
  private proc: ChildProcessWithoutNullStreams;
  private buf = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<number, (r: { result?: unknown; error?: { message: string } }) => void>();
  private versions = new Map<string, number>();
  private diags = new Map<string, { at: number; items: LspDiagnostic[] }>();
  private waiters = new Set<() => void>();
  readonly ready: Promise<void>;
  dead = false;

  constructor(
    readonly spec: LspServerSpec,
    readonly root: string,
    initializationOptions: Record<string, unknown> = {},
  ) {
    this.proc = spawn(spec.command, spec.args, { cwd: root, env: process.env });
    this.proc.on('exit', () => {
      this.dead = true;
      for (const p of this.pending.values()) p({ error: { message: 'language server exited' } });
      this.pending.clear();
    });
    this.proc.on('error', () => (this.dead = true));
    this.proc.stderr.on('data', () => undefined);
    this.proc.stdout.on('data', (d: Buffer) => this.onData(d));
    const rootUri = pathToFileURL(root).toString();
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri,
      workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
      capabilities: { textDocument: { publishDiagnostics: { relatedInformation: false }, synchronization: { didSave: true } }, workspace: { workspaceFolders: true } },
      initializationOptions,
    }).then(() => this.notify('initialized', {}));
  }

  private write(msg: object): void {
    if (this.dead) return;
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...msg }), 'utf8');
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
  }

  request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolveP, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, (r) => {
        clearTimeout(t);
        if (r.error) reject(new Error(r.error.message));
        else resolveP(r.result);
      });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const len = Number(/Content-Length: (\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))?.[1]);
      if (!Number.isFinite(len) || this.buf.length < sep + 4 + len) return;
      const raw = this.buf.subarray(sep + 4, sep + 4 + len).toString('utf8');
      this.buf = this.buf.subarray(sep + 4 + len);
      let msg: any;
      try {
        msg = JSON.parse(raw);
      } catch {
        continue;
      }
      if (msg.id !== undefined && msg.method === undefined) this.pending.get(msg.id)?.(msg);
      else if (msg.id !== undefined && msg.method) {
        // Server-to-client requests (configuration, capability registration): answer so the server does not stall.
        this.write({ id: msg.id, result: msg.method === 'workspace/configuration' ? (msg.params?.items ?? []).map(() => null) : null });
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        const items: LspDiagnostic[] = (msg.params.diagnostics ?? []).map((x: any) => ({ line: x.range.start.line + 1, severity: x.severity ?? 1, message: String(x.message), code: x.code, source: x.source }));
        this.diags.set(msg.params.uri, { at: Date.now(), items });
        for (const w of this.waiters) w();
      }
    }
  }

  /** Send the file's current text and collect diagnostics until the server has been quiet for a moment. */
  async diagnostics(file: string, languageId: string, timeoutMs: number): Promise<LspDiagnostic[] | undefined> {
    await this.ready;
    if (this.dead) return undefined;
    const uri = pathToFileURL(resolve(file)).toString();
    const text = readFileSync(file, 'utf8');
    const v = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, v);
    const sent = Date.now();
    this.diags.delete(uri);
    if (v === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: v, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version: v }, contentChanges: [{ text }] });
    this.notify('textDocument/didSave', { textDocument: { uri } });
    // Servers often publish twice (syntax first, semantics later): settle 600 ms after the latest publish.
    return new Promise((resolveP) => {
      const deadline = setTimeout(() => finish(), timeoutMs);
      let quiet: NodeJS.Timeout | undefined;
      const onPublish = () => {
        const d = this.diags.get(uri);
        if (!d || d.at < sent) return;
        clearTimeout(quiet);
        quiet = setTimeout(finish, 600);
      };
      const finish = () => {
        clearTimeout(deadline);
        clearTimeout(quiet);
        this.waiters.delete(onPublish);
        resolveP(this.diags.get(uri)?.items);
      };
      this.waiters.add(onPublish);
    });
  }

  dispose(): void {
    if (this.dead) return;
    this.request('shutdown', null, 2000)
      .catch(() => undefined)
      .finally(() => {
        this.notify('exit', null);
        setTimeout(() => this.proc.kill(), 500).unref();
      });
  }
}

const clients = new Map<string, LspClient>();
const missing = new Set<string>();

/** Diagnostics from the language server responsible for `file`, or undefined when none is configured or installed. */
export async function lspDiagnostics(file: string, cfg: LspConfig, fallbackRoot: string): Promise<LspDiagnostic[] | undefined> {
  if (!cfg.enabled) return undefined;
  const ext = extname(file);
  const entry = Object.entries(cfg.servers).find(([, s]) => s.extensions.includes(ext));
  if (!entry) return undefined;
  const [name, spec] = entry;
  if (missing.has(spec.command)) return undefined;
  if (!has(spec.command)) {
    missing.add(spec.command);
    return undefined;
  }
  const root = findRoot(file, spec.rootMarkers, fallbackRoot);
  const key = `${name}:${root}`;
  let c = clients.get(key);
  if (!c || c.dead) {
    const init: Record<string, unknown> = {};
    if (name === 'typescript') {
      const tsserver = tsserverPath(root);
      if (!tsserver) return undefined;
      init.tsserver = { path: tsserver };
    }
    c = new LspClient(spec, root, init);
    clients.set(key, c);
  }
  const languageId = spec.languageIds?.[ext] ?? (ext === '.py' ? 'python' : ext === '.go' ? 'go' : ext === '.rs' ? 'rust' : 'javascript');
  try {
    return await c.diagnostics(file, languageId, cfg.timeoutMs);
  } catch {
    return undefined;
  }
}

export function disposeLspClients(): void {
  for (const c of clients.values()) c.dispose();
  clients.clear();
}
