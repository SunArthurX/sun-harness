import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homePath } from './paths.js';

export interface WorktreeInfo {
  /** Main repository root the worktree belongs to. */
  repo: string;
  /** Worktree directory (the session cwd). */
  path: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
}

export interface WorktreeStatus {
  info: WorktreeInfo;
  exists: boolean;
  /** Uncommitted + committed changes vs base. */
  files: { status: string; path: string }[];
  insertions: number;
  deletions: number;
  commits: number;
}

function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  return (r.stdout ?? '').trim();
}

export function gitRoot(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

/** Create an isolated worktree on a new branch `sun/<sessionKey>` from the repo's HEAD. */
export function createWorktree(cwd: string, sessionKey: string): WorktreeInfo {
  const repo = gitRoot(cwd);
  if (!repo) throw new Error(`${cwd} is not inside a git repository; worktrees need git.`);
  const base = git(repo, ['rev-parse', 'HEAD'], true);
  if (!/^[0-9a-f]{40}$/.test(base)) throw new Error('The repository has no commits yet; commit once before using a worktree.');
  const branch = `sun/${sessionKey}`;
  const dir = homePath('worktrees');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${basename(repo)}-${sessionKey}`);
  git(repo, ['worktree', 'add', '-b', branch, path, base]);
  return { repo, path, branch, base };
}

/** Keep the agent's work as one commit on the branch (no-op when nothing changed). */
export function commitWorktree(info: WorktreeInfo, message: string): boolean {
  git(info.path, ['add', '-A']);
  if (!git(info.path, ['status', '--porcelain'])) return false;
  git(info.path, ['commit', '-q', '-m', message]);
  return true;
}

export function worktreeStatus(info: WorktreeInfo): WorktreeStatus {
  const exists = existsSync(info.path);
  if (!exists) return { info, exists, files: [], insertions: 0, deletions: 0, commits: 0 };
  // Include untracked files in the diff without staging them for real (intent-to-add).
  git(info.path, ['add', '-N', '.'], true);
  const files = git(info.path, ['diff', '--name-status', info.base], true)
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status, path: rest.join('\t') };
    });
  let insertions = 0;
  let deletions = 0;
  for (const l of git(info.path, ['diff', '--numstat', info.base], true).split('\n').filter(Boolean)) {
    const [a, d] = l.split('\t');
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }
  const commits = Number(git(info.path, ['rev-list', '--count', `${info.base}..HEAD`], true)) || 0;
  return { info, exists, files, insertions, deletions, commits };
}

export function worktreeDiff(info: WorktreeInfo): string {
  if (!existsSync(info.path)) return '';
  git(info.path, ['add', '-N', '.'], true);
  return git(info.path, ['diff', info.base], true);
}

/**
 * Bring the session's changes into the main checkout.
 * squash (default): staged in the main repo for you to review and commit; merge: a merge commit.
 * Refuses when the main checkout has uncommitted changes to the same files.
 */
export function mergeWorktree(info: WorktreeInfo, opts: { strategy?: 'squash' | 'merge'; message: string }): { strategy: string; output: string } {
  commitWorktree(info, opts.message);
  const strategy = opts.strategy ?? 'squash';
  const args = strategy === 'squash' ? ['merge', '--squash', info.branch] : ['merge', '--no-ff', '-m', opts.message, info.branch];
  const r = spawnSync('git', args, { cwd: info.repo, encoding: 'utf8' });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    spawnSync('git', ['merge', '--abort'], { cwd: info.repo });
    throw new Error(`Merge failed (main checkout unchanged): ${output.slice(0, 800)}`);
  }
  return { strategy, output };
}

/** Remove the worktree directory and its branch. */
export function removeWorktree(info: WorktreeInfo, opts: { keepBranch?: boolean } = {}): void {
  if (existsSync(info.path)) git(info.repo, ['worktree', 'remove', '--force', info.path], true);
  if (existsSync(info.path)) rmSync(info.path, { recursive: true, force: true });
  git(info.repo, ['worktree', 'prune'], true);
  if (!opts.keepBranch) git(info.repo, ['branch', '-D', info.branch], true);
}
