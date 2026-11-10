import { createHash, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homePath } from '../paths.js';
import { readSettingsFile, transactSettingsFile } from './store.js';

export const executionOperationPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const executionSessionPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const targetPattern = /^(local|container|remote-gateway):[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export type ExecutionTargetKind = 'local' | 'container' | 'remote-gateway';
export type ExecutionTargetHealth = 'ready' | 'offline' | 'unsupported' | 'identity-changed';
export interface ExecutionTarget {
  id: string;
  hostId: string;
  label: string;
  kind: ExecutionTargetKind;
  health: ExecutionTargetHealth;
  capabilities: string[];
}

export type ExecutionJobState = 'queued' | 'running' | 'waiting-user' | 'paused' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
export type ExecutionEnvironment = 'host' | 'container';
export interface ExecutionJobReceipt {
  operationId: string;
  providerJobId: string;
  hostId: string;
  sessionId: string;
  environment: ExecutionEnvironment;
  state: ExecutionJobState;
  cancellation?: 'requested' | 'acknowledged';
  exitCode?: number;
}

export interface ExecutionJob extends Omit<ExecutionJobReceipt, 'providerJobId'> {
  targetId: string;
  targetLabel: string;
  createdAt: string;
  updatedAt: string;
  providerJobId?: string;
  targetHealth?: ExecutionTargetHealth;
  failure?: 'session-unavailable' | 'environment-mismatch' | 'container-unavailable';
}

export interface StartExecutionJob {
  targetId: string;
  sessionId: string;
  command: string;
  operationId?: string;
}

export interface ExecutionJobRequest {
  operationId: string;
  hostId: string;
  sessionId: string;
  command: string;
  environment?: ExecutionEnvironment;
}

export interface ExecutionJobAdapter {
  target: ExecutionTarget;
  sessions(): Promise<{ id: string; title: string; environment: ExecutionEnvironment }[]>;
  start(input: ExecutionJobRequest): Promise<ExecutionJobReceipt>;
  inspect(operationId: string): Promise<ExecutionJobReceipt | null>;
  cancel(operationId: string): Promise<ExecutionJobReceipt | null>;
  output(operationId: string): Promise<string>;
}

export function validateExecutionCommand(sessionId: unknown, command: unknown): void {
  if (typeof sessionId !== 'string' || !executionSessionPattern.test(sessionId)
    || typeof command !== 'string' || !command.trim() || command.includes('\0') || Buffer.byteLength(command) > 16 * 1024) {
    throw new Error('EXECUTION_JOB_INVALID');
  }
}

export function requireExecutionOperation(operationId: unknown): asserts operationId is string {
  if (typeof operationId !== 'string' || !executionOperationPattern.test(operationId)) throw new Error('EXECUTION_OPERATION_INVALID');
}

const terminal = new Set<ExecutionJobState>(['succeeded', 'failed', 'cancelled']);
const states = new Set<ExecutionJobState>([...terminal, 'queued', 'running', 'waiting-user', 'paused', 'reconciling']);
type StoredExecutionJob = ExecutionJob & { requestDigest: string };
const publicJob = ({ requestDigest: _requestDigest, ...job }: StoredExecutionJob): ExecutionJob => job;
const directory = () => homePath('execution-jobs');
const recordFile = (operationId: string) => homePath('execution-jobs', `${operationId}.json`);

function jobRecord(document: Record<string, unknown>, operationId: string): StoredExecutionJob | undefined {
  if (!Object.keys(document).length) return;
  const job = document as unknown as StoredExecutionJob;
  if (job.operationId !== operationId || typeof job.targetId !== 'string' || !targetPattern.test(job.targetId)
    || typeof job.hostId !== 'string' || !job.targetId.endsWith(`:${job.hostId}`) || typeof job.targetLabel !== 'string'
    || typeof job.sessionId !== 'string' || !executionSessionPattern.test(job.sessionId) || !states.has(job.state)
    || (job.environment !== 'host' && job.environment !== 'container')
    || typeof job.requestDigest !== 'string' || !/^[a-f0-9]{64}$/.test(job.requestDigest)
    || typeof job.createdAt !== 'string' || typeof job.updatedAt !== 'string') {
    throw new Error('EXECUTION_JOB_RECORD_INVALID');
  }
  return job;
}

function getJob(operationId: string): StoredExecutionJob | undefined {
  requireExecutionOperation(operationId);
  return jobRecord(readSettingsFile(recordFile(operationId)).document, operationId);
}

function changeJob(operationId: string, edit: (job?: StoredExecutionJob) => StoredExecutionJob): StoredExecutionJob {
  const result = transactSettingsFile(recordFile(operationId), undefined, ({ document }) => ({
    document: { ...edit(jobRecord(document, operationId)), updatedAt: new Date().toISOString() },
  }));
  if (!result.ok || result.durability !== 'confirmed') throw new Error('EXECUTION_JOB_RECORD_UNAVAILABLE');
  return jobRecord(result.file.document, operationId)!;
}

/** One operation is submitted once. Subsequent calls observe the original provider receipt. */
export class ExecutionJobs {
  constructor(private readonly adapterFor: (id: string) => Promise<ExecutionJobAdapter | undefined>) {}

  list(): ExecutionJob[] {
    let names: string[];
    try { names = readdirSync(directory()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return names.filter(name => name.endsWith('.json') && executionOperationPattern.test(name.slice(0, -5)))
      .map(name => getJob(name.slice(0, -5)))
      .filter((job): job is StoredExecutionJob => !!job)
      .map(publicJob)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async sessions(targetId: string) {
    const adapter = await this.adapterFor(targetId);
    if (adapter?.target.health !== 'ready') throw new Error('EXECUTION_TARGET_UNAVAILABLE');
    return adapter.sessions();
  }

  private apply(operationId: string, receipt: ExecutionJobReceipt | null, health: ExecutionTargetHealth): ExecutionJob {
    return publicJob(changeJob(operationId, prior => {
      if (!prior) throw new Error('EXECUTION_JOB_NOT_FOUND');
      if (receipt && (receipt.operationId !== operationId || receipt.hostId !== prior.hostId || receipt.sessionId !== prior.sessionId
        || !states.has(receipt.state) || (receipt.environment !== 'host' && receipt.environment !== 'container')
        || typeof receipt.providerJobId !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(receipt.providerJobId)
        || (receipt.cancellation !== undefined && receipt.cancellation !== 'requested' && receipt.cancellation !== 'acknowledged')
        || (receipt.exitCode !== undefined && !Number.isSafeInteger(receipt.exitCode))
        || (prior.providerJobId && prior.providerJobId !== receipt.providerJobId))) {
        return { ...prior, targetHealth: 'identity-changed', state: terminal.has(prior.state) ? prior.state : 'reconciling' };
      }
      if (!receipt || terminal.has(prior.state)) {
        return { ...prior, targetHealth: health, state: terminal.has(prior.state) ? prior.state : 'reconciling' };
      }
      const cancellation = prior.cancellation === 'acknowledged' ? prior.cancellation : receipt.cancellation ?? prior.cancellation;
      return { ...prior, providerJobId: receipt.providerJobId, state: receipt.state, environment: receipt.environment,
        cancellation, exitCode: receipt.exitCode, targetHealth: health };
    }));
  }

  async start(input: StartExecutionJob): Promise<ExecutionJob> {
    validateExecutionCommand(input?.sessionId, input?.command);
    if (typeof input.targetId !== 'string' || !targetPattern.test(input.targetId)) throw new Error('EXECUTION_TARGET_INVALID');
    const operationId = input.operationId ?? randomUUID();
    requireExecutionOperation(operationId);
    const requestDigest = createHash('sha256').update(JSON.stringify([input.targetId, input.sessionId, input.command])).digest('hex');
    const previous = getJob(operationId);
    if (previous) {
      if (previous.requestDigest !== requestDigest) throw new Error('EXECUTION_OPERATION_CONFLICT');
      return this.refresh(operationId);
    }
    const adapter = await this.adapterFor(input.targetId);
    if (adapter?.target.health !== 'ready' || adapter.target.id !== input.targetId) throw new Error('EXECUTION_TARGET_UNAVAILABLE');
    const { target } = adapter;
    const environment = target.kind === 'container' ? 'container' : 'host';
    let reserved = false;
    changeJob(operationId, existing => {
      if (existing) return existing;
      reserved = true;
      return { operationId, targetId: target.id, hostId: target.hostId, targetLabel: target.label,
        sessionId: input.sessionId, environment, requestDigest, state: 'queued', createdAt: new Date().toISOString(), updatedAt: '' };
    });
    if (!reserved) {
      const existing = getJob(operationId)!;
      if (existing.requestDigest !== requestDigest) throw new Error('EXECUTION_OPERATION_CONFLICT');
      return this.refresh(operationId);
    }
    let receipt: ExecutionJobReceipt;
    try {
      receipt = await adapter.start({ operationId, hostId: target.hostId, sessionId: input.sessionId, command: input.command,
        ...(target.kind !== 'remote-gateway' ? { environment } : {}) });
    } catch (error) {
      const code = String(error);
      const failure = code.includes('EXECUTION_SESSION_UNAVAILABLE') ? 'session-unavailable'
        : code.includes('EXECUTION_TARGET_ENVIRONMENT_MISMATCH') ? 'environment-mismatch'
        : code.includes('EXECUTION_CONTAINER_UNAVAILABLE') ? 'container-unavailable' : undefined;
      if (failure) return publicJob(changeJob(operationId, prior => ({ ...prior!, state: 'failed', targetHealth: 'ready', failure })));
      return this.apply(operationId, null, code.includes('EXECUTION_TARGET_IDENTITY_CHANGED') ? 'identity-changed' : 'offline');
    }
    return this.apply(operationId, receipt, 'ready');
  }

  private async observe(operationId: string, action: 'inspect' | 'cancel'): Promise<ExecutionJob> {
    const job = getJob(operationId);
    if (!job) throw new Error('EXECUTION_JOB_NOT_FOUND');
    if (terminal.has(job.state)) return publicJob(job);
    let adapter: ExecutionJobAdapter | undefined;
    try { adapter = await this.adapterFor(job.targetId); }
    catch { return this.apply(operationId, null, 'offline'); }
    if (!adapter || adapter.target.hostId !== job.hostId || adapter.target.id !== job.targetId) {
      return this.apply(operationId, null, adapter ? 'identity-changed' : 'offline');
    }
    if (adapter.target.health !== 'ready') return this.apply(operationId, null, adapter.target.health);
    let receipt: ExecutionJobReceipt | null;
    try {
      receipt = await adapter[action](operationId);
      if (action === 'inspect' && job.cancellation === 'requested' && receipt && !receipt.cancellation && !terminal.has(receipt.state)
        && receipt.hostId === job.hostId && receipt.sessionId === job.sessionId && receipt.operationId === operationId) {
        receipt = await adapter.cancel(operationId);
      }
    }
    catch { return this.apply(operationId, null, 'offline'); }
    return this.apply(operationId, receipt, 'ready');
  }

  async refresh(operationId: string): Promise<ExecutionJob> {
    return this.observe(operationId, 'inspect');
  }

  async cancel(operationId: string): Promise<ExecutionJob> {
    requireExecutionOperation(operationId);
    const job = changeJob(operationId, prior => {
      if (!prior) throw new Error('EXECUTION_JOB_NOT_FOUND');
      return terminal.has(prior.state) || prior.cancellation === 'acknowledged' ? prior : { ...prior, cancellation: 'requested' };
    });
    return job.cancellation === 'acknowledged' ? this.refresh(operationId) : this.observe(operationId, 'cancel');
  }

  async output(operationId: string): Promise<string> {
    const job = getJob(operationId);
    if (!job?.providerJobId) throw new Error('EXECUTION_OUTPUT_UNAVAILABLE');
    const adapter = await this.adapterFor(job.targetId);
    if (adapter?.target.health !== 'ready' || adapter.target.id !== job.targetId || adapter.target.hostId !== job.hostId) {
      throw new Error('EXECUTION_TARGET_UNAVAILABLE');
    }
    const receipt = await adapter.inspect(operationId);
    if (receipt?.providerJobId !== job.providerJobId || receipt.hostId !== job.hostId || receipt.sessionId !== job.sessionId
      || receipt.operationId !== operationId) throw new Error('EXECUTION_OUTPUT_UNAVAILABLE');
    return adapter.output(operationId);
  }
}
