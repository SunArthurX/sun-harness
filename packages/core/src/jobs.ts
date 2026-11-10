import { spawn, spawnSync } from 'node:child_process';
import { withStorageLock } from './settings/storage-lock.js';
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { transactSettingsFile } from './settings/store.js';
import { requireExecutionOperation, type ExecutionEnvironment, type ExecutionJobReceipt } from './settings/targets.js';
import { stopDockerExecution } from './sandbox.js';
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
  execution?: {
    operationId: string;
    hostId: string;
    requestDigest: string;
    environment: ExecutionEnvironment;
    dockerEndpoint?: string;
    containerStopVerifiedAt?: string;
    cancelRequestedAt?: string;
    cancelAcknowledgedAt?: string;
  };
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

const executionId = (operationId: string) => `job-exec-${operationId}`;
const marker = (job: Job) => job.execution ? `# sun-exec-${job.execution.operationId}` : 'SUN_JOB_EXIT';
const pidFile = (job: Job) => homePath('jobs', `${job.id}.pid`);
const cancelFile = (job: Job) => homePath('jobs', `${job.id}.cancel`);
const cancelledFile = (job: Job) => homePath('jobs', `${job.id}.cancelled`);

function alive(pid: number | undefined, expected = 'SUN_JOB_EXIT'): boolean {
  if (!Number.isSafeInteger(pid) || pid! <= 1) return false;
  try {
    process.kill(pid!, 0);
  } catch (e) {
    return expected === 'SUN_JOB_EXIT' && (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  const cmd = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).stdout ?? '';
  return cmd.includes(expected);
}

/** Ids of process jobs recorded as running on disk (candidates for restore). */
export function restorableJobIds(): string[] {
  return storedJobs().filter(job => job.state === 'running').map(job => job.id);
}

function storedJobs(): Job[] {
  const dir = homePath('jobs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        const j = JSON.parse(readFileSync(`${dir}/${f}`, 'utf8')) as Job;
        return typeof j.sessionId === 'string' ? [j] : [];
      } catch {
        return [];
      }
    });
}

