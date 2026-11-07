import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { homedir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { CREDENTIAL_NAME, RC_FILES } from './env.js';
import { ensureDir, homePath, sunHome } from './paths.js';

export type SandboxMode = 'off' | 'auto' | 'seatbelt' | 'bwrap' | 'docker';
export type NetworkPolicy = 'on' | 'off' | 'allowlist';

export interface SandboxConfig {
  mode: SandboxMode;
  network: NetworkPolicy;
  /** Hosts reachable when network is "allowlist": "github.com", "*.npmjs.org". */
  allow: string[];
  /** Extra writable paths (besides the workspace, temp dirs, and package caches). */
  writable: string[];
  /** Paths sandboxed commands may not read (credentials). */
  denyRead: string[];
  /** Remove the environment variables that hold sun-harness's own secrets (provider keys, bot tokens). */
  scrubEnv: boolean;
  /** In auto-edit approval, run sandboxed shell commands without asking. */
  autoApprove: boolean;
  docker: { image: string };
}

export const DEFAULT_SANDBOX: SandboxConfig = {
  mode: 'auto',
  network: 'on',
  allow: ['github.com', '*.github.com', '*.githubusercontent.com', 'registry.npmjs.org', '*.npmjs.org', 'registry.npmmirror.com', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'crates.io', 'static.crates.io', 'index.crates.io'],
  writable: [],
  denyRead: ['~/.ssh', '~/.aws', '~/.gnupg', '~/.netrc', '~/.config/gh', '~/.kube', '~/.docker/config.json', ...RC_FILES.map((f) => `~/${f}`)],
  scrubEnv: true,
  autoApprove: false,
  docker: { image: 'node:22-bookworm-slim' },
};

/** Parts of ~/.sun sandboxed commands may read (skill scripts, plugins, notes); the rest holds tokens and logs. */
const SUN_READABLE = ['skills', 'plugins', 'kb', 'workspace', 'worktrees'];

/** Package-manager caches: writable so installs and builds work inside the sandbox. */
const CACHE_DIRS = ['~/.npm', '~/.cache', '~/Library/Caches', '~/.pnpm-store', '~/Library/pnpm', '~/.local/share/pnpm', '~/.yarn', '~/.bun', '~/.cargo/registry', '~/.cargo/git', '~/go/pkg/mod', '~/.gradle', '~/.m2'];

export interface ExecSandbox {
  kind: 'none' | 'seatbelt' | 'bwrap' | 'docker';
  /** One line for logs and the UI. */
  describe(): string;
  /** A shell command string that runs `command` (bash syntax) inside the sandbox, from `cwd`. */
  shell(command: string, cwd: string): string;
  /** Environment for the sandboxed process. */
  env(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  dispose?(): void;
}

const expand = (p: string) => resolve(p.startsWith('~/') ? join(homedir(), p.slice(2)) : p === '~' ? homedir() : p);
const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const has = (cmd: string) => spawnSync('which', [cmd]).status === 0;

/** The git directory shared by all worktrees (a worktree's commits are written there). */
function gitCommonDir(cwd: string): string | undefined {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? real(r.stdout.trim()) : undefined;
}

export function writableRoots(cwd: string, cfg: SandboxConfig): string[] {
  const roots = [real(cwd), ...CACHE_DIRS.map(expand), ...cfg.writable.map(expand)];
  const git = gitCommonDir(cwd);
  if (git) roots.push(git);
  return [...new Set(roots)];
}

/** Environment variable names that hold secrets: `*Env` fields of the config, plus credential-looking names. */
export function secretEnvNames(config: unknown, env: NodeJS.ProcessEnv = process.env): string[] {
  const out = new Set<string>(Object.keys(env).filter((k) => CREDENTIAL_NAME.test(k) && !/_MODEL$/.test(k)));
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (typeof x === 'string' && /Env$/.test(k) && /^[A-Z_][A-Z0-9_]*$/.test(x)) out.add(x);
      else walk(x);
    }
  };
  walk(config);
  return [...out];
}

function baseEnv(base: NodeJS.ProcessEnv, scrub: string[], proxy?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, PAGER: 'cat', SUN_SANDBOX: '1' };
  for (const k of scrub) delete env[k];
  if (proxy) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'npm_config_proxy', 'npm_config_https_proxy']) env[k] = proxy;
    env.NO_PROXY = env.no_proxy = 'localhost,127.0.0.1,::1';
    env.NODE_USE_ENV_PROXY = '1';
  }
  return env;
}

// ---------------- macOS seatbelt ----------------

