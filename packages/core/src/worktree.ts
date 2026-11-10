import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { homePath } from './paths.js';
import type { ReviewChange } from './review.js';

export interface WorktreeInfo {
  /** Main repository root the worktree belongs to. */
  repo: string;
  /** Worktree directory (the session cwd). */
  path: string;
  branch: string;
  /** Commit the branch started from. */
  base: string;
  repositoryIdentity?: string;
  worktreeIdentity?: string;
  targetRef?: string;
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

export type WorktreeState = 'ready' | 'dirty' | 'active' | 'unowned' | 'missing' | 'closed' | 'recovery';
export type WorktreeSetupState = 'not-started' | 'running' | 'completed' | 'failed' | 'interrupted' | 'acknowledged';
export interface WorktreeInventoryItem {
  id: string;
  path: string;
  repo?: string;
  branch?: string;
  base?: string;
  head?: string;
  identity?: string;
  state: WorktreeState;
  setup?: WorktreeSetupState;
}
export interface WorktreeCleanupPreview {
  revision: string;
  items: WorktreeInventoryItem[];
}
export interface WorktreeCleanupResult {
  removed: { id: string; branchKept: boolean }[];
  blocked: string[];
}

function gitCommand(cwd: string, args: string[], index?: string) {
  const env = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[name];
  if (index) env.GIT_INDEX_FILE = index;
  return spawnSync('git', ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`,
    ...(index ? ['-c', 'core.splitIndex=false'] : []), ...args], {
    cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

function gitRaw(cwd: string, args: string[], allowFail = false, index?: string): string {
  const r = gitCommand(cwd, args, index);
  if (r.status !== 0 && !allowFail) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout || '').trim().slice(0, 500)}`);
  return r.stdout ?? '';
}

function git(cwd: string, args: string[], allowFail = false): string {
  return gitRaw(cwd, args, allowFail).trim();
}

export function gitRoot(cwd: string): string | undefined {
  return git(cwd, ['rev-parse', '--show-toplevel'], true) || undefined;
}

const commitHash = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const commonDirectory = (cwd: string) => realpathSync(resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir'])));
const branchRef = (cwd: string) => git(cwd, ['symbolic-ref', '-q', 'HEAD'], true);
function directoryIdentity(directory: string): string {
  const stat = statSync(directory, { bigint: true });
  return `${directory}\0${stat.dev}:${stat.ino}`;
}

export function assertWorktreeOwned(info: WorktreeInfo): void {
  const root = realpathSync(homePath('worktrees'));
  const path = realpathSync(info.path);
  if (dirname(path) !== root || !info.branch.startsWith('sun/') || !commitHash.test(info.base)
    || gitRoot(info.path) !== path || gitRoot(info.repo) !== realpathSync(info.repo) || path === realpathSync(info.repo)) {
    throw new Error('WORKTREE_UNOWNED: The workspace no longer matches the managed worktree.');
  }
  const repository = commonDirectory(info.repo);
  const admin = realpathSync(git(info.path, ['rev-parse', '--absolute-git-dir']));
  if (repository !== commonDirectory(info.path) || dirname(admin) !== join(repository, 'worktrees')
    || (info.repositoryIdentity && directoryIdentity(repository) !== info.repositoryIdentity)
    || (info.worktreeIdentity && directoryIdentity(path) !== info.worktreeIdentity)
    || branchRef(info.path) !== `refs/heads/${info.branch}`
    || realpathSync(readFileSync(join(admin, 'gitdir'), 'utf8').trim()) !== join(path, '.git')) {
    throw new Error('WORKTREE_UNOWNED: The repository no longer owns the recorded branch and worktree.');
  }
}

function withSnapshot<T>(info: WorktreeInfo, inspect: (diff: (args?: string[], path?: string) => string) => T): T {
  assertWorktreeOwned(info);
  const temp = mkdtempSync(join(tmpdir(), 'sun-worktree-index-'));
  try {
    const index = join(temp, 'index');
    const source = resolve(info.path, git(info.path, ['rev-parse', '--git-path', 'index']));
    if (existsSync(source)) copyFileSync(source, index);
    else gitRaw(info.path, ['read-tree', 'HEAD'], false, index);
    gitRaw(info.path, ['add', '-N', '-A', '--'], false, index);
    return inspect((args = [], path) => gitRaw(info.path, [
      'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', ...args,
      info.base, '--', ...(path === undefined ? [] : [path]),
    ], false, index));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function changedFiles(diff: (args: string[]) => string): WorktreeStatus['files'] {
  const fields = diff(['--name-status', '-z']).split('\0');
  const files: WorktreeStatus['files'] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) files.push({ status: fields[i], path: fields[i + 1] });
  return files;
}

export function createWorktree(cwd: string, sessionKey: string, baseRef = 'HEAD'): WorktreeInfo {
  const repo = gitRoot(cwd);
  if (!repo) throw new Error(`${cwd} is not inside a git repository; worktrees need git.`);
  if (typeof baseRef !== 'string' || !/^[^-\s\0][^\s\0]{0,255}$/.test(baseRef)) throw new Error('WORKTREE_INVALID_BASE: Choose a Git ref or commit.');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(sessionKey)) throw new Error('Invalid worktree key.');
  const base = git(repo, ['rev-parse', '--verify', `${baseRef}^{commit}`], true);
  if (!commitHash.test(base)) throw new Error('WORKTREE_INVALID_BASE: The selected base does not resolve to a commit.');
  const identity = directoryIdentity(commonDirectory(repo));
  const targetRef = branchRef(repo);
  const dir = homePath('worktrees');
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = attempt ? `${sessionKey}-${attempt}` : sessionKey;
    const branch = `sun/${key}`;
    const path = join(dir, `${basename(repo)}-${key}`);
    const collides = () => !!lstatSync(path, { throwIfNoEntry: false })
      || gitCommand(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).status === 0;
    if (collides()) continue;
    const result = gitCommand(repo, ['worktree', 'add', '-b', branch, path, base]);
    if (result.status === 0) return {
      repo, path, branch, base, repositoryIdentity: identity, targetRef, worktreeIdentity: directoryIdentity(realpathSync(path)),
    };
    if (!collides()) throw new Error(`WORKTREE_CREATE_FAILED: ${(result.stderr || result.error?.message || '').trim().slice(0, 500)}`);
  }
  throw new Error('WORKTREE_NAME_COLLISION: No free managed branch and path were found.');
}

/** Keep the agent's work as one commit on the branch (no-op when nothing changed). */
export function commitWorktree(info: WorktreeInfo, message: string): boolean {
  assertWorktreeOwned(info);
  git(info.path, ['add', '-A']);
  if (!git(info.path, ['status', '--porcelain'])) return false;
  git(info.path, ['commit', '-q', '-m', message]);
  return true;
}

function changesIn(cwd: string, includeIgnored: boolean): string {
  return gitRaw(cwd, ['status', '--porcelain', '--untracked-files=all', '-z', ...(includeIgnored ? ['--ignored'] : [])]);
}

export function worktreeSafety(info: WorktreeInfo): { head: string; dirty: boolean; identity: string } {
  assertWorktreeOwned(info);
  return { head: git(info.path, ['rev-parse', 'HEAD']), dirty: !!changesIn(info.path, true),
    identity: createHash('sha256').update(directoryIdentity(realpathSync(info.path))).digest('hex') };
}

export function worktreeStatus(info: WorktreeInfo): WorktreeStatus {
  const exists = existsSync(info.path);
  if (!exists) return { info, exists, files: [], insertions: 0, deletions: 0, commits: 0 };
  return withSnapshot(info, diff => {
    let insertions = 0;
    let deletions = 0;
    for (const line of diff(['--numstat', '-z']).split('\0').filter(Boolean)) {
      const [a, d] = line.split('\t');
      insertions += Number(a) || 0;
      deletions += Number(d) || 0;
    }
    const commits = Number(git(info.path, ['rev-list', '--count', `${info.base}..HEAD`])) || 0;
    return { info, exists, files: changedFiles(diff), insertions, deletions, commits };
  });
}

export function worktreeDiff(info: WorktreeInfo): string {
  if (!existsSync(info.path)) return '';
  return withSnapshot(info, diff => diff().trimEnd());
}

export function worktreeReviewChanges(info: WorktreeInfo): ReviewChange[] {
  return withSnapshot(info, diff => changedFiles(diff).map(file => {
    const abs = join(info.path, file.path);
    const contents = diff([], file.path);
    const fileStat = lstatSync(abs, { throwIfNoEntry: false });
    let omission: ReviewChange['omission'];
    let contentDigest: string | undefined;
    if (fileStat?.isSymbolicLink()) {
      contentDigest = createHash('sha256').update(readlinkSync(abs)).digest('hex');
      omission = 'no-text-diff';
    } else if (fileStat?.isFile()) {
      contentDigest = git(info.path, ['hash-object', '--no-filters', '--', file.path]);
    }
    if (/^Binary files .* differ$/m.test(contents)) omission = 'binary';
    else if (!/^@@ /m.test(contents)) omission = 'no-text-diff';
    return {
      path: file.path, status: file.status === 'A' ? 'added' : file.status === 'D' ? 'deleted' : 'modified',
      diff: contents, contentDigest, omission,
    };
  }));
}

/**
 * Bring the session's changes into the main checkout.
 * squash (default): staged in the main repo for you to review and commit; merge: a merge commit.
 * Requires a clean destination. The source branch retains the candidate commit on failure.
 */
export function mergeWorktree(info: WorktreeInfo, opts: { strategy?: 'squash' | 'merge'; message: string }): { strategy: string; output: string } {
  const strategy = opts.strategy ?? 'squash';
  if (strategy !== 'squash' && strategy !== 'merge') throw new Error('WORKTREE_INVALID_STRATEGY');
  assertWorktreeOwned(info);
  const target = branchRef(info.repo);
  if (!target || (info.targetRef !== undefined && target !== info.targetRef)) throw new Error('WORKTREE_TARGET_CHANGED: Switch to the recorded destination branch.');
  const original = git(info.repo, ['rev-parse', 'HEAD']);
  const clean = () => !changesIn(info.repo, false) && !git(info.repo, ['rev-parse', '--verify', 'MERGE_HEAD'], true)
    && !['CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-apply', 'rebase-merge', 'sequencer'].some(name =>
      existsSync(resolve(info.repo, git(info.repo, ['rev-parse', '--git-path', name]))));
  if (!clean()) throw new Error('WORKTREE_TARGET_DIRTY: Finish or set aside existing checkout changes before merging.');
  commitWorktree(info, opts.message);
  if (branchRef(info.repo) !== target || git(info.repo, ['rev-parse', 'HEAD']) !== original || !clean()) {
    throw new Error('WORKTREE_TARGET_CHANGED: The destination changed while preparing the candidate.');
  }
  const source = git(info.path, ['rev-parse', 'HEAD']);
  const args = strategy === 'squash' ? ['--squash'] : ['--no-ff', '-m', opts.message];
  const r = gitCommand(info.repo, ['merge', '--no-overwrite-ignore', ...args, source]);
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  if (r.status !== 0) {
    const unchangedHead = () => branchRef(info.repo) === target && git(info.repo, ['rev-parse', 'HEAD']) === original;
    if (unchangedHead() && gitRaw(info.repo, ['ls-files', '-u', '-z'])) {
      if (git(info.repo, ['rev-parse', '--verify', 'MERGE_HEAD'], true)) git(info.repo, ['merge', '--abort'], true);
      else git(info.repo, ['reset', '--merge', original], true);
    }
    const restored = unchangedHead() && clean();
    throw new Error(`${restored ? 'WORKTREE_MERGE_FAILED' : 'WORKTREE_MERGE_RECOVERY'}: ${restored ? 'The destination is clean.' : 'Inspect Git state in the destination before retrying.'} The candidate branch was kept. ${output.slice(0, 500)}`);
  }
  return { strategy, output };
}

export function removeWorktree(info: WorktreeInfo, opts: { keepBranch?: boolean } = {}): { branchKept: boolean } {
  const { dirty, head } = worktreeSafety(info);
  if (dirty) throw new Error('WORKTREE_DIRTY: Commit or move the worktree files before removing it.');
  git(info.repo, ['worktree', 'remove', '--', info.path]);
  const target = info.targetRef ?? branchRef(info.repo);
  if (!opts.keepBranch && target && gitCommand(info.repo, ['merge-base', '--is-ancestor', head, target]).status === 0
    && git(info.repo, ['rev-parse', '--verify', `refs/heads/${info.branch}`], true) === head) {
    git(info.repo, ['branch', '-d', '--', info.branch], true);
  }
  return { branchKept: gitCommand(info.repo, ['show-ref', '--verify', '--quiet', `refs/heads/${info.branch}`]).status === 0 };
}
