import type { HarnessHost } from './host.js';
import { SessionLog } from './log.js';
import { sessionMetrics } from './telemetry.js';
import { detectVerifyCommands, runVerify } from './verify.js';

export interface BestOfNOptions {
  cwd: string;
  prompt: string;
  n: number;
  /** Models to rotate through (candidate k uses models[k % length]); default: the configured model. */
  models?: string[];
  approval?: 'suggest' | 'auto-edit' | 'full-auto';
  /** Merge the winner into the main checkout (squash, staged) and discard the other worktrees. */
  apply?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onCandidate?: (c: Candidate) => void;
}

export interface Candidate {
  sessionId: string;
  model: string;
  status: string;
  /** Project verify commands in the candidate's worktree: true/false, or null when there are none. */
  verified: boolean | null;
  verifyOutput: string;
  changedLines: number;
  tokens: number;
}

export interface BestOfNResult {
  winner?: Candidate;
  candidates: Candidate[];
  applied: boolean;
}

function changedLines(diff: string): number {
  return diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length;
}

/**
 * Best-of-N: run the same task in N isolated worktrees in parallel, judge each with the project's own tests
 * (the verify commands), and keep the best: verified > finished cleanly > has changes > smallest diff > fewest tokens.
 */
export async function runBestOfN(host: HarnessHost, o: BestOfNOptions): Promise<BestOfNResult> {
  if (o.n < 1) throw new Error('n must be at least 1');
  const models = o.models?.length ? o.models : [host.config.defaultModel];
  const sessions = Array.from({ length: o.n }, (_, k) =>
    host.createSession({ cwd: o.cwd, mode: 'coding', worktree: true, model: models[k % models.length], approval: o.approval ?? 'full-auto', title: `[best-of-${o.n} #${k + 1}] ${o.prompt.slice(0, 40)}` }),
  );
  const abortAll = () => sessions.forEach((s) => host.abort(s.id));
  o.signal?.addEventListener('abort', abortAll, { once: true });
  const timer = o.timeoutMs ? setTimeout(abortAll, o.timeoutMs) : undefined;
  const candidates = await Promise.all(
    sessions.map(async (s, k): Promise<Candidate> => {
      await host.send(s.id, o.prompt, 'user', { noDetect: true });
      await host.wait(s.id);
      const log = SessionLog.open(s.id);
      const cwd = log.meta()!.cwd;
      const commands = detectVerifyCommands(cwd);
      const v = commands.length ? await runVerify(cwd, commands, host.config.verify?.timeoutMs ?? 300_000, undefined, host.sandboxFor(log)) : undefined;
      const m = sessionMetrics(log.all());
      const c: Candidate = {
        sessionId: s.id,
        model: models[k % models.length],
        status: log.status().status,
        verified: v ? v.passed : null,
        verifyOutput: v ? v.results.map((r) => `$ ${r.command}\n${r.output}`).join('\n').slice(-2000) : '',
        changedLines: changedLines(host.worktreeDiff(s.id)),
        tokens: m.inputTokens + m.outputTokens,
      };
      o.onCandidate?.(c);
      return c;
    }),
  );
  if (timer) clearTimeout(timer);
  const rank = (c: Candidate) => [c.verified === true ? 0 : c.verified === null ? 1 : 2, c.status === 'idle' ? 0 : 1, c.changedLines > 0 ? 0 : 1, c.changedLines, c.tokens];
  const sorted = [...candidates].sort((a, b) => {
    const x = rank(a);
    const y = rank(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i];
    return 0;
  });
  const winner = sorted[0]?.changedLines > 0 ? sorted[0] : undefined;
  let applied = false;
  if (o.apply && winner) {
    host.mergeWorktree(winner.sessionId);
    for (const c of candidates) if (c !== winner) host.discardWorktree(c.sessionId);
    applied = true;
  }
  return { winner, candidates: sorted, applied };
}
