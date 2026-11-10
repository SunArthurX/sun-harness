import { createHash } from 'node:crypto';
import { usesGatewayRequestId } from './settings/protocol.js';

export type RpcReply = { ok: true; result: unknown } | { ok: false; error: string };
type Receipt = { digest: string; expires: number; pending: boolean; reply: Promise<RpcReply> };
const ACCEPTANCE_MS = 10 * 60_000;
const MAX_RECEIPTS = 8192;
const requestIdPattern = /^([a-f0-9-]{36}):(\d{13}):([a-f0-9-]{36})$/;

export class GatewayReceipts {
  private readonly entries = new Map<string, Receipt>();
  constructor(private readonly gatewayId: string, private readonly now: () => number) {}

  async dispatch(principal: string, requestId: unknown, method: string, args: unknown[], run: () => Promise<RpcReply>): Promise<RpcReply> {
    if (requestId === undefined) return run();
    const parts = typeof requestId === 'string' && requestIdPattern.exec(requestId);
    if (!usesGatewayRequestId(method) || !parts) return { ok: false, error: 'INVALID_GATEWAY_REQUEST_ID' };
    if (parts[1] !== this.gatewayId) return { ok: false, error: 'GATEWAY_INSTANCE_CHANGED' };
    const now = this.now();
    const issued = Number(parts[2]);
    const expires = issued + ACCEPTANCE_MS;
    if (issued > now + 30_000 || now >= expires) return { ok: false, error: 'GATEWAY_REQUEST_EXPIRED' };
    const key = `${principal}/${requestId}`;
    const digest = createHash('sha256').update(JSON.stringify([method, args])).digest('hex');
    const prior = this.entries.get(key);
    if (prior) return prior.digest === digest ? prior.reply : { ok: false, error: 'GATEWAY_REQUEST_CONFLICT' };
    for (const [id, entry] of this.entries) {
      if (!entry.pending && entry.expires <= now) this.entries.delete(id);
    }
    if (this.entries.size >= MAX_RECEIPTS) return { ok: false, error: 'GATEWAY_RECEIPTS_BUSY' };
    const entry: Receipt = { digest, expires, pending: true, reply: Promise.resolve().then(run) };
    this.entries.set(key, entry);
    try {
      return await entry.reply;
    } finally {
      entry.pending = false;
    }
  }
}
