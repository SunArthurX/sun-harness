import type { ApprovalMode, SunConfig } from './config.js';
import { SessionLog } from './log.js';
import { deriveMessages, estimateTokens, pendingToolCalls } from './messages.js';
import { needsApproval } from './policy.js';
import { isUntrustedTool, scanInjection, wrapUntrusted } from './research/taint.js';
import { ProviderError, type ModelResponse, type Provider } from './providers/types.js';
import { toSchema, truncate, type Tool, type ToolServices } from './tools/types.js';
import { runVerify } from './verify.js';
import type { ApprovalDecision, LiveEvent, RunStatus, SessionEvent, SessionEventBody, ToolCall } from './types.js';

export interface ApprovalRequest {
  sessionId: string;
  callId: string;
  name: string;
  arguments: string;
  risk: Tool['risk'];
}

export interface AgentHooks {
  preToolUse?(e: { sessionId: string; tool: string; args: unknown; cwd: string }): Promise<{ block?: string } | void>;
  postToolUse?(e: { sessionId: string; tool: string; args: unknown; output: string; cwd: string }): Promise<string | void>;
  /** Return text to continue the run with a new user message (e.g. a verification gate). */
  stop?(e: { sessionId: string; cwd: string; lastText: string }): Promise<string | void>;
}

export interface AgentDeps {
  log: SessionLog;
  config: SunConfig;
  resolveModel(ref: string): { provider: Provider; model: string };
  /** Tools for the session's current mode. */
  tools(): Tool[];
  systemPrompt(modelRef: string): string;
  approvalMode(): ApprovalMode;
  /** Done gate: verify commands for the session's cwd (empty = none), run when a coding run ends after edits. */
  verify?: { commands(cwd: string): string[]; maxAttempts: number; timeoutMs: number; sandbox?(): import('./sandbox.js').ExecSandbox | undefined };
  /** Resolve a routing pseudo-model ("auto") to a concrete model for the next request. */
  routeModel?(ref: string): string;
  /** Extra inputs for the approval policy (e.g. whether shell commands are sandboxed). */
  policy?(): import('./policy.js').PolicyContext;
  /** Token count at which history must be compacted for a model (context window minus buffer). */
  contextLimit?(modelRef: string): number;
  /** `reason` explains a non-human decision (e.g. headless deny) to the model. */
  requestApproval(req: ApprovalRequest, signal: AbortSignal): Promise<{ decision: ApprovalDecision; reason?: string }>;
  services: ToolServices;
  hooks?: AgentHooks;
  onLive?(e: LiveEvent): void;
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

export interface RunResult {
  status: RunStatus;
  reason?: string;
  detail?: string;
}

const MAX_TRANSIENT_RETRIES = 5;

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((res) => {
    const t = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), res()), { once: true });
  });
}

/**
 * The agent loop. Stateless between calls: every decision is derived from the session log,
 * so `run()` doubles as `resume()` after a crash, an abort, a quota pause, or a model switch.
 */
export class Agent {
  constructor(private readonly d: AgentDeps) {}

  private get id(): string {
    return this.d.log.id;
  }

  private emit(body: SessionEventBody): SessionEvent {
    const event = this.d.log.append(body);
    this.d.onLive?.({ kind: 'event', sessionId: this.id, event });
    return event;
  }

  private setStatus(status: RunStatus, reason?: string, detail?: string): RunResult {
    const cur = this.d.log.status();
    if (cur.status !== status || cur.reason !== reason || cur.detail !== detail) this.emit({ type: 'run/status', status, reason, detail });
    return { status, reason, detail };
  }

  private alwaysAllowed(): Set<string> {
    const byCall = new Map<string, string>();
    const out = new Set<string>();
    for (const e of this.d.log.all()) {
      if (e.type === 'approval/request') byCall.set(e.callId, e.name);
      if (e.type === 'approval/decision' && e.decision === 'allow_always') {
        const n = byCall.get(e.callId);
        if (n) out.add(n);
      }
    }
    return out;
  }

