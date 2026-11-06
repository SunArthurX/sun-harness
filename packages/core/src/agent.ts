import type { ApprovalMode, SunConfig } from './config.js';
import { SessionLog } from './log.js';
import { deriveMessages, estimateTokens, pendingToolCalls } from './messages.js';
import { needsApproval } from './policy.js';
import { ProviderError, type ModelResponse, type Provider } from './providers/types.js';
import { toSchema, truncate, type Tool, type ToolServices } from './tools/types.js';
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
    try {
      for (let step = 0; step < this.d.config.maxSteps; step++) {
        if (signal.aborted) return this.setStatus('aborted', 'user');

        const pending = pendingToolCalls(this.d.log.all());
        if (pending.length) {
          await this.executeTools(pending, signal);
          if (signal.aborted) return this.setStatus('aborted', 'user');
        }

        if (!this.owesRequest()) {
          const stopText = await this.d.hooks?.stop?.({ sessionId: this.id, cwd: this.cwd(), lastText: this.lastAssistantText() });
          if (stopText && stopContinues++ < 3) {
            this.emit({ type: 'user/message', text: stopText, source: 'hook' });
            continue;
          }
          return this.setStatus('idle');
        }

        const modelRef = this.d.log.currentModel();
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
    for (const call of calls) {
      if (signal.aborted) return;
      const started = Date.now();
      const result = (output: string, isError: boolean) =>
        this.emit({ type: 'tool/result', callId: call.id, name: call.name, output, isError, durationMs: Date.now() - started });

      const tool = tools.get(call.name);
      if (!tool) {
        result(`Unknown tool "${call.name}". Available: ${[...tools.keys()].join(', ')}`, true);
        continue;
      }
      let args: Record<string, unknown>;
      try {
        args = call.arguments?.trim() ? JSON.parse(call.arguments) : {};
      } catch {
        result(`Invalid JSON arguments: ${call.arguments.slice(0, 300)}. Retry with valid JSON.`, true);
        continue;
      }

      const pre = await this.d.hooks?.preToolUse?.({ sessionId: this.id, tool: call.name, args, cwd });
      if (pre && pre.block) {
        result(`Blocked by hook: ${pre.block}`, true);
        continue;
      }

      if (needsApproval(tool, args, this.d.approvalMode(), cwd) && !this.alwaysAllowed().has(tool.name)) {
        const already = this.d.log.all().some((e) => e.type === 'approval/request' && e.callId === call.id);
        if (!already) this.emit({ type: 'approval/request', callId: call.id, name: call.name, arguments: call.arguments, risk: tool.risk });
        this.setStatus('awaiting_approval', undefined, call.name);
        const { decision, reason } = await this.d.requestApproval(
          { sessionId: this.id, callId: call.id, name: call.name, arguments: call.arguments, risk: tool.risk },
          signal,
        );
        if (signal.aborted) return;
        this.emit({ type: 'approval/decision', callId: call.id, decision, ...(reason ? { reason } : {}) });
        this.setStatus('running');
        if (decision === 'deny') {
          result(reason ?? 'The user denied this tool call. Do not retry it; ask or choose another approach.', true);
          continue;
        }
      }

      try {
        let output = await tool.execute(args, { cwd, sessionId: this.id, signal, services: this.d.services });
        const extra = await this.d.hooks?.postToolUse?.({ sessionId: this.id, tool: call.name, args, output, cwd });
        if (extra) output += `\n\n[hook] ${extra}`;
        result(truncate(output), false);
      } catch (e) {
        if (signal.aborted) {
          result('[Aborted by user]', true);
          return;
        }
        result(`Error: ${(e as Error).message}`, true);
      }
    }
  }

  /** Summarize older history into a context/compaction event when the context is too large (or forced). */
  private async maybeCompact(modelRef: string, signal: AbortSignal, force: boolean): Promise<void> {
    const events = this.d.log.all();
    const messages = deriveMessages(events);
    const { thresholdTokens, keepRecent } = this.d.config.compaction;
    if (!force && estimateTokens(messages) < thresholdTokens) return;

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
    const { provider, model } = this.d.resolveModel(modelRef);
    const resp = await provider.complete({
      model,
      system:
        'You compress agent transcripts. Write a dense, factual summary that lets the agent continue the task: goal, decisions, files touched, commands run and results, current state, open todos. No preamble.',
      messages: [{ role: 'user', content: transcript.slice(-200_000) }],
      tools: [],
      signal,
    });
    this.emit({ type: 'context/compaction', summary: resp.text.trim(), upToSeq: cut });
  }
}
