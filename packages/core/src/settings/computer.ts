import { randomUUID } from 'node:crypto';

export interface ComputerTarget {
  appId: string;
  instance: string;
  windowId: string;
}

export type ComputerAction = { kind: 'press' } | { kind: 'set-text'; text: string };
type ActionKind = ComputerAction['kind'];

export interface ComputerControlItem {
  /** Native identifier, retained by the controller and never returned to the model. */
  key: string;
  role: string;
  label: string;
  actions: ActionKind[];
}

export interface ComputerAdapter {
  probe(signal: AbortSignal): Promise<{ authorized: boolean; target?: ComputerTarget }>;
  snapshot(target: ComputerTarget, signal: AbortSignal): Promise<{
    target: ComputerTarget;
    text: string;
    controls: ComputerControlItem[];
  }>;
  /** The adapter must recheck the foreground window, OS permission, and element at dispatch. */
  act(target: ComputerTarget, control: ComputerControlItem, action: ComputerAction, signal: AbortSignal): Promise<'applied' | 'refused'>;
}

export interface ComputerApp { id: string; label: string }

export interface DesktopComputerAdapter extends ComputerAdapter {
  status(): 'available' | 'unavailable' | { state: 'unavailable'; reasonCode: string };
  inspect(): Promise<{ authorized: boolean; apps: ComputerApp[] }>;
}

export interface ComputerSettings {
  authorized: boolean;
  apps: ComputerApp[];
  grants: string[];
  revision: string;
  owner?: { sessionId: string; appId: string };
}

export interface ComputerObservation {
  generation: string;
  appId: string;
  text: string;
  controls: Array<Omit<ComputerControlItem, 'key'> & { ref: string }>;
}

export interface ComputerReceipt {
  sessionId: string;
  operationId: string;
  appId: string;
  action: ActionKind;
  outcome: 'dispatched' | 'applied' | 'refused';
}

type Snapshot = { generation: string; controls: Map<string, ComputerControlItem> };
type Lease = {
  sessionId: string;
  appId: string;
  controller: AbortController;
  expires: number;
  timer?: NodeJS.Timeout;
  pending: boolean;
  target?: ComputerTarget;
  snapshot?: Snapshot;
};

const ttl = 60_000;
const identity = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
export const validComputerIdentity = (value: unknown): value is string => typeof value === 'string' && identity.test(value);
const equalTarget = (a: ComputerTarget, b: ComputerTarget) => a.appId === b.appId && a.instance === b.instance && a.windowId === b.windowId;

/** End the caller's wait even if a native operation ignores cancellation. */
async function invoke<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
  if (signal.aborted) throw new Error('COMPUTER_STOPPED');
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('COMPUTER_STOPPED'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    const result = Promise.resolve().then(() => {
      if (signal.aborted) throw new Error('COMPUTER_STOPPED');
      return operation();
    }).catch(() => { throw new Error(signal.aborted ? 'COMPUTER_STOPPED' : 'COMPUTER_ADAPTER_FAILED'); });
    return await Promise.race([result, cancelled]);
  } finally { signal.removeEventListener('abort', stop); }
}

/** One local desktop lease. Only the host's tool policy path should call act. */
export class ComputerControl {
  private lease?: Lease;
  private inFlight = 0;
  private release?: () => void;

  constructor(
    private readonly adapter: ComputerAdapter,
    private readonly allowed: (sessionId: string, appId: string) => boolean,
    private readonly record: (receipt: ComputerReceipt) => true,
    private readonly now = Date.now,
    private readonly claim?: () => () => void,
  ) {}

  begin(sessionId: string, appId: string): void {
    if (!validComputerIdentity(sessionId) || !validComputerIdentity(appId) || !this.allowed(sessionId, appId)) throw new Error('COMPUTER_GRANT_REQUIRED');
    if (this.lease && this.lease.expires <= this.now()) this.stop();
    if (this.lease || this.inFlight) throw new Error('COMPUTER_CONTROL_BUSY');
    this.release = this.claim?.();
    const lease: Lease = { sessionId, appId, controller: new AbortController(), expires: this.now() + ttl, pending: false };
    lease.timer = setTimeout(() => { if (this.lease === lease) this.stop(); }, ttl);
    lease.timer.unref();
    this.lease = lease;
  }

  owner(): { sessionId: string; appId: string } | undefined {
    const lease = this.lease;
    if (!lease) return;
    if (lease.expires <= this.now() || !this.allowed(lease.sessionId, lease.appId)) {
      this.stop();
      return;
    }
    return { sessionId: lease.sessionId, appId: lease.appId };
  }

  stop(sessionId?: string): void {
    const lease = this.lease;
    if (!lease || (sessionId !== undefined && sessionId !== lease.sessionId)) return;
    this.lease = undefined;
    clearTimeout(lease.timer);
    lease.controller.abort();
    this.releaseIfIdle();
  }

  takeover(sessionId: string): void { this.stop(sessionId); }

