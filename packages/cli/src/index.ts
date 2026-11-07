#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  HarnessHost,
  RemoteHost,
  GatewayClient,
  compareEvalRuns,
  formatEvalReport,
  listEvalRuns,
  loadEvalRun,
  loadSuite,
  runEval,
  validateSuite,
  startBots,
  addRemote,
  createDevice,
  ensureTls,
  getRemote,
  lanAddresses,
  listDevices,
  loadRemotes,
  readGatewayInfo,
  removeRemote,
  revokeDevice,
  useRemote,
  findGateway,
  launchAgentPlist,
  startGateway,
  type ApprovalMode,
  type SessionHost,
  acceptProposal,
  homePath,
  augmentPath,
  importCredentialEnv,
  listIntelReports,
  listProposals,
  listSchedules,
  loadMcpConfig,
  readIntelReport,
  rejectProposal,
  sunHome,
  type ApprovalDecision,
  type LiveEvent,
  type PendingApproval,
  type SandboxMode,
  createSandbox,
  runBestOfN,
} from '@sun/core';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};

const HELP = `sun — personal agent harness

Usage:
  sun [chat] [--mode coding|plan|agent|assistant] [--model provider/model] [--cwd dir] [--worktree]   Interactive session
  sun run "<prompt>" [--mode ..] [--model ..] [--approval suggest|auto-edit|full-auto] [--worktree] [--json]
  sun run "<prompt>" --best-of N [--model a,b] [--apply]   N parallel worktree attempts judged by the project's tests
  sun undo <sessionId> [--steps n]   Revert the session's last file edits (checkpoints)
  sun sandbox status | test   Shell sandbox in use (seatbelt / bwrap / docker / none) and a quick self-test
  Session flags: --sandbox off|auto|seatbelt|bwrap|docker  (per session; default from config.sandbox.mode)
  sun resume <sessionId> [--model provider/model] [--chat]
  sun sessions | sun show <sessionId>
  sun models | sun modes
  sun init                         Scaffold AGENTS.md, specs/, .sun/ in the current project
  sun intel run [--force] | analyze <date> | list | show [date] | install-schedule | uninstall-schedule
  sun kb search <query> | add <title> <file> | index | stats
  sun evolve reflect <sessionId> | list | accept <id> | reject <id>
  sun worktree list | status <id> | diff <id> | merge <id> [--strategy squash|merge] | discard <id>
  sun skills | sun mcp | sun plugins | sun schedules
  sun serve [--port 4471] [--host 127.0.0.1]   Run the gateway (owns sessions; web UI; CLI/desktop attach)
  sun serve --tls [--host 0.0.0.0]              HTTPS with a self-signed, client-pinned certificate (required off localhost)
  sun gateway status | url | install [--tls --host ..] | uninstall   Gateway as a login service (launchd)
  sun gateway token create <device> | list | revoke <id|name>      Per-device tokens for remote clients and bots
  sun remote add <name> <url> --token <t> [--fingerprint <sha256>] | list | use <name> | off | remove <name>
  sun eval validate | run [--label x] [--model ..] [--only a,b] [--concurrency 4] [--best-of N] | list | report [run] | compare <a> <b>
  sun doctor
  sun desktop                      Launch the desktop app (from a source checkout)

Session commands (chat, run, resume, sessions) use --remote <name>, else the default remote, else a local gateway; --local runs in-process.

Chat commands: /model <ref>  /mode <id> (coding|plan|agent|assistant)  /undo [n]  /resume  /abort  /reflect  /sessions  /help  /exit
Home: ${sunHome()}`;

function printEvent(e: LiveEvent, sessionId: string, state: { streamed: boolean; reasoning: boolean }): void {
  if (e.kind === 'delta' && e.sessionId === sessionId) {
    if (e.reasoning) {
      if (!state.reasoning) process.stdout.write(c.dim('\n[thinking] '));
      state.reasoning = true;
      process.stdout.write(c.dim(e.reasoning));
    }
    if (e.text) {
      if (state.reasoning) process.stdout.write('\n');
      state.reasoning = false;
      state.streamed = true;
      process.stdout.write(e.text);
    }
    return;
  }
  if (e.kind !== 'event') return;
  const ev = e.event;
  const sub = e.sessionId !== sessionId ? c.dim('[sub] ') : '';
  switch (ev.type) {
    case 'assistant/message':
      if (e.sessionId !== sessionId) break;
      if (!state.streamed && ev.text) process.stdout.write(ev.text);
      if (state.streamed || ev.text) process.stdout.write('\n');
      state.streamed = false;
      state.reasoning = false;
      for (const call of ev.toolCalls) {
        const args = call.arguments.length > 160 ? call.arguments.slice(0, 160) + '…' : call.arguments;
        console.log(c.cyan(`  ⏺ ${call.name}`) + c.dim(` ${args}`));
      }
      break;
    case 'tool/result': {
      const first = ev.output.split('\n').slice(0, 4).join('\n    ');
      console.log(`${sub}${ev.isError ? c.red('  ✗') : c.green('  ✓')} ${c.dim(ev.name)} ${c.dim(first.slice(0, 400))}`);
      break;
    }
    case 'run/status':
      if (e.sessionId !== sessionId) break;
      if (ev.status === 'paused') {
        console.log(c.yellow(`\n⏸  Paused (${ev.reason}). ${ev.detail ?? ''}`));
        if (ev.reason === 'quota' || ev.reason === 'auth')
          console.log(c.yellow('   Fix the quota/key, or switch model: /model <provider/model> then /resume  (CLI: sun resume <id> --model ..)'));
      } else if (ev.status === 'error') console.log(c.red(`\n✗ Error (${ev.reason}): ${ev.detail ?? ''}`));
      else if (ev.status === 'aborted') console.log(c.yellow('\n■ Aborted'));
      break;
    case 'model/switch':
      console.log(c.yellow(`↪ model ${ev.from} → ${ev.to} (${ev.reason})`));
      break;
    case 'context/compaction':
      console.log(c.dim('  [context compacted]'));
      break;
    case 'todo/update':
      for (const t of ev.items) console.log(c.dim(`  ${t.status === 'done' ? '☑' : t.status === 'in_progress' ? '▶' : '☐'} ${t.content}`));
      break;
  }
}

