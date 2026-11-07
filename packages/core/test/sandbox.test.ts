import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SANDBOX, bwrapArgs, createSandbox, hostAllowed, needsApproval, secretEnvNames, startAllowlistProxy, type SandboxConfig } from '../src/index.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

const cfg = (patch: Partial<SandboxConfig> = {}): SandboxConfig => ({ ...structuredClone(DEFAULT_SANDBOX), ...patch });
const run = (shell: string, env: NodeJS.ProcessEnv, cwd: string) => spawnSync('bash', ['-c', shell], { cwd, env, encoding: 'utf8' });
const darwin = platform() === 'darwin' && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;

describe('sandbox policy pieces', () => {
  it('matches allowlist hosts with wildcards', () => {
    expect(hostAllowed('github.com', ['github.com'])).toBe(true);
    expect(hostAllowed('api.github.com', ['*.github.com'])).toBe(true);
    expect(hostAllowed('github.com', ['*.github.com'])).toBe(true);
    expect(hostAllowed('evilgithub.com', ['*.github.com'])).toBe(false);
    expect(hostAllowed('example.com', ['github.com'])).toBe(false);
  });

  it('collects secret env names from the config and credential-looking variables', () => {
    const names = secretEnvNames({ providers: { a: { apiKeyEnv: 'A_KEY' } }, bots: { telegram: { tokenEnv: 'TG' } } }, { FOO_API_KEY: 'x', PATH: '/bin', FOO_MODEL: 'm' });
    expect(names.sort()).toEqual(['A_KEY', 'FOO_API_KEY', 'TG']);
  });

  it('builds bubblewrap arguments: workspace writable, secrets hidden, network unshared when off', () => {
    const ws = tempWorkspace();
    const args = bwrapArgs(ws, cfg({ network: 'off' }));
    expect(args.slice(0, 3)).toEqual(['--ro-bind', '/', '/']);
    expect(args.join(' ')).toContain(`--bind ${spawnSync('realpath', [ws], { encoding: 'utf8' }).stdout.trim()}`);
    expect(args).toContain('--unshare-net');
    expect(bwrapArgs(ws, cfg({ network: 'on' }))).not.toContain('--unshare-net');
  });

  it('auto-approves sandboxed shell commands in auto-edit only when allowed', () => {
    const bash = { name: 'bash', risk: 'exec' } as any;
    expect(needsApproval(bash, { command: 'ls' }, 'auto-edit', '/w')).toBe(true);
    expect(needsApproval(bash, { command: 'ls' }, 'auto-edit', '/w', { sandboxedShell: true })).toBe(false);
    expect(needsApproval(bash, { command: 'ls' }, 'suggest', '/w', { sandboxedShell: true })).toBe(true);
  });
});

describe.runIf(darwin)('seatbelt sandbox (macOS)', () => {
  beforeEach(() => tempHome());

  it('allows workspace writes, blocks writes elsewhere, hides denied paths, scrubs secrets', () => {
    const ws = tempWorkspace();
    const secretDir = mkdtempSync(join(tmpdir(), 'sun-secret-'));
    writeFileSync(join(secretDir, 'key'), 'TOPSECRET');
    const sb = createSandbox({ mode: 'seatbelt', cfg: cfg({ denyRead: [secretDir] }), sessionId: 's1', cwd: ws, secretEnv: ['FOO_API_KEY'] });
    expect(sb.kind).toBe('seatbelt');
    const env = sb.env({ ...process.env, FOO_API_KEY: 'leak' });
    expect(run(sb.shell('echo hi > inside.txt && cat inside.txt', ws), env, ws).stdout.trim()).toBe('hi');
    const outside = join(homedir(), `.sun-sandbox-probe-${process.pid}`);
    const w = run(sb.shell(`echo x > ${outside}`, ws), env, ws);
    const leaked = existsSync(outside);
    if (leaked) rmSync(outside);
    expect(leaked).toBe(false);
    expect(w.stderr).toMatch(/Operation not permitted/);
    expect(run(sb.shell(`cat ${secretDir}/key`, ws), env, ws).stdout).not.toContain('TOPSECRET');
    expect(run(sb.shell('echo ${FOO_API_KEY:-none}', ws), env, ws).stdout.trim()).toBe('none');
  });

  it('denies outbound network when the policy is off but keeps loopback', () => {
    const ws = tempWorkspace();
    const sb = createSandbox({ mode: 'seatbelt', cfg: cfg({ network: 'off' }), sessionId: 's2', cwd: ws, secretEnv: [] });
    const probe = (host: string) =>
      run(sb.shell(`node -e "const s=require('net').connect(9,'${host}');s.on('error',e=>{console.log(e.code);process.exit(0)});s.on('connect',()=>{console.log('OPEN');process.exit(0)});setTimeout(()=>{console.log('TIMEOUT');process.exit(0)},1500)"`, ws), sb.env(process.env), ws).stdout.trim();
    expect(probe('10.255.255.1')).toBe('EPERM');
    expect(['ECONNREFUSED', 'OPEN']).toContain(probe('127.0.0.1'));
  });

  it('runs the bash tool and verify commands inside the session sandbox', async () => {
    const ws = tempWorkspace();
    const outside = join(homedir(), `.sun-sandbox-tool-${process.pid}`);
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('bash', { command: `echo x > ${outside}; echo done` })] }, { text: 'ok', toolCalls: [] }] }, { sandbox: cfg({ mode: 'seatbelt' }) });
    const s = host.createSession({ cwd: ws });
    await host.send(s.id, 'try');
    await host.wait(s.id);
    const leaked = existsSync(outside);
    if (leaked) rmSync(outside);
    expect(leaked).toBe(false);
    const out = (host.getEvents(s.id).find((e) => e.type === 'tool/result') as any).output;
    expect(out).toContain('Operation not permitted');
    const header = host.getEvents(s.id).find((e) => e.type === 'request/header') as any;
    expect(header.systemPrompt).toContain('Shell sandbox: seatbelt');
  });
});

describe('allowlist proxy', () => {
  it('forwards allowed hosts and refuses others', async () => {
    const upstream = createServer((_q, r) => r.end('upstream-ok'));
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const up = (upstream.address() as AddressInfo).port;
    const blocked: string[] = [];
    const { port, server } = await startAllowlistProxy(() => ['127.0.0.1'], (h) => blocked.push(h));
    const get = (url: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: url, method: 'GET' }, (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end();
      });
    expect(await get(`http://127.0.0.1:${up}/`)).toEqual({ status: 200, body: 'upstream-ok' });
    const denied = await get('http://blocked.invalid/');
    expect(denied.status).toBe(403);
    expect(blocked).toEqual(['blocked.invalid']);
    server.close();
    upstream.close();
  });
});

describe.runIf(process.env.SUN_TEST_DOCKER === '1')('docker sandbox', () => {
  it('runs commands in a per-session container with only the workspace mounted', () => {
    tempHome();
    const ws = tempWorkspace();
    const sb = createSandbox({ mode: 'docker', cfg: cfg({ network: 'off' }), sessionId: `t${process.pid}`, cwd: ws, secretEnv: [] });
    try {
      const r = run(sb.shell('echo in-container > c.txt; cat c.txt; ls /Users 2>&1 | head -1; cat /etc/os-release | head -1', ws), sb.env(process.env), ws);
      expect(r.stdout).toContain('in-container');
      expect(r.stdout).toMatch(/Debian|Ubuntu|Alpine/);
      expect(existsSync(join(ws, 'c.txt'))).toBe(true);
    } finally {
      sb.dispose?.();
    }
  }, 300_000);
});