  private releaseIfIdle(): void {
    if (this.lease || this.inFlight) return;
    const release = this.release;
    this.release = undefined;
    release?.();
  }

  private native<T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    return invoke(signal, async () => {
      this.inFlight++;
      try { return await operation(); }
      finally { this.inFlight--; this.releaseIfIdle(); }
    });
  }

  private check(lease: Lease, signal: AbortSignal): void {
    if (signal.aborted || this.lease !== lease) throw new Error('COMPUTER_STOPPED');
    if (lease.expires <= this.now() || !this.allowed(lease.sessionId, lease.appId)) {
      this.stop(lease.sessionId);
      throw new Error('COMPUTER_GRANT_REQUIRED');
    }
  }

  private async target(lease: Lease, signal: AbortSignal): Promise<ComputerTarget> {
    this.check(lease, signal);
    const { authorized, target } = await this.native(signal, () => this.adapter.probe(signal));
    this.check(lease, signal);
    if (!authorized) {
      this.stop(lease.sessionId);
      throw new Error('COMPUTER_OS_PERMISSION_REQUIRED');
    }
    if (!lease.target && target?.appId !== lease.appId) throw new Error('COMPUTER_TARGET_NOT_READY');
    if (!target || target.appId !== lease.appId || !validComputerIdentity(target.instance) || !validComputerIdentity(target.windowId)
      || (lease.target && !equalTarget(lease.target, target))) {
      this.stop(lease.sessionId);
      throw new Error('COMPUTER_TARGET_CHANGED');
    }
    lease.target = { ...target };
    return lease.target;
  }

  private async use<T>(sessionId: string, outside: AbortSignal, action: (lease: Lease, signal: AbortSignal) => Promise<T>): Promise<T> {
    const lease = this.lease;
    if (!lease || lease.sessionId !== sessionId) throw new Error('COMPUTER_CONTROL_REQUIRED');
    const signal = AbortSignal.any([outside, lease.controller.signal]);
    this.check(lease, signal);
    if (lease.pending || this.inFlight) throw new Error('COMPUTER_CONTROL_BUSY');
    lease.pending = true;
    try { return await action(lease, signal); }
    finally {
      lease.pending = false;
      if (outside.aborted && this.lease === lease) this.stop(sessionId);
    }
  }

  snapshot(sessionId: string, outside: AbortSignal): Promise<ComputerObservation> {
    return this.use(sessionId, outside, async (lease, signal) => {
      lease.snapshot = undefined;
      const target = await this.target(lease, signal);
      const observed = await this.native(signal, () => this.adapter.snapshot(target, signal));
      await this.target(lease, signal);
      this.check(lease, signal);
      if (!equalTarget(target, observed.target)) {
        this.stop(sessionId);
        throw new Error('COMPUTER_TARGET_CHANGED');
      }
      const generation = randomUUID();
      const controls = new Map<string, ComputerControlItem>();
      const publicControls = observed.controls.slice(0, 128).map((item, index) => {
        const ref = `${generation}.${index}`;
        const role = item.role.slice(0, 80);
        const label = item.label.slice(0, 300);
        const actions = item.actions.filter(action => action === 'press' || action === 'set-text');
        controls.set(ref, { key: item.key, role, label, actions });
        return { ref, role, label, actions: [...actions] };
      });
      lease.snapshot = { generation, controls };
      return { generation, appId: lease.appId, text: observed.text.slice(0, 12_000), controls: publicControls };
    });
  }

  act(sessionId: string, ref: string, action: ComputerAction, outside: AbortSignal): Promise<'applied' | 'refused'> {
    return this.use(sessionId, outside, async (lease, signal) => {
      const snapshot = lease.snapshot;
      const control = snapshot?.controls.get(ref);
      if (!snapshot || !control) throw new Error('COMPUTER_SNAPSHOT_STALE');
      if (!control.actions.includes(action.kind) || (action.kind === 'set-text'
        && (typeof action.text !== 'string' || Buffer.byteLength(action.text) > 4096 || action.text.includes('\0')))) {
        throw new Error('COMPUTER_ACTION_INVALID');
      }
      const target = await this.target(lease, signal);
      const receipt = { sessionId, operationId: snapshot.generation, appId: target.appId, action: action.kind };
      this.check(lease, signal);
      lease.snapshot = undefined;
      try {
        if (this.record({ ...receipt, outcome: 'dispatched' }) !== true) throw new Error('COMPUTER_RECEIPT_UNAVAILABLE');
      }
      catch { throw new Error('COMPUTER_RECEIPT_UNAVAILABLE'); }
      try {
        const outcome = await this.native(signal, () => this.adapter.act(target, control, action, signal));
        this.check(lease, signal);
        if (outcome !== 'applied' && outcome !== 'refused') throw new Error('COMPUTER_ADAPTER_FAILED');
        if (this.record({ ...receipt, outcome }) !== true) throw new Error('COMPUTER_RECEIPT_UNAVAILABLE');
        return outcome;
      } catch {
        throw new Error('COMPUTER_OUTCOME_UNCERTAIN');
      }
    });
  }
}