  /** Is a model request owed? True when the latest conversational event is user input or a tool result. */
  private owesRequest(): boolean {
    const ev = this.d.log.all();
    for (let i = ev.length - 1; i >= 0; i--) {
      const t = ev[i].type;
      if (t === 'user/message' || t === 'tool/result') return true;
      if (t === 'assistant/message') return false;
    }
    return false;
  }

  async run(signal: AbortSignal): Promise<RunResult> {
    this.setStatus('running');
    const triedModels = new Set<string>();
    let contextRetry = false;
    let stopContinues = 0;
    let verifyAttempts = 0;
    try {
      for (let step = 0; step < this.d.config.maxSteps; step++) {
        if (signal.aborted) return this.setStatus('aborted', 'user');

        const pending = pendingToolCalls(this.d.log.all());
        if (pending.length) {
          await this.executeTools(pending, signal);
          if (signal.aborted) return this.setStatus('aborted', 'user');
        }

        if (!this.owesRequest()) {
          // Done gate: a failed verification appends its output as a new message, which owes another request.
          if (this.d.verify && verifyAttempts <= this.d.verify.maxAttempts) {
            const v = await this.verifyGate(signal, ++verifyAttempts);
            if (v === 'failed' && this.owesRequest()) continue;
          }
          const stopText = await this.d.hooks?.stop?.({ sessionId: this.id, cwd: this.cwd(), lastText: this.lastAssistantText() });
          if (stopText && stopContinues++ < 3) {
            this.emit({ type: 'user/message', text: stopText, source: 'hook' });
            continue;
          }
          return this.setStatus('idle');
        }

        const modelRef = this.d.routeModel?.(this.d.log.currentModel()) ?? this.d.log.currentModel();
        let resp: ModelResponse;
        try {
          await this.maybeCompact(modelRef, signal, false);
          resp = await this.callModel(modelRef, signal);
        } catch (e) {
          const err = e as ProviderError;
          if (err.kind === 'aborted' || signal.aborted) return this.setStatus('aborted', 'user');
          if (err.kind === 'context_length' && !contextRetry) {
            contextRetry = true;
            await this.maybeCompact(modelRef, signal, true);
            step--;
            continue;
          }
          if (err.kind === 'quota' || err.kind === 'auth') {
            triedModels.add(modelRef);
            const next = this.d.config.fallbackModels.find((m) => !triedModels.has(m) && m !== modelRef);
            if (next) {
              this.emit({ type: 'model/switch', from: modelRef, to: next, reason: `fallback after ${err.kind}: ${err.message.slice(0, 200)}` });
              step--;
              continue;
            }
            return this.setStatus('paused', err.kind, err.message.slice(0, 500));
          }
          if (err.kind === 'rate_limit' || err.kind === 'network') return this.setStatus('paused', err.kind, err.message.slice(0, 500));
          return this.setStatus('error', err.kind ?? 'other', (err.message ?? String(e)).slice(0, 1000));
        }

        this.emit({
          type: 'assistant/message',
          text: resp.text,
          reasoning: resp.reasoning,
          toolCalls: resp.toolCalls,
          usage: resp.usage,
          model: modelRef,
        });
        this.maybeTitle();
      }
      if (!pendingToolCalls(this.d.log.all()).length && !this.owesRequest()) return this.setStatus('idle');
      return this.setStatus('paused', 'max_steps', `Reached ${this.d.config.maxSteps} steps. Resume to continue.`);
    } catch (e) {
      return this.setStatus('error', 'internal', (e as Error).stack?.slice(0, 1500) ?? String(e));
    }
  }

  private cwd(): string {
    return this.d.log.meta()?.cwd ?? process.cwd();
  }

  private lastAssistantText(): string {
    return this.d.log.last('assistant/message')?.text ?? '';
  }

  private maybeTitle(): void {
    const meta = this.d.log.meta();
    if (!meta || meta.title !== 'New session' || this.d.log.last('session/title')) return;
    const first = this.d.log.all().find((e) => e.type === 'user/message') as Extract<SessionEvent, { type: 'user/message' }> | undefined;
    if (!first) return;
    const t = first.text.replace(/\s+/g, ' ').trim();
    this.emit({ type: 'session/title', title: t.length > 60 ? t.slice(0, 57) + '...' : t || 'Untitled' });
  }