/** Answers arriving sooner than this after the prompt was drawn were typed before it appeared and are ignored. */
const APPROVAL_ARM_MS = 400;

async function askApproval(rl: ReturnType<typeof createInterface> | undefined, a: PendingApproval): Promise<ApprovalDecision> {
  const args = a.arguments.length > 600 ? a.arguments.slice(0, 600) + '…' : a.arguments;
  console.log(c.yellow(`\n⚠  Approve ${c.bold(a.name)} [${a.risk}]?`) + `\n   ${args}`);
  const own = rl ?? createInterface({ input: process.stdin, output: process.stdout });
  try {
    // A half-typed chat line must not complete into an answer: clear it before asking.
    own.write(null, { ctrl: true, name: 'u' });
    while (true) {
      const shown = Date.now();
      const ans = (await own.question(c.yellow('   [y]es / [n]o / [a]lways for this tool: '))).trim().toLowerCase();
      if (Date.now() - shown < APPROVAL_ARM_MS) {
        console.log(c.dim('   (ignored input typed before the prompt appeared — answer again)'));
        continue;
      }
      if (ans === 'y' || ans === 'yes') return 'allow';
      if (ans === 'a' || ans === 'always') return 'allow_always';
      if (ans === 'n' || ans === 'no' || ans === '') return 'deny';
      console.log(c.dim('   Please answer y, n, or a.'));
    }
  } finally {
    if (!rl) own.close();
  }
}

/** Only an interactive terminal can approve; piped/launchd runs stay headless so approvals are denied instead of hanging. */
function wireApprovals(host: SessionHost, rl?: ReturnType<typeof createInterface>): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  host.registerApprover();
  const asked = new Set<string>();
  let chain = Promise.resolve();
  return host.subscribe((e) => {
    if (e.kind !== 'approvals') return;
    for (const a of e.approvals) {
      if (asked.has(a.callId)) continue;
      asked.add(a.callId);
      chain = chain.then(async () => {
        const decision = await askApproval(rl, a);
        try {
          const ok = await host.approve(a.callId, decision, a.promptId);
          if (ok === false) console.log(c.dim('   (answer not applied: the approval was already answered or re-issued)'));
        } catch (e) {
          console.log(c.dim(`   (answer not applied: ${(e as Error).message})`));
        }
      });
    }
  });
}

async function chat(host: SessionHost, sessionId: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const state = { streamed: false, reasoning: false };
  host.subscribe((e) => printEvent(e, sessionId, state));
  wireApprovals(host, rl);
  await host.ready?.();
  const s = (await host.listSessions()).find((x) => x.id === sessionId)!;
  console.log(c.bold('sun-harness') + c.dim(`  session ${s.id} · ${s.mode} · ${s.model} · ${s.cwd}${host instanceof RemoteHost ? ' · via gateway' : ''}`));
  console.log(c.dim('Type /help for commands. Ctrl+C aborts a run; /exit quits.'));
  rl.on('SIGINT', async () => {
    if (await host.isRunning(sessionId)) await host.abort(sessionId);
    else {
      rl.close();
      process.exit(0);
    }
  });
  // The async iterator buffers lines typed (or piped) while a run is in progress; rl.question() would drop them.
  let closed = false;
  rl.on('close', () => (closed = true));
  const prompt = () => !closed && rl.prompt();
  rl.setPrompt(c.bold('\n› '));
  prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      prompt();
      continue;
    }
    if (closed) console.log(c.bold('\n› ') + line);
    if (line.startsWith('/')) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(' ');
      if (cmd === 'exit' || cmd === 'quit') break;
      if (cmd === 'help') console.log(HELP);
      else if (cmd === 'model') {
        if (!arg) console.log((await host.readyModels()).join('\n'));
        else await host.switchModel(sessionId, arg), console.log(`Model → ${arg}`);
      } else if (cmd === 'mode') await host.switchMode(sessionId, arg), console.log(`Mode → ${arg}`);
      else if (cmd === 'resume') {
        await host.resume(sessionId, { model: arg || undefined });
        await host.wait(sessionId);
      } else if (cmd === 'abort') await host.abort(sessionId);
      else if (cmd === 'undo') printUndo(await host.undo(sessionId, { steps: Number(arg) || 1 }));
      else if (cmd === 'sessions') await listSessions(host);
      else if (cmd === 'reflect') {
        const props = await host.reflect(sessionId);
        for (const p of props) console.log(`${p.id}  [${p.type}] ${p.title}`);
        console.log(c.dim('Accept with: sun evolve accept <id>'));
      } else console.log(`Unknown command /${cmd}`);
      prompt();
      continue;
    }
    await host.send(sessionId, line);
    await host.wait(sessionId);
    prompt();
  }
  await host.wait(sessionId);
  rl.close();
}

