import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { HookEntry } from './hook-config.js';
import type { ExecSandbox } from './sandbox.js';

export type HookRunState = 'completed' | 'timed-out' | 'cancelled' | 'output-limit' | 'input-limit' | 'spawn-failed' | 'sandbox-error' | 'cleanup-failed';

export interface HookRunResult {
  code: number;
  stdout: string;
  stderr: string;
  state: HookRunState;
  durationMs: number;
}

export interface HookRunOptions {
  signal?: AbortSignal;
  sandbox?: ExecSandbox;
  redact?: (text: string) => string;
  scrub?: readonly string[];
}

const MAX_OUTPUT = 64 * 1024;
const MAX_INPUT = 256 * 1024;
const safeEnvironment = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
  'TERM', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'CI',
]);

function killGroup(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 1000 });
    child.kill('SIGKILL');
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

function limitText(text: string, size: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= size) return text;
  return new TextDecoder().decode(bytes.subarray(0, size), { stream: true });
}

function failure(state: HookRunState, started: number, code: number, stderr = ''): HookRunResult {
  return { state, code, stdout: '', stderr, durationMs: Date.now() - started };
}

/** Only callers that checked hook trust may invoke this low-level process runner. */
export async function runHook(entry: HookEntry, payload: unknown, cwd: string, options: HookRunOptions = {}): Promise<HookRunResult> {
  const started = Date.now();
  const signal = options.signal;
  const redact = options.redact ?? ((text: string) => text);
  if (signal?.aborted) return failure('cancelled', started, 130);
  const input = JSON.stringify(payload, (_key, value) => typeof value === 'string' ? redact(value) : value) ?? 'null';
  if (Buffer.byteLength(input) > MAX_INPUT) return failure('input-limit', started, 125, 'Hook input exceeds the limit.');
  const baseline = Object.fromEntries(Object.entries(process.env).filter(([key]) => safeEnvironment.has(key.toUpperCase())));
  baseline.SUN_HOOK = '1';
  let plan: { shell: string; cleanup?: (env: NodeJS.ProcessEnv) => Promise<boolean> };
  let env: NodeJS.ProcessEnv;
  try {
    plan = options.sandbox?.prepareHook?.(entry.command, cwd) ?? { shell: options.sandbox?.shell(entry.command, cwd) ?? entry.command };
    env = options.sandbox?.env(baseline) ?? baseline;
    const scrub = new Set(options.scrub?.map(name => name.toUpperCase()));
    for (const name of Object.keys(env)) if (scrub.has(name.toUpperCase())) delete env[name];
  } catch {
    return failure('sandbox-error', started, 126, 'Hook sandbox could not be prepared.');
  }
  if (signal?.aborted) return failure('cancelled', started, 130);

  let result: HookRunResult;
  try {
    result = await new Promise<HookRunResult>(resolve => {
      const child = spawn('bash', ['-c', plan.shell], { cwd, env, detached: process.platform !== 'win32', windowsHide: true });
      const streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
      let total = 0;
      let state: HookRunState = 'completed';
      let settled = false;
      let escapeTimer: NodeJS.Timeout | undefined;
      const finish = (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(escapeTimer);
        signal?.removeEventListener('abort', abort);
        const stdout = limitText(redact(Buffer.concat(streams.stdout).toString('utf8').trim()), MAX_OUTPUT);
        const stderr = limitText(redact(Buffer.concat(streams.stderr).toString('utf8').trim()), MAX_OUTPUT - Buffer.byteLength(stdout));
        const exit = state === 'timed-out' ? 124 : state === 'cancelled' ? 130 : state === 'output-limit' ? 125
          : state === 'spawn-failed' ? 127 : code ?? 1;
        resolve({ state, code: exit, stdout, stderr, durationMs: Date.now() - started });
      };
      const stop = (reason: HookRunState) => {
        if (state !== 'completed' || settled) return;
        state = reason;
        killGroup(child);
        // A process that closes or detaches its own pipes must not hold the caller indefinitely.
        escapeTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, 750);
      };
      const abort = () => stop('cancelled');
      const timer = setTimeout(() => stop('timed-out'), entry.timeoutMs ?? 30_000);
      const collect = (key: 'stdout' | 'stderr', data: Buffer) => {
        const room = MAX_OUTPUT - total;
        if (room) streams[key].push(data.subarray(0, room));
        total += Math.min(data.length, room);
        if (data.length > room) stop('output-limit');
      };
      child.stdout.on('data', data => collect('stdout', data));
      child.stderr.on('data', data => collect('stderr', data));
      child.on('close', code => {
        if (state === 'completed' && process.platform !== 'win32') killGroup(child);
        finish(code);
      });
      child.on('error', () => {
        if (state === 'completed') state = 'spawn-failed';
        finish(null);
      });
      child.stdin.on('error', () => undefined);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.end(input);
    });
  } catch {
    result = failure('spawn-failed', started, 127, 'Hook process could not be started.');
  }
  if (plan.cleanup && !await plan.cleanup(env)) return failure('cleanup-failed', started, 126, 'Hook sandbox cleanup could not be confirmed.');
  return result;
}