  private async callModel(modelRef: string, signal: AbortSignal): Promise<ModelResponse> {
    const { provider, model } = this.d.resolveModel(modelRef);
    const tools = this.d.tools();
    const system = this.d.systemPrompt(modelRef);
    const header = this.d.log.last('request/header');
    const names = tools.map((t) => t.name);
    if (!header || header.systemPrompt !== system || header.model !== modelRef || header.tools.join() !== names.join()) {
      this.emit({ type: 'request/header', model: modelRef, systemPrompt: system, tools: names });
    }
    const messages = deriveMessages(this.d.log.all());
    const sleep = this.d.sleep ?? defaultSleep;
    for (let attempt = 0; ; attempt++) {
      try {
        return await provider.complete({
          model,
          system,
          messages,
          tools: tools.map(toSchema),
          signal,
          onDelta: (dl) => this.d.onLive?.({ kind: 'delta', sessionId: this.id, ...dl }),
        });
      } catch (e) {
        const err = e instanceof ProviderError ? e : new ProviderError('network', (e as Error).message);
        if ((err.kind === 'rate_limit' || err.kind === 'network') && attempt < MAX_TRANSIENT_RETRIES && !signal.aborted) {
          const wait = Math.min(err.retryAfterMs ?? 1000 * 2 ** attempt, 60_000);
          this.d.onLive?.({ kind: 'delta', sessionId: this.id, reasoning: `\n[${err.kind}: retrying in ${Math.round(wait / 1000)}s]\n` });
          await sleep(wait, signal);
          continue;
        }
        throw err;
      }
    }
  }

  private async executeTools(calls: ToolCall[], signal: AbortSignal): Promise<void> {
    const tools = new Map(this.d.tools().map((t) => [t.name, t]));
    const cwd = this.cwd();
    type Prepared = { call: ToolCall; tool?: Tool; args?: Record<string, unknown>; error?: string; parallel: boolean };
    const prepared: Prepared[] = calls.map((call) => {
      const tool = tools.get(call.name);
      if (!tool) return { call, error: `Unknown tool "${call.name}". Available: ${[...tools.keys()].join(', ')}`, parallel: true };
      try {
        const args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
        // Read-only calls that need no human decision can run concurrently.
        const parallel = tool.risk === 'read' && !needsApproval(tool, args, this.d.approvalMode(), cwd, this.d.policy?.());
        return { call, tool, args, parallel };
      } catch {
        return { call, error: `Invalid JSON arguments: ${call.arguments.slice(0, 300)}. Retry with valid JSON.`, parallel: true };
      }
    });

    const runOne = async (p: Prepared): Promise<{ output: string; isError: boolean; ms: number } | 'aborted'> => {
      const started = Date.now();
      if (p.error) return { output: p.error, isError: true, ms: 0 };
      const { call, tool, args } = p as Required<Pick<Prepared, 'call' | 'tool' | 'args'>>;
      const pre = await this.d.hooks?.preToolUse?.({ sessionId: this.id, tool: call.name, args, cwd });
      if (pre && pre.block) return { output: `Blocked by hook: ${pre.block}`, isError: true, ms: Date.now() - started };
      if (!p.parallel && needsApproval(tool, args, this.d.approvalMode(), cwd, this.d.policy?.()) && !this.alwaysAllowed().has(tool.name)) {
        const already = this.d.log.all().some((e) => e.type === 'approval/request' && e.callId === call.id);
        if (!already) this.emit({ type: 'approval/request', callId: call.id, name: call.name, arguments: call.arguments, risk: tool.risk });
        this.setStatus('awaiting_approval', undefined, call.name);
        const { decision, reason } = await this.d.requestApproval({ sessionId: this.id, callId: call.id, name: call.name, arguments: call.arguments, risk: tool.risk }, signal);
        if (signal.aborted) return 'aborted';
        this.emit({ type: 'approval/decision', callId: call.id, decision, ...(reason ? { reason } : {}) });
        this.setStatus('running');
        if (decision === 'deny') return { output: reason ?? 'The user denied this tool call. Do not retry it; ask or choose another approach.', isError: true, ms: Date.now() - started };
      }
      try {
        let output = await tool.execute(args, { cwd, sessionId: this.id, signal, services: this.d.services });
        const extra = await this.d.hooks?.postToolUse?.({ sessionId: this.id, tool: call.name, args, output, cwd });
        if (extra) output += `\n\n[hook] ${extra}`;
        return { output: this.guardUntrusted(tool, truncate(output)), isError: false, ms: Date.now() - started };
      } catch (e) {
        if (signal.aborted) return { output: '[Aborted by user]', isError: true, ms: Date.now() - started };
        return { output: `Error: ${(e as Error).message}`, isError: true, ms: Date.now() - started };
      }
    };

    const record = (p: Prepared, r: { output: string; isError: boolean; ms: number }) => {
      let output = r.output;
      if (r.isError) {
        const n = this.identicalFailures(p.call);
        if (n > 0) output += `\n\n[harness] This exact call (same tool, same arguments) has now failed ${n + 1} times. Do not send it again: change the arguments or the approach (re-read the file, use a different tool, or ask the user).`;
      }
      this.emit({ type: 'tool/result', callId: p.call.id, name: p.call.name, output, isError: r.isError, durationMs: r.ms });
    };

    let i = 0;
    while (i < prepared.length) {
      if (signal.aborted) return;
      if (prepared[i].parallel) {
        let j = i;
        while (j < prepared.length && prepared[j].parallel) j++;
        const batch = prepared.slice(i, j);
        const results = await pool(batch, this.d.config.maxParallelTools ?? 6, runOne);
        // Log in the model's order so the transcript is deterministic.
        batch.forEach((p, k) => results[k] !== 'aborted' && record(p, results[k] as { output: string; isError: boolean; ms: number }));
        if (signal.aborted) return;
        i = j;
      } else {
        const r = await runOne(prepared[i]);
        if (r === 'aborted') return;
        record(prepared[i], r);
        if (signal.aborted && r.output === '[Aborted by user]') return;
        i++;
      }
    }
  }

