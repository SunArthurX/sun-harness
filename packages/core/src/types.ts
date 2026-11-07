// ---------- Model messages (provider-neutral) ----------

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[]; reasoning?: string }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [k: string]: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

// ---------- Session events (durable, append-only) ----------

export type RunStatus = 'idle' | 'running' | 'awaiting_approval' | 'paused' | 'error' | 'aborted';

export type PauseReason = 'quota' | 'auth' | 'rate_limit' | 'network' | 'user' | 'max_steps' | 'interrupted';

export interface EventBase {
  seq: number;
  ts: string;
}

export type SessionEventBody =
  | {
      type: 'session/meta';
      id: string;
      title: string;
      mode: string;
      cwd: string;
      model: string;
      createdAt: string;
      /** Set for subagent sessions. */
      parent?: string;
      /** Set when the session runs in an isolated git worktree (specs/010). */
      worktree?: { repo: string; path: string; branch: string; base: string };
    }
  | { type: 'session/title'; title: string }
  | { type: 'user/message'; text: string; source?: 'user' | 'hook' | 'schedule' | 'system' | 'job' }
  | { type: 'request/header'; model: string; systemPrompt: string; tools: string[] }
  | {
      type: 'assistant/message';
      text: string;
      reasoning?: string;
      toolCalls: ToolCall[];
      usage?: Usage;
      model: string;
    }
  | { type: 'tool/result'; callId: string; name: string; output: string; isError: boolean; durationMs?: number }
  | { type: 'approval/request'; callId: string; name: string; arguments: string; risk: ToolRisk }
  | { type: 'approval/decision'; callId: string; decision: ApprovalDecision; reason?: string }
  | { type: 'run/status'; status: RunStatus; reason?: PauseReason | string; detail?: string }
  | { type: 'model/switch'; from: string; to: string; reason: string }
  | { type: 'mode/switch'; from: string; to: string }
  | { type: 'context/compaction'; summary: string; upToSeq: number; /** Summarizer model when it differs from the session model. */ model?: string }
  | { type: 'todo/update'; items: TodoItem[] }
  | { type: 'worktree/closed'; action: 'merged' | 'discarded'; detail?: string }
  | { type: 'job/started'; jobId: string; name: string; command: string }
  | { type: 'job/finished'; jobId: string; name: string; state: 'done' | 'failed' | 'killed' | 'lost'; exitCode?: number };

export type SessionEvent = EventBase & SessionEventBody;

export type ApprovalDecision = 'allow' | 'deny' | 'allow_always';

export type ToolRisk = 'read' | 'write' | 'exec' | 'network';

export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'done' | 'cancelled';
}

export interface SessionSummary {
  id: string;
  title: string;
  mode: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  status: RunStatus;
  statusReason?: string;
  statusDetail?: string;
  parent?: string;
  worktree?: { repo: string; branch: string; closed?: 'merged' | 'discarded' };
}

export interface PendingApproval {
  callId: string;
  /** Session that owns the tool call. */
  sessionId: string;
  /** Session where the UI should surface it (the parent for subagents). */
  displaySessionId: string;
  name: string;
  arguments: string;
  risk: ToolRisk;
}

// ---------- Streaming deltas (live, not persisted) ----------

export type LiveEvent =
  | { kind: 'event'; sessionId: string; event: SessionEvent }
  | { kind: 'delta'; sessionId: string; text?: string; reasoning?: string }
  | { kind: 'sessions'; sessions: SessionSummary[] }
  | { kind: 'approvals'; approvals: PendingApproval[] }
  | { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string };