export function worktreeJobsStillActive(): Job[] {
  return storedJobs().filter(job => {
    if (job.state === 'running') return true;
    if (job.state !== 'killed' || !Number.isSafeInteger(job.pid) || job.pid! <= 1) return false;
    try { process.kill(-job.pid!, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
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
    if (job.execution) {
      const result = transactSettingsFile(metaFile(job.id), undefined, () => ({ document: { ...job } }));
      if (!result.ok || result.durability !== 'confirmed') throw new Error('EXECUTION_PROVIDER_RECORD_UNAVAILABLE');
    } else if (job.pid || job.state !== 'running') {
      withStorageLock(() => writeFileSync(metaFile(job.id), JSON.stringify(job, null, 2)));
    }
  }

  private newJob(sessionId: string, name: string, command: string, extra: Partial<Job> = {}, id = `job-${randomUUID().slice(0, 6)}`): Job {
    const logFile = homePath('jobs', `${id}.log`);
    ensureDir(homePath('jobs'));
    writeFileSync(logFile, '');
    const job: Job = { id, sessionId, name, command, state: 'running', startedAt: new Date().toISOString(), logFile, ...extra };
    this.jobs.set(id, job);
    return job;
  }

  private finish(job: Job, state: JobState, exitCode?: number): void {
    withStorageLock(() => {
      if (job.execution) this.retained(job.id);
      if (job.state !== 'running') return;
      job.state = state;
      job.exitCode = exitCode;
      job.endedAt = new Date().toISOString();
      this.persist(job);
      this.onFinish({ job: { ...job }, tail: this.tail(job.id) });
      if (job.exitFile) rmSync(job.exitFile, { force: true });
      if (job.execution) {
        for (const file of [pidFile(job), cancelFile(job), cancelledFile(job)]) rmSync(file, { force: true });
      }
    });
  }

  /** Check running process jobs for an exit file (or a dead wrapper). */
  private poll(): void {
    let running = 0;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || (!job.pid && !job.execution)) continue;
      running++;
      if (job.execution) {
        try {
          withStorageLock(() => {
            const current = this.retained(job.id);
            if (current?.state === 'running') this.reconcileProcess(current);
          });
        } catch { /* The next poll can retry a managed state or storage transition. */ }
      } else this.reconcileProcess(job);
    }
    if (!running && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private reconcileProcess(job: Job): void {
    if (job.execution && !job.pid && lstatSync(pidFile(job), { throwIfNoEntry: false })?.isFile()) {
      const pid = Number(readFileSync(pidFile(job), 'utf8').trim());
      if (Number.isSafeInteger(pid) && pid > 1) {
        job.pid = pid;
        this.persist(job);
      }
    }
    if (job.execution?.environment === 'container' && job.execution.cancelRequestedAt && !job.execution.cancelAcknowledgedAt) {
      if (!existsSync(cancelFile(job))) writeFileSync(cancelFile(job), '', { mode: 0o600, flush: true });
      const execution = job.execution;
      const stopped = stopDockerExecution(execution.operationId, execution.dockerEndpoint, () => {
        if (!execution.containerStopVerifiedAt) {
          execution.containerStopVerifiedAt = new Date().toISOString();
          this.persist(job);
        }
      });
      if (stopped === 'unavailable') return;
      if (stopped === 'stopped' || (stopped === 'absent' && (execution.containerStopVerifiedAt || existsSync(cancelledFile(job))))) {
        job.execution.cancelAcknowledgedAt = new Date().toISOString();
        this.persist(job);
      }
    }
    const stopped = job.pid && !alive(job.pid, marker(job));
    // The wrapper publishes its exit status before it terminates. Check after sampling its identity.
    if (job.exitFile && existsSync(job.exitFile)) {
      const code = Number(readFileSync(job.exitFile, 'utf8').trim());
      const state = job.execution?.cancelAcknowledgedAt ? 'killed' : Number.isNaN(code) ? 'failed' : code === 0 ? 'done' : 'failed';
      this.finish(job, state, Number.isNaN(code) ? undefined : code);
    } else if (stopped) {
      if (job.execution?.environment === 'container' && !job.execution.cancelAcknowledgedAt) return;
      this.finish(job, job.execution?.cancelAcknowledgedAt ? 'killed' : 'lost');
    } else if (job.pid && job.execution?.cancelRequestedAt && job.execution.environment === 'host') {
      this.signalExecution(job);
    }
  }

  private signalExecution(job: Job): void {
    const execution = job.execution;
    const pid = job.pid;
    if (!execution || !pid || !alive(pid, marker(job))) return;
    const acknowledged = execution.cancelAcknowledgedAt;
    if (acknowledged && Date.now() - Date.parse(acknowledged) < 3000) return;
    try {
      process.kill(-pid, acknowledged ? 'SIGKILL' : 'SIGTERM');
    } catch {
      // The wrapper may finish between identity verification and signalling.
      return;
    }
    if (!acknowledged) {
      execution.cancelAcknowledgedAt = new Date().toISOString();
      this.persist(job);
    }
  }

  private watch(): void {
    if (!this.timer) {
      this.timer = setInterval(() => this.poll(), POLL_MS);
      this.timer.unref();
    }
  }

  /** Start a shell command in the background (detached, survives this process), in cwd. */
  /** `exec` runs a wrapped form of the command (e.g. sandboxed); `command` is what the job shows. */
  startProcess(sessionId: string, command: string, cwd: string, name = 'bash', exec?: { shell: string; env: NodeJS.ProcessEnv }): Job {
    const job = this.newJob(sessionId, name, command, { cwd });
    return this.launch(job, exec);
  }

  private launch(job: Job, exec?: { shell: string; env: NodeJS.ProcessEnv }): Job {
    job.exitFile = homePath('jobs', `${job.id}.exit`);
    if (job.execution) this.persist(job);
    // The managed wrapper records its PID before user code. It can be reattached if the host dies after spawning.
    const managedWrapper = 'trap \':\' TERM; bash -c "$SUN_JOB_CMD" >>"$SUN_JOB_LOG" 2>&1 & work=$!; while true; do wait "$work"; code=$?; kill -0 "$work" 2>/dev/null || break; done; echo "$code" >"$SUN_JOB_EXIT.tmp" && mv "$SUN_JOB_EXIT.tmp" "$SUN_JOB_EXIT"';
    const script = job.execution
      ? `printf '%s\\n' "$$" >"$SUN_JOB_PID.tmp" && mv "$SUN_JOB_PID.tmp" "$SUN_JOB_PID" || exit 125; ${managedWrapper} ${marker(job)}`
      : WRAPPER;
    const child = spawn('bash', ['-c', script], {
      cwd: job.cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...(exec?.env ?? process.env), PAGER: 'cat', SUN_JOB_CMD: exec?.shell ?? job.command,
        SUN_JOB_LOG: job.logFile, SUN_JOB_EXIT: job.exitFile, ...(job.execution ? { SUN_JOB_PID: pidFile(job),
          SUN_JOB_CANCEL: cancelFile(job), SUN_JOB_CANCELLED: cancelledFile(job) } : {}) },
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

  startExecution(sessionId: string, command: string, cwd: string, execution: NonNullable<Job['execution']>,
    prepare: () => { shell: string; env: NodeJS.ProcessEnv }): ExecutionJobReceipt {
    requireExecutionOperation(execution.operationId);
    return withStorageLock(() => {
      const id = executionId(execution.operationId);
      const previous = this.retained(id);
      if (previous) {
        if (previous.execution?.requestDigest !== execution.requestDigest || previous.execution.hostId !== execution.hostId) {
          throw new Error('EXECUTION_OPERATION_CONFLICT');
        }
        return this.receipt(previous);
      }
      const exec = prepare();
      return this.receipt(this.launch(this.newJob(sessionId, 'execution', command, { cwd, execution }, id), exec));
    });
  }

  retained(id: string): Job | undefined {
    const active = this.jobs.get(id);
    if (active && !active.execution) return active;
    if (!/^job-[a-z0-9-]{1,100}$/.test(id)) return;
    const file = metaFile(id);
    if (!lstatSync(file, { throwIfNoEntry: false })?.isFile()) return;
    const job = JSON.parse(readFileSync(file, 'utf8')) as Job;
    if (job.id !== id) return;
    if (!active) return job;
    Object.assign(active, job);
    return active;
  }

  private receipt(job: Job): ExecutionJobReceipt {
    const { operationId, hostId, environment, cancelRequestedAt, cancelAcknowledgedAt } = job.execution!;
    const uncertain = !job.pid || (environment === 'container' && (!alive(job.pid, marker(job)) || (cancelRequestedAt && !cancelAcknowledgedAt)));
    const state = job.state === 'running' ? uncertain ? 'reconciling' : 'running'
      : job.state === 'done' ? 'succeeded' : job.state === 'killed' ? 'cancelled' : job.state === 'lost' ? 'paused' : 'failed';
    return { operationId, hostId, environment, providerJobId: job.id, sessionId: job.sessionId, state,
      ...(cancelRequestedAt ? { cancellation: cancelAcknowledgedAt ? 'acknowledged' : 'requested' } : {}), exitCode: job.exitCode };
  }

  execution(operationId: string, hostId: string, cancel = false): ExecutionJobReceipt | null {
    requireExecutionOperation(operationId);
    return withStorageLock(() => {
      const job = this.retained(executionId(operationId));
      if (job?.execution?.hostId !== hostId) return null;
      if (job.state === 'running') {
        if (cancel && !job.execution.cancelRequestedAt) {
          job.execution.cancelRequestedAt = new Date().toISOString();
          this.persist(job);
        }
        this.reconcileProcess(job);
      } else if (cancel && job.state === 'lost' && job.execution.environment === 'host') {
        const now = new Date().toISOString();
        job.execution.cancelRequestedAt ??= now;
        job.execution.cancelAcknowledgedAt ??= now;
        job.state = 'killed';
        this.persist(job);
      }
      return this.receipt(job);
    });
  }

  executionOutput(operationId: string, hostId: string): string {
    requireExecutionOperation(operationId);
    const job = this.retained(executionId(operationId));
    if (job?.execution?.hostId !== hostId) throw new Error('EXECUTION_OUTPUT_UNAVAILABLE');
    return this.readTail(job, 50_000);
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
    return j ? this.readTail(j, chars) : '';
  }

  private readTail(j: Job, chars: number): string {
    try {
      if (j.execution) {
        const path = homePath('jobs', `${j.id}.log`);
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile()) return '';
          const buffer = Buffer.alloc(Math.min(stat.size, chars * 4));
          const count = readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length);
          return buffer.toString('utf8', 0, count).slice(-chars);
        } finally { closeSync(fd); }
      }
      const t = readFileSync(j.logFile, 'utf8');
      return t.length > chars ? `[…${t.length - chars} earlier chars in ${j.logFile}]\n${t.slice(-chars)}` : t;
    } catch {
      return '';
    }
  }

  kill(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.state !== 'running') return false;
    if (j.execution) {
      const receipt = this.execution(j.execution.operationId, j.execution.hostId, true);
      return receipt?.cancellation === 'acknowledged' || receipt?.state === 'cancelled';
    }
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