  /** Earlier failures of a call with the same tool and byte-identical arguments (derived from the log). */
  private identicalFailures(call: ToolCall): number {
    const failed = new Set<string>();
    const calls = new Map<string, ToolCall>();
    for (const e of this.d.log.all()) {
      if (e.type === 'assistant/message') for (const c of e.toolCalls) calls.set(c.id, c);
      else if (e.type === 'tool/result' && e.isError) failed.add(e.callId);
    }
    let n = 0;
    for (const id of failed) {
      const c = calls.get(id);
      if (c && id !== call.id && c.name === call.name && c.arguments === call.arguments) n++;
    }
    return n;
  }

  /** Wrap external content, scan it for prompt injection, and log the taint (model-visible means logged). */
  private guardUntrusted(tool: Tool, output: string): string {
    const cfg = this.d.config.taint;
    if (!cfg?.enabled || !(tool.untrusted || isUntrustedTool(tool.name, cfg))) return output;
    const findings = scanInjection(output);
    const first = !this.d.log.all().some((e) => e.type === 'context/taint');
    if (first || findings.length) this.emit({ type: 'context/taint', tool: tool.name, findings });
    return wrapUntrusted(tool.name, output, findings);
  }

  /** Files were edited since the last automatic verification in this session. */
  private editedSinceVerify(): boolean {
    const ev = this.d.log.all();
    for (let k = ev.length - 1; k >= 0; k--) {
      if (ev[k].type === 'verify/result') return false;
      if (ev[k].type === 'checkpoint') return true;
    }
    return false;
  }

