import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDir, homePath } from './paths.js';

export type JobState = 'running' | 'done' | 'failed' | 'killed' | 'lost';

export interface Job {
  id: string;
  sessionId: string;
  name: string;
  /** Shell command for process jobs; tool name + args for promoted tool calls. */
  command: string;
  state: JobState;
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  logFile: string;
  /** Process jobs only: the detached wrapper's pid (also its process group id). */
  pid?: number;
  cwd?: string;
  /** Process jobs only: written by the wrapper with the command's exit status. */
  exitFile?: string;
  /** Set when this host took over a job started by an earlier process. */
  reattached?: boolean;
}

export interface JobResult {
  job: Job;
  /** Last part of the output, for delivery into the session. */
  tail: string;
}

const TAIL_CHARS = 6000;
const POLL_MS = 500;
// The wrapper's command line carries this marker so a recycled pid is never mistaken for our job.
const WRAPPER = 'bash -c "$SUN_JOB_CMD" >>"$SUN_JOB_LOG" 2>&1; echo $? >"$SUN_JOB_EXIT.tmp" && mv "$SUN_JOB_EXIT.tmp" "$SUN_JOB_EXIT"';

function metaFile(id: string): string {
  return homePath('jobs', `${id}.json`);
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
  return cmd.includes('SUN_JOB_EXIT');
}

