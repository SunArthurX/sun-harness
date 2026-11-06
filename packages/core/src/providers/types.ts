import type { ChatMessage, ToolCall, ToolSchema, Usage } from '../types.js';

export interface ModelRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  tools: ToolSchema[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  onDelta?: (d: { text?: string; reasoning?: string }) => void;
}

export interface ModelResponse {
  text: string;
  reasoning?: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

export interface Provider {
  readonly id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/**
 * Error taxonomy. The loop's reaction depends only on `kind`:
 * - rate_limit, network: transient → retry with backoff.
 * - quota, auth: durable → pause the session; resume after quota restore or model/key change.
 * - context_length: compact and retry once.
 * - aborted: user abort.
 */
export type ProviderErrorKind = 'quota' | 'rate_limit' | 'auth' | 'network' | 'context_length' | 'aborted' | 'other';

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

const QUOTA_PATTERNS = [
  /insufficient[_ ]?(balance|quota|funds|credit)/i,
  /exceeded your current quota/i,
  /quota (exceeded|exhausted)/i,
  /billing/i,
  /credit balance/i,
  /out of credits/i,
  /usage limit/i,
  /plan limit/i,
  /RESOURCE_EXHAUSTED.*quota|quota.*RESOURCE_EXHAUSTED/i,
  /余额|额度|配额|上限|欠费/,
];

const CONTEXT_PATTERNS = [/context[_ ]length/i, /maximum context/i, /too many tokens/i, /prompt is too long/i, /context window/i];

export function classifyHttpError(status: number, body: string, retryAfterHeader?: string | null): ProviderError {
  const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 || undefined : undefined;
  const msg = `HTTP ${status}: ${body.slice(0, 500)}`;
  if (status === 402) return new ProviderError('quota', msg, status);
  if (QUOTA_PATTERNS.some((p) => p.test(body)) && (status === 429 || status === 403 || status === 400 || status === 401)) {
    return new ProviderError('quota', msg, status);
  }
  if (status === 401 || status === 403) return new ProviderError('auth', msg, status);
  if (status === 429 || status === 529) return new ProviderError('rate_limit', msg, status, retryAfterMs);
  if (status === 400 || status === 413) {
    if (CONTEXT_PATTERNS.some((p) => p.test(body))) return new ProviderError('context_length', msg, status);
    return new ProviderError('other', msg, status);
  }
  if (status >= 500) return new ProviderError('network', msg, status, retryAfterMs);
  return new ProviderError('other', msg, status);
}

export function toProviderError(err: unknown, signal?: AbortSignal): ProviderError {
  if (err instanceof ProviderError) return err;
  if (signal?.aborted || (err as Error)?.name === 'AbortError') return new ProviderError('aborted', 'Request aborted');
  return new ProviderError('network', (err as Error)?.message ?? String(err));
}
