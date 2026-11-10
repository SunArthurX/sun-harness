import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HarnessHost, MockProvider, SessionLog, createWorktree, homePath } from '../src/index.js';
import { holdDataActivity } from '../src/settings/storage-lock.js';
import { call, mockHost, tempHome, testConfig } from './helpers.js';

function sh(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sun-repo-'));
  sh(dir, 'init', '-q');
  sh(dir, 'config', 'user.email', 'test@example.com');
  sh(dir, 'config', 'user.name', 'Test');
  writeFileSync(join(dir, 'README.md'), '# demo\n');
  writeFileSync(join(dir, 'AGENTS.md'), 'WORKTREE-RULE\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

describe('git worktree sessions', () => {
  beforeEach(() => tempHome());

  it('isolates edits on a branch, reports status/diff, and squash-merges into the main checkout', async () => {
    const main = repo();
    const { host, providers } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'README.md' }), call('write_file', { path: 'feature.txt', content: 'new feature\n' }), call('edit_file', { path: 'README.md', old_string: '# demo', new_string: '# demo v2' })] },
        { text: 'done', toolCalls: [] },
      ],
    });
    const s = host.createSession({ cwd: main, worktree: true });
    const meta = SessionLog.open(s.id).meta()!;
    expect(meta.worktree?.branch).toMatch(/^sun\//);
    expect(s.cwd).toBe(meta.worktree!.path);
    expect(s.worktree).toMatchObject({ repo: meta.worktree!.repo });

    await host.send(s.id, 'add a feature');
    await host.wait(s.id);
    // Rules come from the worktree checkout.
    expect(providers.get('mock/a')!.requests[0].system).toContain('WORKTREE-RULE');
    // The main checkout is untouched while the session works.
    expect(existsSync(join(main, 'feature.txt'))).toBe(false);
    expect(readFileSync(join(main, 'README.md'), 'utf8')).toBe('# demo\n');

    const st = host.worktreeStatus(s.id);
    expect(st.files.map((f) => f.path).sort()).toEqual(['README.md', 'feature.txt']);
    expect(st.insertions).toBe(2);
    expect(host.worktreeDiff(s.id)).toContain('+new feature');

    const r = host.mergeWorktree(s.id);
    expect(r.strategy).toBe('squash');
    expect(readFileSync(join(main, 'feature.txt'), 'utf8')).toBe('new feature\n');
    expect(sh(main, 'status', '--porcelain')).toContain('feature.txt');
    expect(existsSync(meta.worktree!.path)).toBe(false);
    // The branch is kept until the squashed changes are committed.
    expect(sh(main, 'branch', '--list', meta.worktree!.branch)).toContain(meta.worktree!.branch);
    expect(host.listSessions().find((x) => x.id === s.id)?.worktree?.closed).toBe('merged');
    await expect(host.send(s.id, 'more')).rejects.toThrow(/merged/);
  });

  it('creates a merge commit and preserves a dirty worktree and its unmerged branch', async () => {
    const main = repo();
    const { host } = await mockHost({
      'mock/a': [{ text: '', toolCalls: [call('write_file', { path: 'a.txt', content: 'A' })] }, { text: 'ok', toolCalls: [] }, { text: '', toolCalls: [call('write_file', { path: 'b.txt', content: 'B' })] }, { text: 'ok', toolCalls: [] }],
    });
    const s1 = host.createSession({ cwd: main, worktree: true });
    await host.send(s1.id, 'a');
    await host.wait(s1.id);
    host.mergeWorktree(s1.id, { strategy: 'merge' });
    expect(sh(main, 'log', '--oneline', '-1')).toMatch(/Merge|sun:/);
    expect(readFileSync(join(main, 'a.txt'), 'utf8')).toBe('A');

    const s2 = host.createSession({ cwd: main, worktree: true });
    const wt = SessionLog.open(s2.id).meta()!.worktree!;
    await host.send(s2.id, 'b');
    await host.wait(s2.id);
    expect(() => host.discardWorktree(s2.id)).toThrow(/WORKTREE_DIRTY/);
    expect(readFileSync(join(wt.path, 'b.txt'), 'utf8')).toBe('B');
    sh(wt.path, 'add', 'b.txt');
    sh(wt.path, 'commit', '-qm', 'Candidate to keep');
    expect(host.discardWorktree(s2.id)).toEqual({ branchKept: true });
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(main, 'branch', '--list', wt.branch)).toContain(wt.branch);
    expect(existsSync(join(main, 'b.txt'))).toBe(false);
  });

  it('two sessions edit the same file in parallel without interfering', async () => {
    const main = repo();
    const { host } = await mockHost({
      'mock/a': [
        { text: '', toolCalls: [call('read_file', { path: 'README.md' }), call('write_file', { path: 'README.md', content: 'one\n' })] },
        { text: '', toolCalls: [call('read_file', { path: 'README.md' }), call('write_file', { path: 'README.md', content: 'two\n' })] },
        { text: 'ok', toolCalls: [] },
        { text: 'ok', toolCalls: [] },
      ],
    });
    const a = host.createSession({ cwd: main, worktree: true });
    const b = host.createSession({ cwd: main, worktree: true });
    await Promise.all([host.send(a.id, 'x'), host.send(b.id, 'y')]);
    await Promise.all([host.wait(a.id), host.wait(b.id)]);
    const contents = [readFileSync(join(a.cwd, 'README.md'), 'utf8'), readFileSync(join(b.cwd, 'README.md'), 'utf8')].sort();
    expect(contents).toEqual(['one\n', 'two\n']);
    expect(readFileSync(join(main, 'README.md'), 'utf8')).toBe('# demo\n');
  });

  it('refuses worktrees outside git repos', async () => {
    const { host } = await mockHost({});
    expect(() => host.createSession({ cwd: mkdtempSync(join(tmpdir(), 'nogit-')), worktree: true })).toThrow(/not inside a git repository/);
  });

  it('reviews Git changes without checkpoints and leaves the real index untouched', async () => {
    const main = repo();
    const finding = { id: 'fixture', path: 'flag[dev].txt', severity: 'medium', startLine: 1, endLine: 1,
      title: 'Disabled flag', explanation: 'The flag is always disabled.', evidence: 'enabled=false' };
    const { host, providers } = await mockHost({
      'mock/a': [{ text: JSON.stringify({ findings: [finding] }), toolCalls: [] }],
    });
    const s = host.createSession({ cwd: main, worktree: true });
    const file = join(s.cwd, 'flag[dev].txt');
    const index = resolve(s.cwd, sh(s.cwd, 'rev-parse', '--git-path', 'index'));
    const before = readFileSync(index);
    writeFileSync(file, 'enabled=false\n');
    expect(host.worktreeStatus(s.id).files).toContainEqual({ status: 'A', path: 'flag[dev].txt' });
    expect(host.worktreeDiff(s.id)).toContain('+enabled=false');
    expect(host.sessionChanges(s.id)).toEqual([]);
    expect(await host.reviewSession(s.id)).toContain('Disabled flag');
    expect(host.reviewStatus(s.id)).toMatchObject({ state: 'findings', report: { findings: [finding] } });
    expect(readFileSync(index)).toEqual(before);
    expect(providers.get('mock/a')!.requests).toHaveLength(1);
    expect(sh(s.cwd, 'status', '--porcelain')).toContain('?? flag[dev].txt');
    writeFileSync(file, 'enabled=true\n');
    expect(host.reviewStatus(s.id).state).toBe('stale');
  });

  it('uses an explicit base and bounds branch name collisions', async () => {
    const main = repo();
    const original = sh(main, 'rev-parse', 'HEAD');
    sh(main, 'tag', 'baseline');
    mkdirSync(join(main, 'new'));
    writeFileSync(join(main, 'new', 'file'), 'new');
    sh(main, 'add', '-A');
    sh(main, 'commit', '-qm', 'Later');
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: join(main, 'new'), worktree: true, worktreeBase: 'baseline' });
    expect(host.worktreeStatus(s.id).info.base).toBe(original);
    expect(existsSync(join(s.cwd, 'new'))).toBe(false);
    expect(() => createWorktree(main, 'base-test', '--help')).toThrow(/WORKTREE_INVALID_BASE/);
    sh(main, 'branch', 'sun/collision');
    expect(createWorktree(main, 'collision').branch).toBe('sun/collision-1');
    for (let i = 0; i < 5; i++) sh(main, 'branch', `sun/busy${i ? `-${i}` : ''}`);
    expect(() => createWorktree(main, 'busy')).toThrow(/WORKTREE_NAME_COLLISION/);
  });

  it.each(['squash', 'merge'] as const)('recovers a %s conflict without losing either branch', async strategy => {
    const main = repo();
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: main, worktree: true });
    const wt = SessionLog.open(s.id).meta()!.worktree!;
    writeFileSync(join(wt.path, 'README.md'), 'candidate\n');
    writeFileSync(join(main, 'README.md'), 'destination\n');
    sh(main, 'commit', '-qam', 'Destination');
    const destination = sh(main, 'rev-parse', 'HEAD');
    expect(() => host.mergeWorktree(s.id, { strategy })).toThrow(/WORKTREE_MERGE_FAILED/);
    expect(sh(main, 'rev-parse', 'HEAD')).toBe(destination);
    expect(sh(main, 'status', '--porcelain')).toBe('');
    expect(sh(main, 'show', `${wt.branch}:README.md`)).toBe('candidate');
    expect(readFileSync(join(wt.path, 'README.md'), 'utf8')).toBe('candidate\n');
  }, 15_000);

  it('rejects stale cleanup, live descendants, dirty destinations, and replaced worktrees', async () => {
    const main = repo();
    const { host } = await mockHost({});
    const s = host.createSession({ cwd: main, worktree: true });
    const preview = host.previewWorktreeCleanup([s.id]);
    expect(preview.items[0].state).toBe('ready');
    const child = host.createSession({ cwd: s.cwd, parent: s.id });
    const release = holdDataActivity(`session:${child.id}`);
    try {
      expect(() => host.discardWorktree(s.id)).toThrow(/WORKTREE_ACTIVE/);
      expect(() => host.cleanupWorktrees([s.id], preview.revision)).toThrow(/WORKTREE_PREVIEW_STALE/);
    } finally { release(); }
    writeFileSync(join(main, 'untracked'), 'preserve destination');
    expect(() => host.mergeWorktree(s.id)).toThrow(/WORKTREE_TARGET_DIRTY/);
    expect(readFileSync(join(main, 'untracked'), 'utf8')).toBe('preserve destination');
    writeFileSync(join(s.cwd, 'untracked'), 'preserve source');
    expect(() => host.cleanupWorktrees([s.id], preview.revision)).toThrow(/WORKTREE_PREVIEW_STALE/);
    expect(readFileSync(join(s.cwd, 'untracked'), 'utf8')).toBe('preserve source');
    const other = host.createSession({ cwd: main, worktree: true });
    const clean = host.previewWorktreeCleanup([other.id]);
    expect(host.cleanupWorktrees([other.id], clean.revision).removed).toEqual([{ id: other.id, branchKept: false }]);
    expect(existsSync(other.cwd)).toBe(false);
    renameSync(s.cwd, `${s.cwd}-moved`);
    mkdirSync(s.cwd);
    writeFileSync(join(s.cwd, 'unrelated'), 'preserve replacement');
    expect(host.worktreeInventory().find(item => item.id === s.id)?.state).toBe('unowned');
    expect(() => host.discardWorktree(s.id)).toThrow(/WORKTREE_UNOWNED/);
    expect(readFileSync(join(s.cwd, 'unrelated'), 'utf8')).toBe('preserve replacement');
  }, 20_000);

  it('runs a reviewed setup once and reconciles a started marker after a restart', async () => {
    const main = repo();
    const provider = new MockProvider();
    const options = { config: testConfig(), connectMcp: false, loadPlugins: false, providerFactory: () => ({ provider, model: 'fixture' }) };
    const host = new HarnessHost(options);
    const s = host.createSession({ cwd: main, worktree: true, sandbox: 'off' });
    mkdirSync(join(s.cwd, '.sun'));
    const hookFile = join(s.cwd, '.sun', 'hooks.json');
    writeFileSync(hookFile, JSON.stringify({ sessionStart: [{ id: 'setup', worktreeSetup: true, command: 'printf x >> setup.txt' }] }));
    const [hook] = host.listHooks(s.cwd).hooks;
    expect(hook.worktreeSetup).toBe(true);
    await expect(host.runWorktreeSetup(s.id, hook.id, hook.digest)).rejects.toThrow(/WORKTREE_SETUP_UNTRUSTED/);
    host.reviewHooks(s.cwd, [{ id: hook.id, digest: hook.digest, trust: true }]);
    await host.send(s.id, 'ordinary turn');
    await host.wait(s.id);
    expect(existsSync(join(s.cwd, 'setup.txt'))).toBe(false);
    expect(await host.runWorktreeSetup(s.id, hook.id, hook.digest)).toBe('completed');
    expect(readFileSync(join(s.cwd, 'setup.txt'), 'utf8')).toBe('x');
    await expect(host.runWorktreeSetup(s.id, hook.id, hook.digest)).rejects.toThrow(/WORKTREE_SETUP_ALREADY_DISPATCHED/);
    const interrupted = host.createSession({ cwd: main, worktree: true, sandbox: 'off' });
    SessionLog.open(interrupted.id).append({ type: 'worktree/setup', state: 'started', hookId: hook.id, digest: hook.digest }, true);
    await host.dispose();
    const restarted = new HarnessHost(options);
    expect(restarted.worktreeInventory().find(item => item.id === interrupted.id)).toMatchObject({ setup: 'interrupted', state: 'recovery' });
    expect(() => restarted.discardWorktree(interrupted.id)).toThrow(/WORKTREE_RECOVERY_REQUIRED/);
    await expect(restarted.send(interrupted.id, 'Continue')).rejects.toThrow(/WORKTREE_RECOVERY_REQUIRED/);
    restarted.acknowledgeWorktreeRecovery(interrupted.id);
    expect(restarted.worktreeInventory().find(item => item.id === interrupted.id)?.setup).toBe('acknowledged');
    await expect(restarted.runWorktreeSetup(interrupted.id, hook.id, hook.digest)).rejects.toThrow(/WORKTREE_SETUP_ALREADY_DISPATCHED/);
    await restarted.dispose();
  }, 20_000);

  it('protects a running job and a replacement checkout registered on the same branch', async () => {
    const main = repo();
    const { host } = await mockHost({});
    const session = host.createSession({ cwd: main, worktree: true });
    const info = SessionLog.open(session.id).meta()!.worktree!;
    const job = host.jobs.startProcess(session.id, 'sleep 20', session.cwd);
    try {
      expect(() => host.discardWorktree(session.id)).toThrow(/WORKTREE_ACTIVE/);
    } finally {
      host.killJob(job.id);
      await host.dispose();
    }
    await vi.waitFor(() => expect(host.previewWorktreeCleanup([session.id]).items[0].state).toBe('ready'), { timeout: 5000 });
    const preview = host.previewWorktreeCleanup([session.id]);
    const moved = `${info.path}-external`;
    sh(main, 'worktree', 'move', info.path, moved);
    sh(moved, 'checkout', '--detach', info.base);
    sh(main, 'worktree', 'add', info.path, info.branch);
    expect(host.worktreeInventory().find(item => item.id === session.id)?.state).toBe('unowned');
    expect(() => host.cleanupWorktrees([session.id], preview.revision)).toThrow(/WORKTREE_PREVIEW_STALE/);
    expect(existsSync(join(info.path, 'README.md'))).toBe(true);
  }, 15_000);
});
