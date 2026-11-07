import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SessionLog } from '../src/index.js';
import { call, mockHost, tempHome } from './helpers.js';

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

  it('merge strategy creates a merge commit; discard removes branch and directory', async () => {
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
    host.discardWorktree(s2.id);
    expect(existsSync(wt.path)).toBe(false);
    expect(sh(main, 'branch', '--list', wt.branch)).toBe('');
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
});