function printUndo(r: { undone: string[]; restored: string[] }): void {
  if (!r.undone.length) return void console.log(c.dim('Nothing to undo.'));
  console.log(`Undid ${r.undone.length} edit step${r.undone.length > 1 ? 's' : ''}; restored ${r.restored.length} file${r.restored.length === 1 ? '' : 's'}:`);
  for (const f of r.restored) console.log(c.dim(`  ${f}`));
}

async function bestOfCommand(host: HarnessHost, prompt: string, values: { 'best-of'?: string; model?: string; apply?: boolean; json?: boolean }, cwd: string, approval: ApprovalMode | undefined): Promise<void> {
  const n = Number(values['best-of']);
  console.log(c.dim(`Running ${n} attempts in separate worktrees…`));
  const r = await runBestOfN(host, {
    cwd,
    prompt,
    n,
    models: values.model?.split(','),
    approval: approval ?? 'full-auto',
    apply: values.apply,
    onCandidate: (k) => console.log(`${k.verified === true ? c.green('verified') : k.verified === false ? c.red('failing ') : c.dim('no tests')} ${k.sessionId}  ${c.dim(`${k.model} · ${k.status} · ${k.changedLines} changed lines · ${k.tokens} tokens`)}`),
  });
  if (values.json) console.log(JSON.stringify(r, null, 2));
  else if (!r.winner) console.log(c.yellow('No attempt changed anything.'));
  else {
    console.log(`\nWinner: ${c.bold(r.winner.sessionId)} (${r.winner.verified === true ? 'tests pass' : r.winner.verified === false ? 'tests fail' : 'no tests detected'})`);
    console.log(r.applied ? c.green('Merged into the checkout (staged, squash). Other attempts discarded.') : c.dim(`Review: sun worktree diff ${r.winner.sessionId}   Keep: sun worktree merge ${r.winner.sessionId}`));
  }
  process.exitCode = r.winner ? 0 : 1;
}

async function listSessions(host: SessionHost): Promise<void> {
  for (const s of (await host.listSessions()).slice(0, 30)) {
    const st = s.status === 'paused' ? c.yellow(`paused:${s.statusReason}`) : s.status === 'error' ? c.red('error') : c.dim(s.status);
    console.log(`${s.id}  ${st.padEnd(20)} ${c.dim(s.mode.padEnd(9))} ${s.title.slice(0, 50).padEnd(50)} ${c.dim(s.model)}`);
  }
}

function initProject(cwd: string): void {
  const files: [string, string][] = [
    [
      'AGENTS.md',
      `# AGENTS.md\n\nRules for humans and AI agents in this repository.\n\n## Language\n- All docs, specs, comments, and commit messages are in English.\n\n## Source of truth\n1. specs/ (product behavior)\n2. AGENTS.md (this file; nested AGENTS.md files override for their subtree)\n3. Code\n\n## Rules\n- Behavior changes update the matching spec in the same change.\n- Run tests before declaring work done.\n- Keep changes minimal and match the surrounding style.\n`,
    ],
    ['specs/000-vision.md', `# 000 — Vision\n\n## Problem\n\n## Users\n\n## Goals\n\n## Non-goals\n`],
    ['.sun/rules/README.md', `Project rules for sun-harness. Every .md file here is always applied unless its frontmatter has alwaysApply: false and a description.\n`],
    ['.sun/skills/.gitkeep', ''],
    ['.sun/mcp.json', JSON.stringify({ mcpServers: {} }, null, 2) + '\n'],
    ['.sun/hooks.json', JSON.stringify({ preToolUse: [], postToolUse: [], sessionStart: [], stop: [] }, null, 2) + '\n'],
  ];
  for (const [rel, content] of files) {
    const p = join(cwd, rel);
    if (existsSync(p)) {
      console.log(c.dim(`exists  ${rel}`));
      continue;
    }
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
    console.log(c.green(`created ${rel}`));
  }
  if (!existsSync(join(cwd, 'CLAUDE.md'))) {
    try {
      spawnSync('ln', ['-s', 'AGENTS.md', 'CLAUDE.md'], { cwd });
      console.log(c.green('created CLAUDE.md -> AGENTS.md'));
    } catch {
      // optional
    }
  }
}

async function doctor(host: HarnessHost, cwd: string): Promise<void> {
  console.log(c.bold('Home: ') + sunHome());
  console.log(c.bold('Default model: ') + host.config.defaultModel);
  console.log(c.bold('Approval: ') + host.config.approval);
  console.log(c.bold('Providers:'));
  for (const [id, p] of Object.entries(host.config.providers)) {
    const ready = p.noKey || (p.apiKeyEnv && process.env[p.apiKeyEnv]) || p.apiKey;
    console.log(`  ${ready ? c.green('●') : c.dim('○')} ${id.padEnd(11)} ${c.dim(p.baseUrl)} ${p.apiKeyEnv ? c.dim(`(${p.apiKeyEnv})`) : ''}`);
  }
  console.log(c.bold('Skills: ') + host.listSkills(cwd).length);
  console.log(c.bold('MCP servers: ') + loadMcpConfig(cwd).map((s) => s.name).join(', '));
  console.log(c.bold('Plugins: ') + host.pluginStates.map((p) => `${p.name}(${p.status})`).join(', '));
  const kb = await host.kbStats();
  console.log(c.bold('Knowledge: ') + `${kb.personal.documents} docs / ${kb.personal.chunks} chunks in ${kb.roots.join(', ')}`);
  const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.sun-harness.intel.plist');
  console.log(c.bold('Intel schedule: ') + (existsSync(plist) ? c.green(`installed (${plist})`) : c.dim('not installed (sun intel install-schedule)')));
  const ref = host.config.defaultModel;
  process.stdout.write(c.bold('Model check: '));
  try {
    const t = await host.complete('Reply with exactly: OK', 'ping', ref);
    console.log(c.green(`${ref} → ${t.trim().slice(0, 40)}`));
  } catch (e) {
    console.log(c.red(`${ref} → ${(e as Error).message.slice(0, 200)}`));
  }
}