  /** Done gate: run the project's verify commands; on failure, hand the output back to the model. */
  private async verifyGate(signal: AbortSignal, attempt: number): Promise<'passed' | 'failed' | 'skipped'> {
    const v = this.d.verify;
    if (!v || !this.editedSinceVerify()) return 'skipped';
    const commands = v.commands(this.cwd());
    if (!commands.length) return 'skipped';
    this.d.onLive?.({ kind: 'delta', sessionId: this.id, reasoning: `\n[verifying: ${commands.join(' && ')}]\n` });
    const out = await runVerify(this.cwd(), commands, v.timeoutMs, signal, v.sandbox?.());
    if (signal.aborted) return 'skipped';
    this.emit({ type: 'verify/result', passed: out.passed, results: out.results });
    if (out.passed) return 'passed';
    if (attempt > v.maxAttempts) return 'failed';
    const failed = out.results[out.results.length - 1];
    this.emit({
      type: 'user/message',
      source: 'verify',
      text: `[Automatic verification failed — attempt ${attempt} of ${v.maxAttempts}]\n$ ${failed.command}\n${failed.output}\nFix the cause (do not weaken or delete tests), then finish.`,
    });
    return 'failed';
  }

  /** Summarize older history into a context/compaction event when the context is too large (or forced). */
  private async maybeCompact(modelRef: string, signal: AbortSignal, force: boolean): Promise<void> {
    const events = this.d.log.all();
    const messages = deriveMessages(events);
    const { thresholdTokens, keepRecent } = this.d.config.compaction;
    const limit = this.d.contextLimit?.(modelRef) ?? thresholdTokens;
    if (!force && estimateTokens(messages) < limit) return;

    // Clean boundaries: points with no outstanding tool calls.
    const boundaries: number[] = [];
    let pending = 0;
    const lastCompaction = this.d.log.last('context/compaction')?.upToSeq ?? -1;
    for (const e of events) {
      if (e.type === 'assistant/message') {
        pending = e.toolCalls.length;
        if (!pending) boundaries.push(e.seq);
      } else if (e.type === 'tool/result') {
        pending = Math.max(0, pending - 1);
        if (!pending) boundaries.push(e.seq);
      }
    }
    const visible = events.filter((e) => e.type === 'user/message' || e.type === 'assistant/message' || e.type === 'tool/result');
    let cut = -1;
    for (const b of boundaries) {
      const after = visible.filter((e) => e.seq > b).length;
      if (b > lastCompaction && after >= Math.min(keepRecent, Math.floor(visible.length / 2))) cut = b;
    }
    if (cut < 0) return;

    const toSummarize = deriveMessages(events.filter((e) => e.seq <= cut || e.type === 'context/compaction'));
    const transcript = toSummarize
      .map((m) => {
        if (m.role === 'tool') return `TOOL RESULT (${m.name}): ${m.content.slice(0, 1500)}`;
        if (m.role === 'assistant')
          return `ASSISTANT: ${m.content}${m.toolCalls?.length ? `\nCALLS: ${m.toolCalls.map((c) => `${c.name}(${c.arguments.slice(0, 300)})`).join('; ')}` : ''}`;
        return `${m.role.toUpperCase()}: ${m.content}`;
      })
      .join('\n\n');
    // After a model switch, summarize with the previous model first: it could hold this history,
    // the new (possibly smaller) one may not. Fall back to the current model with a trimmed transcript.
    const lastCompactionEvent = this.d.log.last('context/compaction');
    const sw = this.d.log.last('model/switch');
    const candidates = sw && sw.seq > (lastCompactionEvent?.seq ?? -1) && sw.from && sw.from !== modelRef ? [sw.from, modelRef] : [modelRef];
    let lastError: unknown;
    for (const ref of candidates) {
      try {
        const { provider, model } = this.d.resolveModel(ref);
        const maxChars = Math.min(200_000, (this.d.contextLimit?.(ref) ?? 100_000) * 3);
        const resp = await provider.complete({
          model,
          system:
            'You compress agent transcripts. Write a dense, factual summary that lets the agent continue the task: goal, decisions, files touched, commands run and results, current state, open todos. No preamble.',
          messages: [{ role: 'user', content: transcript.slice(-maxChars) }],
          tools: [],
          signal,
        });
        this.emit({ type: 'context/compaction', summary: resp.text.trim(), upToSeq: cut, ...(ref !== modelRef ? { model: ref } : {}) });
        return;
      } catch (e) {
        lastError = e;
        if (signal.aborted) throw e;
      }
    }
    throw lastError;
  }
}

/** Map with at most `limit` calls in flight; results keep the input order. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const k = next++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}