/** Ids of process jobs recorded as running on disk (candidates for restore). */
export function restorableJobIds(): string[] {
  const dir = homePath('jobs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Job;
        return j.state === 'running' ? [j.id] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Background jobs: shell commands and promoted (slow) tool calls that keep running while the agent continues.
 * Process jobs run detached in their own process group and survive the host: metadata in ~/.sun/jobs/<id>.json,
 * output in <id>.log, exit status in <id>.exit. A later host re-attaches with restore() and delivers the result.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly onStart: (job: Job) => void,
    private readonly onFinish: (r: JobResult) => void,
  ) {}

  private persist(job: Job): void {
    if (job.pid) writeFileSync(metaFile(job.id), JSON.stringify(job, null, 2));
  }

  private newJob(sessionId: string, name: string, command: string, extra: Partial<Job> = {}): Job {
    const id = `job-${randomUUID().slice(0, 6)}`;
    const logFile = homePath('jobs', `${id}.log`);
    ensureDir(homePath('jobs'));
    writeFileSync(logFile, '');
    const job: Job = { id, sessionId, name, command, state: 'running', startedAt: new Date().toISOString(), logFile, ...extra };
    this.jobs.set(id, job);
    return job;
  }

  private finish(job: Job, state: JobState, exitCode?: number): void {
    if (job.state !== 'running') return;
    job.state = state;
    job.exitCode = exitCode;
    job.endedAt = new Date().toISOString();
    this.persist(job);
    this.onFinish({ job: { ...job }, tail: this.tail(job.id) });
    if (job.pid) {
      rmSync(metaFile(job.id), { force: true });
      if (job.exitFile) rmSync(job.exitFile, { force: true });
    }
  }

  /** Check running process jobs for an exit file (or a dead wrapper). */
  private poll(): void {
    let running = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || !job.pid) continue;
      running++;
      if (job.exitFile && existsSync(job.exitFile)) {
        const code = Number(readFileSync(job.exitFile, 'utf8').trim());
        this.finish(job, Number.isNaN(code) ? 'failed' : code === 0 ? 'done' : 'failed', Number.isNaN(code) ? undefined : code);
      } else if (!alive(job.pid)) {
        // Wrapper gone without writing an exit status: killed from outside, or the machine restarted.
        this.finish(job, 'lost');
      }
    }
    if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private watch(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.timer.unref();
    }
  }

  /** Start a shell command in the background (detached, survives this process), in cwd. */
  startProcess(sessionId: string, command: string, cwd: string, name = 'bash'): Job {
    const job = this.newJob(sessionId, name, command, { cwd });
    job.exitFile = homePath('jobs', `${job.id}.exit`);
    const child = spawn('bash', ['-c', WRAPPER], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PAGER: 'cat', SUN_JOB_CMD: command, SUN_JOB_LOG: job.logFile, SUN_JOB_EXIT: job.exitFile },
    });
    child.on('error', (e) => {
      appendFileSync(job.logFile, `\nFailed to start: ${e.message}\n`);
      this.finish(job, 'failed');
    });
    child.unref();
    job.pid = child.pid;
    this.persist(job);
    this.onStart({ ...job });
    this.watch();
    return job;
  }

  /**
   * Re-attach to process jobs started by an earlier host (after a restart or crash).
   * Finished jobs are delivered now; running ones are watched; vanished ones are reported lost.
   */
  restore(): Job[] {
    const dir = homePath('jobs');
    if (!existsSync(dir)) return [];
    const restored: Job[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      let job: Job;
      try {
        job = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
      } catch {
        continue;
      }
      if (job.state !== 'running' || this.jobs.has(job.id)) continue;
      job.reattached = true;
      this.jobs.set(job.id, job);
      restored.push({ ...job });
    }
    if (restored.length) {
      this.poll();
      this.watch();
    }
    return restored;
  }

  /**
   * Run a tool call; if it has not finished after `afterMs`, promote it to a background job and resolve with a notice.
   * The original promise keeps running in this process; its result is delivered later through onFinish.
   */
  async promoteIfSlow(sessionId: string, name: string, args: unknown, run: () => Promise<string>, afterMs: number): Promise<string> {
    if (!afterMs) return run();
    const p = run();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'slow'>((res) => (timer = setTimeout(() => res('slow'), afterMs)));
    const first = await Promise.race([p.then((v) => ({ v }), (e) => ({ e })), timeout]);
    clearTimeout(timer);
    if (first !== 'slow') {
      if ('e' in first) throw first.e;
      return first.v;
    }
    const job = this.newJob(sessionId, name, `${name} ${JSON.stringify(args).slice(0, 300)}`);
    this.onStart({ ...job });
    p.then(
      (out) => {
        appendFileSync(job.logFile, out);
        this.finish(job, 'done', 0);
      },
      (e) => {
        appendFileSync(job.logFile, `Error: ${(e as Error).message}`);
        this.finish(job, 'failed', 1);
      },
    );
    return `Still running after ${Math.round(afterMs / 1000)}s, so it moved to background job ${job.id}. Continue with other work; the result will be delivered to this session when it finishes (or check with job_status).`;
  }

  get(id: string): Job | undefined {
    const j = this.jobs.get(id);
    return j && { ...j };
  }

  list(sessionId?: string): Job[] {
    return [...this.jobs.values()].filter((j) => !sessionId || j.sessionId === sessionId).map((j) => ({ ...j }));
  }

  tail(id: string, chars = TAIL_CHARS): string {
    const j = this.jobs.get(id);
    if (!j) return '';
    try {
      const t = readFileSync(j.logFile, 'utf8');
      return t.length > chars ? `[…${t.length - chars} earlier chars in ${j.logFile}]\n${t.slice(-chars)}` : t;
    } catch {
      return '';
    }
  }

  kill(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== 'running') return false;
    if (j.pid) {
      const pid = j.pid;
      const signal = (sig: NodeJS.Signals) => {
        try {
          process.kill(-pid, sig);
        } catch {
          // already gone
        }
      };
      signal('SIGTERM');
      setTimeout(() => alive(pid) && signal('SIGKILL'), 3000).unref();
    }
    // Promoted tool calls cannot be interrupted; stop waiting for them.
    this.finish(j, 'killed');
    return true;
  }

  /** Kill every running process job (opt-in on shutdown; by default jobs outlive the host). */
  killAll(): void {
    for (const j of this.jobs.values()) if (j.state === 'running' && j.pid) this.kill(j.id);
  }

  /** Stop watching without touching the processes (they keep running and can be restored later). */
  detach(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