/** Copy the self-contained CLI bundle (and the web UI) into ~/.sun, outside TCC-protected folders, for launchd. */
function installBundle(): string {
  const here = fileURLToPath(import.meta.url);
  const bundle = join(here, '..', 'sun.mjs');
  if (!existsSync(bundle)) throw new Error(`Missing ${bundle}. Run: pnpm build:core`);
  const cliPath = join(sunHome(), 'bin', 'sun.mjs');
  mkdirSync(join(cliPath, '..'), { recursive: true });
  if (resolve(bundle) !== resolve(cliPath)) copyFileSync(bundle, cliPath);
  const web = webRootCandidates().find((p) => existsSync(join(p, 'index.html')) && resolve(p) !== resolve(homePath('web')));
  if (web) {
    rmSync(homePath('web'), { recursive: true, force: true });
    cpSync(web, homePath('web'), { recursive: true });
  }
  return cliPath;
}

function webRootCandidates(): string[] {
  const here = fileURLToPath(import.meta.url);
  return [join(here, '..', '..', '..', '..', 'apps', 'desktop', 'out', 'renderer'), homePath('web')];
}

function loadAgent(label: string, xml: string): string {
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  mkdirSync(join(plist, '..'), { recursive: true });
  writeFileSync(plist, xml);
  spawnSync('launchctl', ['unload', plist]);
  const r = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr || 'launchctl load failed');
  return plist;
}