export function seatbeltProfile(cwd: string, cfg: SandboxConfig): string {
  const q = (p: string) => JSON.stringify(p);
  const sun = real(sunHome());
  const lines = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writableRoots(cwd, cfg)
      .map((p) => `(subpath ${q(p)})`)
      .join(' ')} (subpath "/private/tmp") (subpath "/private/var/folders") (literal "/dev/null") (literal "/dev/zero") (regex #"^/dev/(fd/|tty|ptmx|stdout|stderr|dtracehelper)"))`,
    // Credentials and the harness's own state (gateway token, device tokens, config with keys).
    `(deny file-read-data ${[...cfg.denyRead.map(expand).map(real), sun].map((p) => `(subpath ${q(p)})`).join(' ')})`,
  ];
  // Re-allow what under ~/.sun is not secret, and the workspace if it lives there (the last matching rule wins).
  const allowBack = [...SUN_READABLE.map((d) => join(sun, d)), ...writableRoots(cwd, cfg).filter((p) => p.startsWith(sun + '/'))];
  if (allowBack.length) lines.push(`(allow file-read-data ${allowBack.map((p) => `(subpath ${q(p)})`).join(' ')})`);
  if (cfg.network !== 'on') {
    lines.push('(deny network*)', '(allow network* (remote unix-socket))');
    // Loopback stays reachable (local test servers, and the allowlist proxy).
    lines.push('(allow network* (remote ip "localhost:*"))');
  }
  return lines.join('\n') + '\n';
}

function seatbelt(cfg: SandboxConfig, scrub: string[], proxy?: () => number | undefined): ExecSandbox {
  return {
    kind: 'seatbelt',
    describe: () => `seatbelt (writes: workspace + caches; network ${cfg.network})`,
    shell(command, cwd) {
      const profile = seatbeltProfile(cwd, cfg);
      const file = join(ensureDir(homePath('sandbox')), `${createHash('sha1').update(profile).digest('hex').slice(0, 16)}.sb`);
      if (!existsSync(file)) writeFileSync(file, profile);
      return `sandbox-exec -f ${shq(file)} bash -c ${shq(command)}`;
    },
    env: (base) => baseEnv(base, scrub, cfg.network === 'allowlist' && proxy?.() ? `http://127.0.0.1:${proxy()}` : undefined),
  };
}

// ---------------- Linux bubblewrap ----------------

export function bwrapArgs(cwd: string, cfg: SandboxConfig): string[] {
  const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  // Hide credentials first; writable binds come after so a workspace under ~/.sun is mounted on top.
  for (const p of cfg.denyRead.map(expand)) {
    if (!existsSync(p)) continue;
    if (statSync(p).isDirectory()) args.push('--tmpfs', p);
    else args.push('--ro-bind', '/dev/null', p);
  }
  const sun = real(sunHome());
  if (existsSync(sun)) {
    args.push('--tmpfs', sun);
    for (const d of SUN_READABLE) if (existsSync(join(sun, d))) args.push('--ro-bind', join(sun, d), join(sun, d));
  }
  for (const p of writableRoots(cwd, cfg)) if (existsSync(p)) args.push('--bind', p, p);
  if (cfg.network === 'off') args.push('--unshare-net');
  args.push('--die-with-parent', '--chdir', real(cwd));
  return args;
}

function bwrap(cfg: SandboxConfig, scrub: string[], proxy?: () => number | undefined): ExecSandbox {
  return {
    kind: 'bwrap',
    describe: () => `bubblewrap (writes: workspace + caches; network ${cfg.network})`,
    shell: (command, cwd) => `bwrap ${bwrapArgs(cwd, cfg).map(shq).join(' ')} bash -c ${shq(command)}`,
    env: (base) => baseEnv(base, scrub, cfg.network === 'allowlist' && proxy?.() ? `http://127.0.0.1:${proxy()}` : undefined),
  };
}

// ---------------- Docker (one container per session) ----------------

