import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExecSandbox } from '../sandbox.js';

/** A tiny Jupyter-like kernel: JSON lines in, JSON lines out; state persists; the last expression is echoed; figures are saved. */
const KERNEL = String.raw`
import ast, contextlib, io, json, os, sys, traceback
G = {"__name__": "__main__"}
FIG_DIR = os.environ.get("SUN_FIG_DIR", "figures")
fig_n = [0]
def save_figures():
    out = []
    plt = sys.modules.get("matplotlib.pyplot")
    if not plt:
        return out
    for num in plt.get_fignums():
        os.makedirs(FIG_DIR, exist_ok=True)
        fig_n[0] += 1
        path = os.path.join(FIG_DIR, "fig-%d.png" % fig_n[0])
        plt.figure(num).savefig(path, dpi=110, bbox_inches="tight")
        out.append(path)
    plt.close("all")
    return out
for line in sys.stdin:
    req = json.loads(line)
    out, err = io.StringIO(), io.StringIO()
    res = {"id": req["id"], "result": None, "error": None}
    try:
        tree = ast.parse(req["code"], "<cell>", "exec")
        last = tree.body.pop() if tree.body and isinstance(tree.body[-1], ast.Expr) else None
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exec(compile(tree, "<cell>", "exec"), G)
            if last is not None:
                v = eval(compile(ast.Expression(last.value), "<cell>", "eval"), G)
                if v is not None:
                    res["result"] = repr(v)[:20000]
    except BaseException:
        res["error"] = traceback.format_exc(limit=6)
    res["stdout"], res["stderr"] = out.getvalue()[-40000:], err.getvalue()[-10000:]
    try:
        res["figures"] = save_figures()
    except Exception as e:
        res["figures"] = []
        res["stderr"] += "\n(figure save failed: %s)" % e
    sys.stdout.write(json.dumps(res) + "\n")
    sys.stdout.flush()
`;

function kernelFile(): string {
  const f = join(tmpdir(), `sun-kernel-${createHash('sha1').update(KERNEL).digest('hex').slice(0, 10)}.py`);
  if (!existsSync(f)) writeFileSync(f, KERNEL);
  return f;
}

export interface CellResult {
  stdout: string;
  stderr: string;
  result: string | null;
  error: string | null;
  figures: string[];
}

/** One persistent Python process per session, started inside the session's shell sandbox. */
export class PythonKernel {
  private proc?: ChildProcessWithoutNullStreams;
  private buf = '';
  private nextId = 1;
  private waiting = new Map<number, (r: CellResult) => void>();

  constructor(
    private readonly cwd: string,
    private readonly sandbox?: ExecSandbox,
  ) {}

  private start(): ChildProcessWithoutNullStreams {
    const cmd = `python3 -u ${JSON.stringify(kernelFile())}`;
    const shell = this.sandbox ? this.sandbox.shell(cmd, this.cwd) : cmd;
    const env = { ...(this.sandbox ? this.sandbox.env(process.env) : process.env), MPLBACKEND: 'Agg', PYTHONUNBUFFERED: '1', SUN_FIG_DIR: 'figures' };
    const p = spawn('bash', ['-c', shell], { cwd: this.cwd, env });
    p.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        try {
          const r = JSON.parse(line);
          this.waiting.get(r.id)?.(r);
          this.waiting.delete(r.id);
        } catch {
          // a stray line from a C extension; ignore
        }
      }
    });
    let errTail = '';
    p.stderr.on('data', (d: Buffer) => (errTail = (errTail + d.toString()).slice(-4000)));
    p.on('exit', () => {
      // A process replaced by restart() must not fail the calls of its successor.
      if (this.proc && this.proc !== p) return;
      for (const w of this.waiting.values()) w({ stdout: '', stderr: errTail, result: null, error: 'The Python kernel exited (state was lost).', figures: [] });
      this.waiting.clear();
      this.proc = undefined;
    });
    this.proc = p;
    return p;
  }

  run(code: string, timeoutMs = 120_000, signal?: AbortSignal): Promise<CellResult> {
    const p = this.proc ?? this.start();
    const id = this.nextId++;
    return new Promise((resolve) => {
      const onAbort = () => {
        this.restart();
        done({ stdout: '', stderr: '', result: null, error: 'Aborted; the kernel was restarted.', figures: [] });
      };
      const done = (r: CellResult) => {
        clearTimeout(t);
        signal?.removeEventListener('abort', onAbort);
        resolve(r);
      };
      const t = setTimeout(() => {
        this.restart();
        done({ stdout: '', stderr: '', result: null, error: `Timed out after ${Math.round(timeoutMs / 1000)} s; the kernel was restarted (state was lost).`, figures: [] });
      }, timeoutMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.set(id, done);
      p.stdin.write(JSON.stringify({ id, code }) + '\n');
    });
  }

  restart(): void {
    this.proc?.kill('SIGKILL');
    this.proc = undefined;
  }

  dispose(): void {
    this.restart();
  }
}

export function formatCell(r: CellResult): string {
  const parts: string[] = [];
  if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
  if (r.result !== null) parts.push(`Out: ${r.result}`);
  if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
  if (r.error) parts.push(`[error]\n${r.error.trimEnd()}`);
  if (r.figures.length) parts.push(`[figures saved] ${r.figures.join(', ')}`);
  return parts.join('\n') || '(no output)';
}