async function serve(values: { port?: string; host?: string; tls?: boolean; insecure?: boolean }): Promise<void> {
  const running = await findGateway();
  if (running) throw new Error(`A gateway is already running at ${running.url} (pid ${running.pid}).`);
  const host = new HarnessHost({ connectMcp: true });
  await host.init();
  // The gateway owns sessions: auto-resume, schedules, jobs and the intel catch-up run here, headless.
  host.startBackground(60_000, { intel: true });
  const webRoot = webRootCandidates().find((p) => existsSync(join(p, 'index.html')));
  const tls = values.tls ? ensureTls({ hosts: values.host ? [values.host] : [] }) : undefined;
  const bots = startBots(host, host.config.bots);
  const gw = await startGateway(host, { port: Number(values.port) || 4471, hostname: values.host, webRoot, tls, insecure: values.insecure, routes: bots.routes });
  console.log(`${c.bold('sun-harness gateway')} ${gw.url}  (pid ${process.pid}, home ${sunHome()})`);
  if (tls) console.log(`TLS certificate fingerprint (SHA-256): ${tls.fingerprint}`);
  if (bots.started.length) console.log(`Bots: ${bots.started.join(', ')}${bots.routes['/bots/webhook'] ? `  (webhook: POST ${gw.url}/bots/webhook)` : ''}${bots.routes['/bots/dingtalk'] ? `  (DingTalk callback: ${gw.url}/bots/dingtalk)` : ''}`);
  if (bots.skipped.length) console.log(c.yellow(`Bots not started: ${bots.skipped.join(', ')}`));
  if (values.host && values.host !== '127.0.0.1') console.log(c.dim(`Reachable on: ${lanAddresses().map((a) => `${gw.url.split(':')[0]}://${a}:${new URL(gw.url).port}`).join('  ')}  — create a device token: sun gateway token create <name>`));
  console.log(webRoot ? `Web UI: ${gw.url}/#token=${gw.token}` : c.dim('Web UI not built (pnpm build).'));
  const stop = async () => {
    bots.stop();
    await gw.close();
    await host.dispose();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => undefined);
}

function defaultSuite(): string {
  return resolve(fileURLToPath(import.meta.url), '..', '..', '..', '..', 'evals', 'coding');
}

async function evalCommand(sub: string, rest: string[], values: { suite?: string; only?: string; label?: string; concurrency?: string; model?: string; 'best-of'?: string }): Promise<void> {
  const suiteDir = resolve(values.suite ?? defaultSuite());
  if (sub === 'validate') {
    const results = validateSuite(suiteDir);
    for (const r of results) console.log(`${r.ok ? c.green('ok ') : c.red('BAD')} ${r.id}${r.ok ? '' : `  failsUntouched=${r.failsUntouched} solvable=${r.solvable}\n${c.dim(r.output)}`}`);
    console.log(`${results.filter((r) => r.ok).length}/${results.length} tasks valid`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  } else if (sub === 'run') {
    // Reproducible context: no plugins, MCP servers or shell hooks from the user's setup.
    const host = new HarnessHost({ loadPlugins: false, connectMcp: false, shellHooks: false });
    await host.init();
    const tasks = loadSuite(suiteDir).filter((t) => !values.only || values.only.split(',').includes(t.id));
    console.log(c.dim(`Running ${tasks.length} tasks on ${values.model ?? host.config.defaultModel}…`));
    const run = await runEval({
      host,
      suiteDir,
      label: values.label,
      model: values.model,
      only: values.only?.split(','),
      concurrency: Number(values.concurrency) || 4,
      bestOf: Number(values['best-of']) || undefined,
      onResult: (r) => console.log(`${r.passed ? c.green('pass') : c.red('FAIL')} ${r.id.padEnd(28)} ${c.dim(`${r.steps} steps · ${r.toolErrors} tool errors · ${(r.durationMs / 1000).toFixed(0)}s · ${r.status}`)}`),
    });
    console.log(`\n${formatEvalReport(run)}\n\n${c.dim(`saved ~/.sun/evals/${run.id}.json`)}`);
    await host.dispose();
  } else if (sub === 'list') {
    for (const r of listEvalRuns()) console.log(`${r.id}  ${(r.passRate * 100).toFixed(1).padStart(5)}%  ${r.tasks} tasks  ${c.dim(r.model)}`);
  } else if (sub === 'report') {
    console.log(formatEvalReport(loadEvalRun(rest[0] ?? listEvalRuns()[0]?.id)));
  } else if (sub === 'compare') {
    if (rest.length < 2) throw new Error('Usage: sun eval compare <run-or-label> <run-or-label>');
    console.log(compareEvalRuns(loadEvalRun(rest[0]), loadEvalRun(rest[1])));
  } else throw new Error(`Unknown eval command ${sub}`);
}

async function remoteCommand(sub: string, rest: string[], values: { token?: string; fingerprint?: string }): Promise<void> {
  if (sub === 'add') {
    const [name, url] = rest;
    if (!name || !url || !values.token) throw new Error('Usage: sun remote add <name> <url> --token <device-token> [--fingerprint <sha256>]');
    if (url.startsWith('https://') && !values.fingerprint) console.log(c.yellow('No --fingerprint given: trusting the certificate presented now (verify it matches the gateway).'));
    const e = await addRemote({ name, url, token: values.token, fingerprint: values.fingerprint });
    const ok = await new GatewayClient(e).call('appInfo').then(
      () => true,
      (err: Error) => (console.log(c.red(`Saved, but the gateway did not answer: ${err.message}`)), false),
    );
    console.log(`${ok ? c.green('Connected') : 'Saved'}: ${e.name} → ${e.url}${e.fingerprint ? `  (pinned ${e.fingerprint})` : ''}`);
  } else if (sub === 'list') {
    const r = loadRemotes();
    for (const e of r.remotes) console.log(`${e.name === r.default ? c.green('*') : ' '} ${e.name.padEnd(12)} ${e.url}${e.fingerprint ? c.dim(`  ${e.fingerprint.slice(0, 23)}…`) : c.yellow('  (no TLS)')}`);
    if (!r.remotes.length) console.log(c.dim('No remotes. Add one with: sun remote add <name> <url> --token <t> --fingerprint <fp>'));
  } else if (sub === 'use') {
    useRemote(rest[0]);
    console.log(rest[0] ? `Session commands now use ${rest[0]}.` : 'Using the local gateway / in-process host.');
  } else if (sub === 'off') {
    useRemote(undefined);
    console.log('Using the local gateway / in-process host.');
  } else if (sub === 'remove') {
    console.log(removeRemote(rest[0] ?? '') ? 'Removed.' : 'No such remote.');
  } else throw new Error(`Unknown remote command ${sub}`);
}

async function gatewayCommand(sub: string, rest: string[] = [], values: { port?: string; host?: string; tls?: boolean; insecure?: boolean } = {}): Promise<void> {
  const label = 'com.sun-harness.gateway';
  const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  if (sub === 'status') {
    const gw = await findGateway();
    console.log(gw ? c.green(`running at ${gw.url} (pid ${gw.pid}, since ${gw.startedAt})`) : c.dim('not running (start with: sun serve, or install: sun gateway install)'));
    console.log(c.dim(existsSync(plist) ? `launchd: ${plist}` : 'launchd: not installed'));
  } else if (sub === 'url') {
    const gw = await findGateway();
    if (!gw) throw new Error('No gateway running.');
    console.log(`${gw.url}/#token=${gw.token}`);
    if (gw.fingerprint) console.log(c.dim(`certificate fingerprint ${gw.fingerprint} (self-signed: confirm it in the browser warning)`));
  } else if (sub === 'token') {
    const action = rest[0] ?? 'list';
    if (action === 'create') {
      const name = rest[1];
      if (!name) throw new Error('Usage: sun gateway token create <device-name>');
      const { device, token } = createDevice(name);
      const gw = readGatewayInfo();
      const port = gw ? new URL(gw.url).port : values.port || '4471';
      const scheme = gw?.url.startsWith('https') ? 'https' : 'http';
      const fp = gw?.fingerprint ?? (scheme === 'https' ? ensureTls().fingerprint : undefined);
      console.log(`Device ${c.bold(device.name)} (${device.id}) token — shown once, store it now:\n  ${token}`);
      for (const ip of lanAddresses().length ? lanAddresses() : ['127.0.0.1']) {
        console.log(c.dim(`  sun remote add <name> ${scheme}://${ip}:${port} --token ${token}${fp ? ` --fingerprint ${fp}` : ''}`));
      }
      if (scheme !== 'https') console.log(c.yellow('  The gateway is not using TLS; restart it with --tls before using it from other machines.'));
    } else if (action === 'list') {
      for (const d of listDevices()) console.log(`${d.id}  ${d.name.padEnd(16)} created ${d.createdAt.slice(0, 16)}  last used ${d.lastUsedAt?.slice(0, 16) ?? '—'}`);
    } else if (action === 'revoke') {
      console.log(revokeDevice(rest[1] ?? '') ? 'Revoked.' : 'No such device.');
    } else throw new Error(`Unknown token command ${action}`);
  } else if (sub === 'install') {
    const cliPath = installBundle();
    const flags = [...(values.tls ? ['--tls'] : []), ...(values.host ? ['--host', values.host] : []), ...(values.port ? ['--port', values.port] : []), ...(values.insecure ? ['--insecure'] : [])];
    loadAgent(label, launchAgentPlist({ label, nodePath: process.execPath, args: [cliPath, 'serve', ...flags], log: homePath('gateway.log'), keepAlive: true }));
    for (let i = 0; i < 40 && !(await findGateway()); i++) await new Promise((r) => setTimeout(r, 250));
    const gw = await findGateway();
    console.log(gw ? c.green(`Gateway installed and running at ${gw.url}. Web UI: ${gw.url}/#token=${gw.token}`) : c.yellow(`Installed ${plist}; not reachable yet (see ${homePath('gateway.log')}).`));
  } else if (sub === 'uninstall') {
    spawnSync('launchctl', ['unload', plist]);
    if (existsSync(plist)) unlinkSync(plist);
    console.log('Gateway service removed.');
  } else throw new Error(`Unknown gateway command ${sub}`);
}

async function sessionCommands(
  host: SessionHost,
  cmd: string,
  args: string[],
  values: { mode?: string; model?: string; json?: boolean; chat?: boolean; worktree?: boolean; steps?: string; sandbox?: string },
  sessionCwd: string | undefined,
  approval: ApprovalMode | undefined,
): Promise<void> {
  switch (cmd) {
    case 'chat': {
      const s = await host.createSession({ cwd: sessionCwd, mode: values.mode, model: values.model, worktree: values.worktree, approval, sandbox: values.sandbox as SandboxMode | undefined });
      await chat(host, s.id);
      break;
    }
    case 'run': {
      const prompt = args.join(' ') || (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '');
      if (!prompt) throw new Error('Usage: sun run "<prompt>"');
      const s = await host.createSession({ cwd: sessionCwd, mode: values.mode, model: values.model, worktree: values.worktree, approval, sandbox: values.sandbox as SandboxMode | undefined });
      const state = { streamed: false, reasoning: false };
      if (!values.json) host.subscribe((e) => printEvent(e, s.id, state));
      wireApprovals(host);
      await host.ready?.();
      await host.send(s.id, prompt);
      let r = await host.wait(s.id);
      // Background jobs deliver their results as new turns; stay until they and those turns finish.
      while ((await host.listJobs(s.id)).some((j) => j.state === 'running') || (await host.isRunning(s.id))) {
        await new Promise((res) => setTimeout(res, 300));
        r = (await host.wait(s.id)) ?? r;
      }
      const last = [...(await host.getEvents(s.id))].reverse().find((e) => e.type === 'assistant/message') as { text: string } | undefined;
      if (values.json) console.log(JSON.stringify({ sessionId: s.id, status: r?.status, reason: r?.reason, text: last?.text ?? '' }, null, 2));
      else console.log(c.dim(`\nsession ${s.id} · ${r?.status}${r?.reason ? ` (${r.reason})` : ''}`));
      process.exitCode = r?.status === 'idle' ? 0 : r?.status === 'paused' ? 3 : 1;
      break;
    }
    case 'resume': {
      const id = args[0] ?? (await host.listSessions())[0]?.id;
      if (!id) throw new Error('No session to resume.');
      if (values.chat) {
        await host.resume(id, { model: values.model });
        await chat(host, id);
        break;
      }
      const state = { streamed: false, reasoning: false };
      host.subscribe((e) => printEvent(e, id, state));
      wireApprovals(host);
      await host.ready?.();
      await host.resume(id, { model: values.model });
      const r = await host.wait(id);
      console.log(c.dim(`\nsession ${id} · ${r?.status}${r?.reason ? ` (${r.reason})` : ''}`));
      process.exitCode = r?.status === 'idle' ? 0 : 3;
      break;
    }
    case 'sessions':
      await listSessions(host);
      break;
    case 'undo': {
      if (!args[0]) throw new Error('Usage: sun undo <sessionId> [--steps n]');
      printUndo(await host.undo(args[0], { steps: Number(values.steps) || 1 }));
      break;
    }
  }
  await host.dispose();
}

async function main(): Promise<void> {
  importCredentialEnv();
  augmentPath();
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      mode: { type: 'string' },
      model: { type: 'string' },
      cwd: { type: 'string' },
      approval: { type: 'string' },
      force: { type: 'boolean' },
      json: { type: 'boolean' },
      chat: { type: 'boolean' },
      worktree: { type: 'boolean' },
      strategy: { type: 'string' },
      local: { type: 'boolean' },
      port: { type: 'string' },
      host: { type: 'string' },
      tls: { type: 'boolean' },
      insecure: { type: 'boolean' },
      remote: { type: 'string' },
      suite: { type: 'string' },
      only: { type: 'string' },
      label: { type: 'string' },
      concurrency: { type: 'string' },
      token: { type: 'string' },
      'best-of': { type: 'string' },
      sandbox: { type: 'string' },
      apply: { type: 'boolean' },
      steps: { type: 'string' },
      fingerprint: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void console.log(HELP);
  const [cmd = 'chat', ...args] = positionals;
  const cwd = resolve(values.cwd ?? process.cwd());
  // Coding works in the current folder; agent/assistant use ~/.sun/workspace unless --cwd is given (specs/007).
  const sessionCwd = values.cwd || !values.mode || values.mode === 'coding' || values.mode === 'plan' ? cwd : undefined;
  const approval = values.approval as ApprovalMode | undefined;
  if (cmd === 'serve') return serve(values);
  if (cmd === 'gateway') return gatewayCommand(args[0] ?? 'status', args.slice(1), values);
  if (cmd === 'remote') return remoteCommand(args[0] ?? 'list', args.slice(1), values);
  if (cmd === 'eval') return evalCommand(args[0] ?? 'list', args.slice(1), values);

  // Session commands: --local > --remote <name> > default remote > local gateway > in-process.
  // Best-of-N runs in-process: its worktrees and test judging need the local disk.
  const bestOf = cmd === 'run' && Number(values['best-of']) > 1;
  if (['chat', 'run', 'resume', 'sessions', 'undo'].includes(cmd) && !values.local && !bestOf) {
    const remote = getRemote(values.remote);
    if (values.remote && !remote) throw new Error(`No remote named ${values.remote} (sun remote list).`);
    if (remote) return sessionCommands(new RemoteHost(remote), cmd, args, values, values.cwd ? cwd : undefined, approval);
    const gw = await findGateway();
    if (gw) return sessionCommands(new RemoteHost(gw), cmd, args, values, sessionCwd, approval);
  }

  const needsMcp = ['chat', 'run', 'resume', 'mcp'].includes(cmd);
  const host = new HarnessHost({ connectMcp: needsMcp });
  await host.init();
  if (bestOf) {
    const prompt = args.join(' ') || (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '');
    if (!prompt) throw new Error('Usage: sun run "<prompt>" --best-of N');
    await bestOfCommand(host, prompt, values, cwd, approval);
    await host.dispose();
    return;
  }
  if (['chat', 'run', 'resume', 'sessions', 'undo'].includes(cmd)) {
    await sessionCommands(host, cmd, args, values, sessionCwd, approval);
    await host.dispose();
    return;
  }

  switch (cmd) {
    case 'show': {
      for (const e of host.getEvents(args[0])) {
        if (e.type === 'user/message') console.log(c.bold('\nUSER: ') + e.text);
        else if (e.type === 'assistant/message') console.log(c.bold('\nASSISTANT: ') + e.text + e.toolCalls.map((t) => c.cyan(`\n  ⏺ ${t.name} ${t.arguments.slice(0, 200)}`)).join(''));
        else if (e.type === 'tool/result') console.log(c.dim(`  ↳ ${e.name}: ${e.output.slice(0, 300)}`));
        else if (e.type === 'run/status') console.log(c.dim(`  [${e.status}${e.reason ? `:${e.reason}` : ''}]`));
      }
      break;
    }
    case 'models':
      for (const m of host.listModels()) console.log(`${m.ready ? c.green('●') : c.dim('○')} ${m.ref}${m.ref === host.config.defaultModel ? c.bold('  (default)') : ''}`);
      break;
    case 'modes':
      for (const m of host.listModes()) console.log(`${c.bold(m.id.padEnd(10))} ${m.description}`);
      break;
    case 'init':
      initProject(cwd);
      break;
    case 'intel': {
      const sub = args[0] ?? 'run';
      if (sub === 'run') {
        console.log(c.dim(`Fetching ${host.config.intel.sources.length} sources...`));
        const r = await host.runIntel({ force: values.force });
        console.log(`${r.items.length} new items, ${r.errors.length} fetch errors, analyzed: ${r.analyzed}${r.analysisError ? ` (${r.analysisError.slice(0, 120)})` : ''}, proposals: ${r.proposals}`);
        console.log(`Report: ${r.reportPath}\nHTML:   ${r.htmlPath}`);
      } else if (sub === 'analyze') {
        const r = await host.analyzeIntel(args[1] ?? new Date().toISOString().slice(0, 10));
        console.log(`Analyzed ${r.items.length} items → ${r.reportPath}`);
      } else if (sub === 'list') {
        for (const r of listIntelReports()) console.log(`${r.date}${r.pending ? c.yellow('  (analysis pending)') : ''}  ${c.dim(r.html)}`);
      } else if (sub === 'show') {
        const date = args[1] ?? listIntelReports()[0]?.date;
        if (!date) throw new Error('No reports yet. Run: sun intel run');
        console.log(readIntelReport(date));
      } else if (sub === 'install-schedule') {
        const cliPath = installBundle();
        const label = 'com.sun-harness.intel';
        const xml = launchAgentPlist({ label, nodePath: process.execPath, args: [cliPath, 'intel', 'run'], log: homePath('intel', 'launchd.log'), calendar: { hour: host.config.intel.hour, minute: host.config.intel.minute } });
        const plist = loadAgent(label, xml);
        console.log(c.green(`Installed ${plist} (daily ${host.config.intel.hour}:${String(host.config.intel.minute).padStart(2, '0')})`));
      } else if (sub === 'uninstall-schedule') {
        const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.sun-harness.intel.plist');
        spawnSync('launchctl', ['unload', plist]);
        if (existsSync(plist)) unlinkSync(plist);
        console.log('Removed intel schedule.');
      } else throw new Error(`Unknown intel command ${sub}`);
      break;
    }
    case 'kb': {
      const sub = args[0];
      if (sub === 'search') {
        for (const h of await host.kbSearch(args.slice(1).join(' '), 8)) console.log(`${c.bold(h.title)} ${c.dim(`(${h.score}) ${h.source}`)}\n  ${h.text.slice(0, 200).replace(/\n/g, ' ')}`);
      } else if (sub === 'add') {
        const text = args[2] === '-' || !args[2] ? readFileSync(0, 'utf8') : readFileSync(args[2], 'utf8');
        console.log(await host.kbAdd(args[1], text));
      } else if (sub === 'index') {
        const r = await host.kbIndex();
        console.log(r.enabled ? `Embedded ${r.embedded} new chunks.` : 'Hybrid retrieval is off. Enable kb.embeddings in ~/.sun/config.json or Settings.');
      } else console.log(JSON.stringify(await host.kbStats(), null, 2));
      break;
    }
    case 'evolve': {
      const sub = args[0] ?? 'list';
      if (sub === 'reflect') {
        const id = args[1] ?? host.listSessions()[0]?.id;
        for (const p of await host.reflect(id)) console.log(`${p.id}  [${p.type}] ${p.title}\n  ${c.dim(p.rationale)}`);
      } else if (sub === 'accept') console.log(`Applied → ${acceptProposal(args[1]).appliedTo}`);
      else if (sub === 'reject') rejectProposal(args[1]), console.log('Rejected.');
      else for (const p of listProposals(args[1] as never)) console.log(`${p.id}  ${p.status.padEnd(8)} [${p.type}] ${p.title} ${c.dim(`(${p.source.kind} ${p.source.ref})`)}`);
      break;
    }
    case 'sandbox': {
      const sub = args[0] ?? 'status';
      const info = host.sandboxInfo();
      console.log(`mode ${info.mode} → ${c.bold(info.kind)}: ${info.description}`);
      console.log(c.dim(`network ${info.network}${info.network === 'allowlist' ? ` (allow: ${host.config.sandbox.allow.join(', ')})` : ''} · scrub secrets ${host.config.sandbox.scrubEnv} · auto-approve ${host.config.sandbox.autoApprove}`));
      if (sub === 'test') {
        const dir = mkdtempSync(join(tmpdir(), 'sun-sbtest-'));
        const sb = createSandbox({ mode: host.config.sandbox.mode, cfg: host.config.sandbox, sessionId: 'selftest', cwd: dir, secretEnv: [] });
        const probe = join(homedir(), `.sun-sandbox-selftest-${process.pid}`);
        const r = spawnSync('bash', ['-c', sb.shell(`echo ok > inside.txt && cat inside.txt; echo x > ${probe} 2>/dev/null && echo OUTSIDE-WRITABLE || echo outside-blocked`, dir)], { cwd: dir, env: sb.env(process.env), encoding: 'utf8' });
        if (existsSync(probe)) unlinkSync(probe);
        sb.dispose?.();
        console.log(r.stdout.trim() || r.stderr.trim());
        process.exitCode = sb.kind !== 'none' && /OUTSIDE-WRITABLE/.test(r.stdout) ? 1 : 0;
      }
      break;
    }
    case 'worktree': {
      const sub = args[0] ?? 'list';
      const id = args[1];
      if (sub === 'list') {
        for (const s of host.listSessions().filter((x) => x.worktree)) {
          const st = s.worktree!.closed ?? (() => {
            const w = host.worktreeStatus(s.id);
            return `${w.files.length} files +${w.insertions} -${w.deletions}`;
          })();
          console.log(`${s.id}  ${c.cyan(s.worktree!.branch)}  ${st}  ${c.dim(s.title.slice(0, 50))}`);
        }
      } else if (sub === 'status') {
        const w = host.worktreeStatus(id);
        console.log(`${w.info.branch} → ${w.info.repo}\n${w.files.map((f) => `  ${f.status} ${f.path}`).join('\n') || '  (no changes)'}\n  +${w.insertions} -${w.deletions}`);
      } else if (sub === 'diff') console.log(host.worktreeDiff(id));
      else if (sub === 'merge') {
        const r = host.mergeWorktree(id, { strategy: values.strategy === 'merge' ? 'merge' : 'squash' });
        console.log(r.strategy === 'squash' ? c.green('Squashed into the main checkout (staged). Review and commit there.') : c.green('Merged with a merge commit.'));
      } else if (sub === 'discard') host.discardWorktree(id), console.log('Discarded worktree and branch.');
      else throw new Error(`Unknown worktree command ${sub}`);
      break;
    }
    case 'skills':
      for (const s of host.listSkills(cwd)) console.log(`${c.bold(s.name)} ${c.dim(`[${s.scope}]`)} ${s.description.slice(0, 100)}`);
      break;
    case 'mcp':
      for (const s of await host.listMcp(cwd)) console.log(`${s.status === 'ready' ? c.green('●') : c.red('●')} ${s.name} ${c.dim(s.source)} ${s.error ?? s.tools.join(', ')}`);
      break;
    case 'plugins':
      for (const p of host.pluginStates) console.log(`${p.name} ${p.status} ${p.error ?? JSON.stringify(p.contributes)}`);
      break;
    case 'schedules':
      for (const t of listSchedules()) console.log(`${t.id} ${t.enabled ? 'on ' : 'off'} ${t.cron ?? t.at} ${t.title}`);
      break;
    case 'doctor':
      await doctor(host, cwd);
      break;
    case 'desktop': {
      const root = resolve(fileURLToPath(import.meta.url), '../../../..');
      spawnSync('pnpm', ['--filter', '@sun/desktop', 'run', 'start'], { cwd: root, stdio: 'inherit' });
      break;
    }
    default:
      console.log(HELP);
  }
  await host.dispose();
}

main().catch((e) => {
  console.error(c.red((e as Error).message));
  process.exit(1);
});