export function dockerSandbox(sessionId: string, cwd: string, cfg: SandboxConfig, scrub: string[]): ExecSandbox {
  const name = `sun-sb-${sessionId.replace(/[^\w-]/g, '')}`;
  const root = real(cwd);
  let started = false;
  const ensure = () => {
    if (started) return;
    const inspect = spawnSync('docker', ['inspect', '-f', '{{.State.Running}}', name], { encoding: 'utf8' });
    if (inspect.stdout.trim() !== 'true') {
      spawnSync('docker', ['rm', '-f', name]);
      const net = cfg.network === 'off' ? 'none' : 'bridge';
      // On Linux, files written in the bind mount would otherwise belong to root.
      const user = platform() === 'linux' && process.getuid ? ['--user', `${process.getuid()}:${process.getgid?.() ?? process.getuid()}`] : [];
      const r = spawnSync('docker', ['run', '-d', '--init', '--name', name, '--label', 'sun-harness=sandbox', '--network', net, ...user, '-v', `${root}:${root}`, '-w', root, cfg.docker.image, 'sleep', 'infinity'], { encoding: 'utf8', timeout: 300_000 });
      if (r.status !== 0) throw new Error(`Could not start the sandbox container (${cfg.docker.image}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`);
    }
    started = true;
  };
  return {
    kind: 'docker',
    describe: () => `docker container ${name} (${cfg.docker.image}; only the workspace is mounted; network ${cfg.network === 'off' ? 'none' : 'bridge'})`,
    shell(command, dir) {
      ensure();
      const inside = real(dir).startsWith(root) ? real(dir) : root;
      return `docker exec -i -w ${shq(inside)} -e PAGER=cat -e CI=\${CI:-} ${name} bash -c ${shq(command)}`;
    },
    env: (base) => baseEnv(base, scrub),
    dispose: () => void spawnSync('docker', ['rm', '-f', name]),
  };
}

// ---------------- selection ----------------

let seatbeltWorks: boolean | undefined;
/** sandbox-exec exists and can apply a profile here (it cannot when sun itself already runs inside a sandbox). */
function seatbeltUsable(): boolean {
  seatbeltWorks ??= existsSync('/usr/bin/sandbox-exec') && spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
  return seatbeltWorks;
}

export function resolveSandboxKind(mode: SandboxMode): ExecSandbox['kind'] {
  if (mode === 'off') return 'none';
  if (mode === 'auto') {
    if (platform() === 'darwin' && seatbeltUsable()) return 'seatbelt';
    if (platform() === 'linux' && has('bwrap')) return 'bwrap';
    return 'none';
  }
  if (mode === 'seatbelt' && !seatbeltUsable()) throw new Error('sandbox-exec is not available (or cannot be nested) on this system.');
  if (mode === 'bwrap' && !has('bwrap')) throw new Error('bwrap (bubblewrap) is not installed.');
  if (mode === 'docker' && spawnSync('docker', ['info'], { timeout: 10_000 }).status !== 0) throw new Error('Docker is not running.');
  return mode;
}

export function createSandbox(o: { mode: SandboxMode; cfg: SandboxConfig; sessionId: string; cwd: string; secretEnv: string[]; proxyPort?: () => number | undefined }): ExecSandbox {
  const scrub = o.cfg.scrubEnv ? o.secretEnv : [];
  const kind = resolveSandboxKind(o.mode);
  if (kind === 'seatbelt') return seatbelt(o.cfg, scrub, o.proxyPort);
  if (kind === 'bwrap') return bwrap(o.cfg, scrub, o.proxyPort);
  if (kind === 'docker') return dockerSandbox(o.sessionId, o.cwd, o.cfg, scrub);
  return { kind: 'none', describe: () => 'none (commands run as you)', shell: (c) => c, env: (base) => baseEnv(base, scrub) };
}

// ---------------- network allowlist proxy ----------------

export function hostAllowed(host: string, allow: string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => {
    const p = a.toLowerCase();
    return p.startsWith('*.') ? h === p.slice(2) || h.endsWith(p.slice(1)) : h === p;
  });
}

/** HTTP(S) proxy on 127.0.0.1 that only connects to allowlisted hosts (CONNECT for HTTPS, absolute URLs for HTTP). */
export function startAllowlistProxy(allow: () => string[], onBlock?: (host: string) => void): Promise<{ port: number; server: Server }> {
  const server = createServer((req, res) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('absolute URL required');
      return;
    }
    if (!hostAllowed(url.hostname, allow())) {
      onBlock?.(url.hostname);
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`sun-harness sandbox: ${url.hostname} is not in sandbox.allow\n`);
      return;
    }
    const up = httpRequest(url, { method: req.method, headers: { ...req.headers, host: url.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', (e) => res.writeHead(502).end(String(e.message)));
    req.pipe(up);
  });
  server.on('connect', (req, socket, head) => {
    const [host, portStr] = (req.url ?? '').split(':');
    if (!hostAllowed(host, allow())) {
      onBlock?.(host);
      socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nsun-harness sandbox: ${host} is not in sandbox.allow\n`);
      return;
    }
    const up = connect(Number(portStr) || 443, host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'));
    socket.on('error', () => up.destroy());
  });
  return new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(0, '127.0.0.1', () => {
      server.unref();
      res({ port: (server.address() as AddressInfo).port, server });
    });
  });
}
