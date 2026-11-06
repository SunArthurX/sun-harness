#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  HarnessHost,
  SessionLog,
  acceptProposal,
  importCredentialEnv,
  launchdPlist,
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
  sun [chat] [--mode coding|agent|assistant] [--model provider/model] [--cwd dir]   Interactive session
  sun run "<prompt>" [--mode ..] [--model ..] [--approval suggest|auto-edit|full-auto] [--json]
  sun resume <sessionId> [--model provider/model] [--chat]
  sun sessions | sun show <sessionId>
  sun models | sun modes
  sun init                         Scaffold AGENTS.md, specs/, .sun/ in the current project
  sun intel run [--force] | analyze <date> | list | show [date] | install-schedule | uninstall-schedule
  sun kb search <query> | add <title> <file> | stats
  sun evolve reflect <sessionId> | list | accept <id> | reject <id>
  sun skills | sun mcp | sun plugins | sun schedules
  sun doctor
  sun desktop                      Launch the desktop app (from a source checkout)

Chat commands: /model <ref>  /mode <id>  /resume  /abort  /reflect  /sessions  /help  /exit
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

async function askApproval(rl: ReturnType<typeof createInterface> | undefined, a: PendingApproval): Promise<ApprovalDecision> {
  const args = a.arguments.length > 600 ? a.arguments.slice(0, 600) + '…' : a.arguments;
  console.log(c.yellow(`\n⚠  Approve ${c.bold(a.name)} [${a.risk}]?`) + `\n   ${args}`);
  const own = rl ?? createInterface({ input: process.stdin, output: process.stdout });
  const ans = (await own.question(c.yellow('   [y]es / [n]o / [a]lways for this tool: '))).trim().toLowerCase();
  if (!rl) own.close();
  return ans.startsWith('a') ? 'allow_always' : ans.startsWith('y') ? 'allow' : 'deny';
}

/** Only an interactive terminal can approve; piped/launchd runs stay headless so approvals are denied instead of hanging. */
function wireApprovals(host: HarnessHost, rl?: ReturnType<typeof createInterface>): () => void {
  if (!process.stdin.isTTY) return () => undefined;
  host.registerApprover();
  const asked = new Set<string>();
  let chain = Promise.resolve();
  return host.subscribe((e) => {
    if (e.kind !== 'approvals') return;
    for (const a of e.approvals) {
      if (asked.has(a.callId)) continue;
      asked.add(a.callId);
      chain = chain.then(async () => host.approve(a.callId, await askApproval(rl, a)));
    }
  });
}

async function chat(host: HarnessHost, sessionId: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const state = { streamed: false, reasoning: false };
  host.subscribe((e) => printEvent(e, sessionId, state));
  wireApprovals(host, rl);
  const s = SessionLog.open(sessionId).summary()!;
  console.log(c.bold('sun-harness') + c.dim(`  session ${s.id} · ${s.mode} · ${s.model} · ${s.cwd}`));
  console.log(c.dim('Type /help for commands. Ctrl+C aborts a run; /exit quits.'));
  rl.on('SIGINT', () => {
    if (host.isRunning(sessionId)) host.abort(sessionId);
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
        if (!arg) console.log(host.readyModels().join('\n'));
        else host.switchModel(sessionId, arg), console.log(`Model → ${arg}`);
      } else if (cmd === 'mode') host.switchMode(sessionId, arg), console.log(`Mode → ${arg}`);
      else if (cmd === 'resume') {
        host.resume(sessionId, { model: arg || undefined });
        await host.wait(sessionId);
      } else if (cmd === 'abort') host.abort(sessionId);
      else if (cmd === 'sessions') listSessions(host);
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

function listSessions(host: HarnessHost): void {
  for (const s of host.listSessions().slice(0, 30)) {
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

async function main(): Promise<void> {
  importCredentialEnv();
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
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void console.log(HELP);
  const [cmd = 'chat', ...args] = positionals;
  const cwd = resolve(values.cwd ?? process.cwd());
  // Coding works in the current folder; agent/assistant use ~/.sun/workspace unless --cwd is given (specs/007).
  const sessionCwd = values.cwd || !values.mode || values.mode === 'coding' ? cwd : undefined;
  const needsMcp = ['chat', 'run', 'resume', 'mcp'].includes(cmd);
  const host = new HarnessHost({ connectMcp: needsMcp });
  await host.init();
  if (values.approval) host.config.approval = values.approval as never;

  switch (cmd) {
    case 'chat': {
      const s = host.createSession({ cwd: sessionCwd, mode: values.mode, model: values.model });
      await chat(host, s.id);
      break;
    }
    case 'run': {
      const prompt = args.join(' ') || (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '');
      if (!prompt) throw new Error('Usage: sun run "<prompt>"');
      const s = host.createSession({ cwd: sessionCwd, mode: values.mode, model: values.model });
      const state = { streamed: false, reasoning: false };
      if (!values.json) host.subscribe((e) => printEvent(e, s.id, state));
      wireApprovals(host);
      await host.send(s.id, prompt);
      const r = await host.wait(s.id);
      const last = SessionLog.open(s.id).last('assistant/message');
      if (values.json) console.log(JSON.stringify({ sessionId: s.id, status: r?.status, reason: r?.reason, text: last?.text ?? '' }, null, 2));
      else console.log(c.dim(`\nsession ${s.id} · ${r?.status}${r?.reason ? ` (${r.reason})` : ''}`));
      process.exitCode = r?.status === 'idle' ? 0 : r?.status === 'paused' ? 3 : 1;
      break;
    }
    case 'resume': {
      const id = args[0] ?? host.listSessions()[0]?.id;
      if (!id) throw new Error('No session to resume.');
      if (values.chat) {
        host.resume(id, { model: values.model });
        await chat(host, id);
        break;
      }
      const state = { streamed: false, reasoning: false };
      host.subscribe((e) => printEvent(e, id, state));
      wireApprovals(host);
      host.resume(id, { model: values.model });
      const r = await host.wait(id);
      console.log(c.dim(`\nsession ${id} · ${r?.status}${r?.reason ? ` (${r.reason})` : ''}`));
      process.exitCode = r?.status === 'idle' ? 0 : 3;
      break;
    }
    case 'sessions':
      listSessions(host);
      break;
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
        // launchd runs a self-contained copy from ~/.sun/bin (outside TCC-protected folders like ~/Downloads).
        const here = fileURLToPath(import.meta.url);
        const bundle = join(here, '..', 'sun.mjs');
        if (!existsSync(bundle)) throw new Error(`Missing ${bundle}. Run: pnpm build:core`);
        const cliPath = join(sunHome(), 'bin', 'sun.mjs');
        mkdirSync(join(cliPath, '..'), { recursive: true });
        copyFileSync(bundle, cliPath);
        const { label, xml } = launchdPlist({ nodePath: process.execPath, cliPath, hour: host.config.intel.hour, minute: host.config.intel.minute });
        const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
        mkdirSync(join(plist, '..'), { recursive: true });
        writeFileSync(plist, xml);
        spawnSync('launchctl', ['unload', plist]);
        const r = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
        console.log(r.status === 0 ? c.green(`Installed ${plist} (daily ${host.config.intel.hour}:${String(host.config.intel.minute).padStart(2, '0')})`) : c.red(r.stderr));
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
