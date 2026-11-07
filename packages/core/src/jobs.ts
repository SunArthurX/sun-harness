import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { ensureDir, homePath } from './paths.js';

export type JobState = 'running' | 'done' | 'failed' | 'killed';

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
}

export interface JobResult {
  job: Job;
  /** Last part of the output, for delivery into the session. */
  tail: string;
}

const TAIL_CHARS = 6000;

/**
 * Background jobs: shell commands and promoted (slow) tool calls that keep running while the agent continues.
 * Output goes to ~/.sun/jobs/<id>.log; completion is reported through onFinish (the host delivers it to the session).
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private procs = new Map<string, ChildProcess>();

  constructor(
    private readonly onStart: (job: Job) => void,
    private readonly onFinish: (r: JobResult) => void,
  ) {}

  private newJob(sessionId: string, name: string, command: string): Job {
    const id = `job-${randomUUID().slice(0, 6)}`;
    const logFile = homePath('jobs', `${id}.log`);
    ensureDir(homePath('jobs'));
    writeFileSync(logFile, '');
    const job: Job = { id, sessionId, name, command, state: 'running', startedAt: new Date().toISOString(), logFile };
    this.jobs.set(id, job);
    this.onStart({ ...job });
    return job;
  }

  private finish(job: Job, state: JobState, exitCode?: number): void {
    if (job.state !== 'running') return;
    job.state = state;
    job.exitCode = exitCode;
    job.endedAt = new Date().toISOString();
    this.procs.delete(job.id);
    this.onFinish({ job: { ...job }, tail: this.tail(job.id) });
  }

  /** Start a shell command in the background (bash -c), in cwd. */
  startProcess(sessionId: string, command: string, cwd: string, name = 'bash'): Job {
    const job = this.newJob(sessionId, name, command);
    const child = spawn('bash', ['-c', command], { cwd, env: { ...process.env, PAGER: 'cat' } });
    this.procs.set(job.id, child);
    const write = (d: Buffer) => appendFileSync(job.logFile, d);
    child.stdout?.on('data', write);
    child.stderr?.on('data', write);
    child.on('close', (code, sig) => this.finish(job, job.state === 'running' && sig ? 'killed' : code === 0 ? 'done' : 'failed', code ?? undefined));
    child.on('error', (e) => {
      appendFileSync(job.logFile, `\nFailed to start: ${e.message}\n`);
      this.finish(job, 'failed');
    });
    return job;
  }

  /**
   * Run a tool call; if it has not finished after `afterMs`, promote it to a background job and resolve with a notice.
   * The original promise keeps running; its result is delivered later through onFinish.
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
    const proc = this.procs.get(id);
    if (!j || j.state !== 'running') return false;
    if (proc) {
      proc.kill('SIGTERM');
      setTimeout(() => proc.exitCode === null && proc.kill('SIGKILL'), 3000).unref();
      // Mark now so the close handler reports "killed".
      this.finish(j, 'killed');
      return true;
    }
    // Promoted tool calls cannot be interrupted; stop waiting for them.
    this.finish(j, 'killed');
    return true;
  }

  killAll(): void {
    for (const id of this.procs.keys()) this.kill(id);
  }
}
