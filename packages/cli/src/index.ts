#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  HarnessHost,
  RemoteHost,
  GatewayClient,
  BUNDLE_MAX_BYTES,
  SETTINGS_PROTOCOL_VERSION,
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
  type RunStatus,
  type SessionHost,
  type SessionSummary,
  type HookFixture,
  type HookFixtureRequest,
  type HookFixtureResult,
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
  type Automation,
  type FileChange,
  formatContextReport,
  formatUsd,
  imageMime,
  type MemoryKind,
  MCP_PRESETS,
  addMcpPreset,
  formatMetrics,
  readBriefing,
  recordMic,
  type PublicSettings,
  type PluginState,
  type SettingsPatch,
  type SettingsSnapshot,
  type SettingsWriteResult,
  loadConfig,
  providerKey,
  transcribe,
  localDate,
  BrowserManager,
  BrowserPermissions,
  type BrowserAction,
  type BrowserDecision,
  type BrowserPermissionsSnapshot,
  type BrowserPermissionResult,
  findChrome,
  createSandbox,
  shq,
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
  sun browser status | login [url] [--profile name] | stop
  sun browser permissions [set <origin> <browse|upload|download> <allow|deny|ask>] [--remote name | --local]
  sun export <sessionId> [--format markdown|html|jsonl|bundle] [-o file]
  sun import <file.jsonl|file.sunbundle> [--cwd workspace] | sun search <text> | sun commands
  sun context <sessionId> [--format html -o report.html]   What fills the session's context (and how to shrink it)
  sun changes <sessionId> [--diff | --json]   Files the session changed (A/M/D, +/−); diffs
  sun automations list | add "<when>" "<prompt>" | preview <when> | run <id> | pause | resume | edit <id> [--schedule --prompt --title] | rm | history <id>
  sun pin | unpin | archive | unarchive <sessionId>        Organize sessions (sun sessions --all shows archived)
  sun run "<prompt>" --output stream-json [--image shot.png]   JSON lines for scripts; attach images
  sun memory list | search <query> | add <text> [--kind preference] | rm <id> | extract <sessionId>   Long-term memory
  sun briefing run | show [date] | enable [--at 08:30] | disable    Daily briefing (runs in the gateway/desktop background)
  sun hooks list | trust <id> <digest> | revoke <id> <digest> [--cwd dir]
  sun hooks preview <id> <digest> [--fixture read|shell|edit] [--cwd dir]
  sun hooks test <id> <digest> --execute [--fixture read|shell|edit] [--cwd dir]
  sun trigger list | fire <id> [payload]    Event triggers (file watches, webhooks: POST /trigger/<id>)
  sun metrics [--days 7]      Conversation efficiency per mode
  sun voice transcribe <audio-file> | record [--seconds 8]   Speech to text (config.voice.stt)
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
  sun worktree preview <id...> | cleanup <revision> <id...> | setup <id> <hook-id> <digest> | reconcile <id>
  sun skills | sun mcp [presets | add <preset>] | sun schedules
  sun plugins [list | enable <name> | disable <name>] [--local | --remote <name>]
  sun serve [--port 4471] [--host 127.0.0.1]   Run the gateway (owns sessions; web UI; CLI/desktop attach)
  sun serve --tls [--host 0.0.0.0]              HTTPS with a self-signed, client-pinned certificate (required off localhost)
  sun gateway status | url | install [--tls --host ..] | uninstall   Gateway as a login service (launchd)
  sun gateway token create <device> | list | revoke <id|name>      Per-device tokens for remote clients and bots
  sun remote add <name> <url> --token <t> [--fingerprint <sha256>] | list | use <name> | off | remove <name>
  sun eval validate | run [--label x] [--model ..] [--only a,b] [--concurrency 4] [--best-of N] | list | report [run] | compare <a> <b>
  sun doctor
  sun capabilities                     # machine-readable settings capability states
  sun desktop                      Launch the desktop app (from a source checkout)

Session commands (chat, run, resume, sessions) use --remote <name>, else the default remote, else a local gateway; --local runs in-process.

Chat commands: /model <ref>  /mode <id> (coding|plan|agent|assistant)  /undo [n]  /rewind [n] [files]  /changes [all]  /diff [path]  /revert <path>  /review  /context  /compact  /cost  /export [md|html|jsonl] [file]  /voice [seconds]  /<custom>  /resume  /abort  /reflect  /sessions  /help  /exit
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

async function chat(host: SessionHost, initialSession: string): Promise<void> {
  let sessionId = initialSession;
  let pendingProposal: string | undefined;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Install the buffering iterator before any gateway calls can yield to stdin.
  const lines = rl[Symbol.asyncIterator]();
  let closed = false;
  rl.on('close', () => (closed = true));
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
  const prompt = () => !closed && rl.prompt();
  rl.setPrompt(c.bold('\n› '));
  prompt();
  for await (const raw of lines) {
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
      try {
        if (cmd === 'help') {
          console.log(HELP);
          const custom = await host.listCommands();
          if (custom.length) console.log(`\nCustom commands:\n${custom.map((x) => `  /${x.name}${x.argumentHint ? ` ${x.argumentHint}` : ''}  ${c.dim(x.description)}`).join('\n')}`);
        }
        else if (cmd === 'model') {
          if (!arg) console.log((await host.readyModels()).join('\n'));
          else await host.switchModel(sessionId, arg), console.log(`Model → ${arg}`);
        } else if (cmd === 'mode') await host.switchMode(sessionId, arg), console.log(`Mode → ${arg}`);
        else if (cmd === 'resume') {
          await host.resume(sessionId, { model: arg || undefined });
          await host.wait(sessionId);
        } else if (cmd === 'abort') await host.abort(sessionId);
        else if (cmd === 'undo') printUndo(await host.undo(sessionId, { steps: Number(arg) || 1 }));
        else if (cmd === 'voice') {
          if (loadConfig().voice.enabled === false) throw new Error('Voice input is disabled.');
          const secs = Number(arg) || 8;
          console.log(c.dim(`Recording ${secs} s…`));
          const text = await localTranscribe(recordMic(secs), 'audio/mpeg');
          console.log(`${c.bold('› ')}${text}`);
          if (text) {
            await host.send(sessionId, text);
            await host.wait(sessionId);
          }
        }
        else if (cmd === 'sessions') await listSessions(host);
        else if (cmd === 'reflect') {
          const props = await host.reflect(sessionId);
          for (const p of props) console.log(`${p.id}  [${p.type}] ${p.title}`);
          console.log(c.dim('Accept with: sun evolve accept <id>'));
        } else if (cmd === 'compact') {
          console.log((await host.compact(sessionId)) ? 'Compacted older history into a summary.' : c.dim('Nothing to compact yet.'));
        } else if (cmd === 'changes') {
          const ev = await host.getEvents(sessionId);
          const lastUser = [...ev].reverse().find((e) => e.type === 'user/message' && (!e.source || e.source === 'user'));
          printChanges(await host.sessionChanges(sessionId, arg === 'all' || !lastUser ? {} : { fromSeq: lastUser.seq }), arg === 'all' ? 'this session' : 'the last turn');
        } else if (cmd === 'diff') {
          const changes = await host.sessionChanges(sessionId);
          const pick = arg ? changes.filter((x) => x.path === arg || x.path.endsWith(`/${arg}`)) : changes;
          if (!pick.length) console.log(arg ? `No changes to ${arg}.` : 'No changes in this session.');
          for (const ch of pick) console.log(colorDiff(ch.diff || `(${ch.status}${ch.binary ? ', binary' : ''})`));
        } else if (cmd === 'revert') {
          if (!arg) console.log('Usage: /revert <path>');
          else {
            await host.revertFile(sessionId, arg);
            console.log(`Reverted ${arg} to its state before this session (/undo brings the edit back).`);
          }
        } else if (cmd === 'review') {
          console.log(await host.reviewSession(sessionId));
        } else if (cmd === 'context') {
          console.log(formatContextReport(await host.contextUsage(sessionId)));
        } else if (cmd === 'cost' || cmd === 'status') {
          await statusLine(host, sessionId, true);
        } else if (cmd === 'export') {
          const [fmt = 'markdown', file] = rest;
          const format = fmt.startsWith('h') ? 'html' : fmt.startsWith('j') ? 'jsonl' : 'markdown';
          const out = file ?? join(process.cwd(), `${sessionId}.${format === 'markdown' ? 'md' : format}`);
          writeFileSync(out, await host.exportSession(sessionId, format));
          console.log(`Exported to ${out}`);
        } else if (cmd === 'rewind') {
          const users = (await host.getEvents(sessionId)).filter((e) => e.type === 'user/message' && (!e.source || e.source === 'user')) as Extract<LiveEventSession, { type: 'user/message' }>[];
          const n = Number(rest[0]);
          if (!n) {
            users.forEach((u, i) => console.log(`${String(i + 1).padStart(3)}  ${(u.command?.input ?? u.text).split('\n')[0].slice(0, 100)}`));
            console.log(c.dim('/rewind <n> [files] — new session with the conversation before message n; "files" also undoes its file edits.'));
          } else if (!users[n - 1]) console.log(`No message ${n}.`);
          else {
            const r = await host.fork(sessionId, { beforeSeq: users[n - 1].seq, restoreFiles: rest[1] === 'files' });
            sessionId = r.session.id;
            console.log(`Rewound into session ${sessionId}. Message ${n} was:\n${c.dim(r.text)}\nType it again (edited) or anything else.`);
          }
        } else if ((await host.listCommands()).some((x) => x.name === cmd)) {
          await host.send(sessionId, line);
          await host.wait(sessionId);
          await statusLine(host, sessionId);
        } else console.log(`Unknown command /${cmd}`);
      } catch (error) {
        console.log(c.red(`✗ /${cmd} failed: ${error instanceof Error ? error.message : String(error)}`));
      }
      prompt();
      continue;
    }
    if (pendingProposal) {
      const answer = line.toLowerCase();
      const action = /^(y|yes|是|好)/.test(answer) ? 'create' : /^(b|both)/.test(answer) ? 'both' : 'run';
      const r = await host.resolveProposal(sessionId, pendingProposal, action);
      pendingProposal = undefined;
      if (r.automation) console.log(c.green(`Automation ${r.automation.id} created: ${r.automation.title} — ${r.automation.description}`));
      if (action !== 'create') {
        await host.wait(sessionId);
        await turnSummary(host, sessionId);
      }
      prompt();
      continue;
    }
    await host.send(sessionId, line);
    await host.wait(sessionId);
    const evs = await host.getEvents(sessionId);
    const lastUserSeq = [...evs].reverse().find((e) => e.type === 'user/message')?.seq ?? -1;
    const lastEv = evs.find((e) => e.type === 'automation/proposal' && e.seq > lastUserSeq) as Extract<LiveEventSession, { type: 'automation/proposal' }> | undefined;
    if (lastEv) {
      pendingProposal = lastEv.proposalId;
      console.log(`${c.yellow('⏲ Schedule this?')} “${lastEv.title}” — ${lastEv.description}\n${c.dim('[y] create the automation · [b] create and also answer now · [n] just answer now')}`);
      prompt();
      continue;
    }
    await turnSummary(host, sessionId);
    prompt();
  }
  await host.wait(sessionId);
  rl.close();
}

/** Speech to text without a host (chat may be attached to a remote gateway). */
async function localTranscribe(audio: Buffer, mime: string): Promise<string> {
  const cfg = loadConfig();
  if (cfg.voice.enabled === false) throw new Error('Voice input is disabled.');
  const [pid, ...rest] = cfg.voice.stt.split('/');
  const p = cfg.providers[pid];
  if (!p) throw new Error(`Unknown provider in voice.stt: ${cfg.voice.stt}`);
  return transcribe(audio, mime, { baseUrl: p.baseUrl, apiKey: providerKey(p), model: rest.join('/') });
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
    console.log(r.applied ? c.green('Merged into the checkout (staged, squash).') : c.dim(`Review: sun worktree diff ${r.winner.sessionId}   Keep: sun worktree merge ${r.winner.sessionId}`));
    if (r.retained.length) console.log(`Retained worktrees: ${r.retained.join(', ')}`);
  }
  process.exitCode = r.winner ? 0 : 1;
}

type LiveEventSession = Awaited<ReturnType<SessionHost['getEvents']>>[number];

/** One dim line after each turn: model, mode, tokens, cache share, estimated cost (Claude Code-style status). */
async function statusLine(host: SessionHost, sessionId: string, verbose = false): Promise<void> {
  const s = (await host.listSessions()).find((x) => x.id === sessionId);
  const cost = await host.cost(sessionId);
  let input = 0;
  let cached = 0;
  let output = 0;
  for (const m of cost.byModel) {
    input += m.input;
    cached += m.cached;
    output += m.output;
  }
  const parts = [s?.model, s?.mode, `${((input + output) / 1000).toFixed(1)}k tok`, input ? `${Math.round((cached / input) * 100)}% cached` : '', cost.byModel.length ? `${formatUsd(cost.usd)}${cost.unpriced.length ? '+' : ''}` : ''].filter(Boolean);
  console.log(c.dim(parts.join(' · ')));
  if (verbose) for (const m of cost.byModel) console.log(c.dim(`  ${m.model}: ${m.input} in (${m.cached} cached) / ${m.output} out${m.usd !== undefined ? ` · ${formatUsd(m.usd)}` : ' · no price (add "pricing" in config)'}`));
}

function colorDiff(d: string): string {
  return d
    .split('\n')
    .map((l) => (l.startsWith('+') && !l.startsWith('+++') ? c.green(l) : l.startsWith('-') && !l.startsWith('---') ? c.red(l) : l.startsWith('@@') ? c.cyan(l) : l))
    .join('\n');
}

function printChanges(changes: FileChange[], scope: string): void {
  if (!changes.length) return void console.log(c.dim(`No file changes in ${scope}.`));
  const add = changes.reduce((n, x) => n + x.additions, 0);
  const del = changes.reduce((n, x) => n + x.deletions, 0);
  console.log(`${c.bold(`${changes.length} file${changes.length > 1 ? 's' : ''} changed`)} in ${scope} ${c.green(`+${add}`)} ${c.red(`−${del}`)}`);
  for (const x of changes) console.log(`  ${x.status === 'added' ? c.green('A') : x.status === 'deleted' ? c.red('D') : c.yellow('M')} ${x.path}  ${c.dim(x.binary ? 'binary' : `+${x.additions} −${x.deletions}`)}`);
  console.log(c.dim('  /diff [path] shows the diff · /revert <path> restores a file · /changes all for the whole session'));
}

/** After each turn: the status line, and the files this turn changed (Codex/Cursor-style summary). */
async function turnSummary(host: SessionHost, sessionId: string): Promise<void> {
  const ev = await host.getEvents(sessionId);
  const lastUser = [...ev].reverse().find((e) => e.type === 'user/message' && (!e.source || e.source === 'user'));
  if (lastUser) {
    const changes = await host.sessionChanges(sessionId, { fromSeq: lastUser.seq });
    if (changes.length) printChanges(changes, 'this turn');
  }
  await statusLine(host, sessionId);
}

async function listSessions(host: SessionHost, all = false): Promise<void> {
  const list = (await host.listSessions()).filter((s) => all || !s.archived).sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
  for (const s of list.slice(0, 30)) {
    const st = s.status === 'paused' ? c.yellow(`paused:${s.statusReason}`) : s.status === 'error' ? c.red('error') : c.dim(s.status);
    const ctx = s.contextTokens && s.contextWindow ? `${Math.round((s.contextTokens / s.contextWindow) * 100)}%`.padStart(4) : '    ';
    console.log(`${s.pinned ? '📌' : '  '}${s.id}  ${st.padEnd(20)} ${c.dim(s.mode.padEnd(9))} ${(s.archived ? c.dim(`[archived] ${s.title}`) : s.title).slice(0, 50).padEnd(50)} ${c.dim(`${ctx} ctx · ${s.model}`)}`);
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

async function editHostSettings(
  host: HarnessHost,
  local: boolean | undefined,
  changes: (config: PublicSettings) => Record<string, unknown>,
): Promise<void> {
  const gateway = local ? undefined : await findGateway();
  const client = gateway ? new GatewayClient(gateway) : undefined;
  const snapshot = client ? await client.call<SettingsSnapshot>('getSettings', SETTINGS_PROTOCOL_VERSION) : host.getSettings();
  const patch: SettingsPatch = { expectedRevision: snapshot.revision, scope: 'host', changes: changes(snapshot.values) };
  const result = client ? await client.call<SettingsWriteResult>('updateSettings', patch, SETTINGS_PROTOCOL_VERSION) : host.updateSettings(patch);
  if (!result.ok) {
    const keys = Object.keys(result.fields ?? {});
    throw new Error(`Could not save settings (${result.code})${keys.length ? `: ${keys.join(', ')}` : ''}. Try again after checking the current settings.`);
  }
  if (result.audit === 'incomplete') console.warn('Settings saved, but the audit record could not be completed.');
  if (result.durability === 'uncertain') console.warn('Settings saved, but disk synchronization could not be confirmed.');
}

async function doctor(host: HarnessHost, cwd: string): Promise<void> {
  console.log(c.bold('Home: ') + sunHome());
  console.log(c.bold('Default model: ') + host.config.defaultModel);
  console.log(c.bold('Approval: ') + host.config.approval);
  console.log(c.bold('Providers:'));
  for (const p of Object.values(host.getSettings().values.providers)) {
    console.log(`  ${p.configured ? c.green('●') : c.dim('○')} ${p.id.padEnd(11)} ${c.dim(p.baseUrl || '(private endpoint)')} ${c.dim(`(${p.source})`)}`);
  }
  console.log(c.bold('Skills: ') + host.listSkills(cwd).length);
  console.log(c.bold('MCP servers: ') + loadMcpConfig(cwd).map((s) => s.name).join(', '));
  const hooks = host.listHooks(cwd);
  console.log(c.bold('Hooks: ') + `${hooks.hooks.filter(hook => hook.status === 'trusted').length} trusted, ${hooks.hooks.filter(hook => hook.status === 'untrusted').length} need review`);
  for (const issue of hooks.diagnostics) console.log(`  ${issue.scope} ${issue.event ?? 'source'}: ${issue.code} (${issue.source})`);
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
    const e = await addRemote({ name, url, token: values.token, fingerprint: values.fingerprint }, async entry => {
      const { hostId, label } = await new GatewayClient(entry).connection();
      return { hostId, label };
    });
    console.log(`${c.green('Connected')}: ${e.name} → ${e.url} · ${e.label} (${e.hostId})${e.fingerprint ? `  (pinned ${e.fingerprint})` : ''}`);
  } else if (sub === 'list') {
    const r = loadRemotes();
    for (const e of r.remotes) console.log(`${e.name === r.default ? c.green('*') : ' '} ${e.name.padEnd(12)} ${e.url}${e.label ? ` · ${e.label}` : ''}${e.fingerprint ? c.dim(`  ${e.fingerprint.slice(0, 23)}…`) : c.yellow('  (no TLS)')}`);
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

function runExitCode(status: RunStatus | undefined): number {
  return status === 'idle' ? 0 : status === 'paused' ? 3 : 1;
}

async function sessionCommands(
  host: SessionHost,
  cmd: string,
  args: string[],
  values: { mode?: string; model?: string; json?: boolean; chat?: boolean; worktree?: boolean; base?: string; steps?: string; sandbox?: string; output?: string; image?: string[]; all?: boolean },
  sessionCwd: string | undefined,
  approval: ApprovalMode | undefined,
  repoCwd?: string,
): Promise<void> {
  switch (cmd) {
    case 'chat': {
      const s = await host.createSession({ cwd: sessionCwd, repoCwd, mode: values.mode, model: values.model, worktree: values.worktree, worktreeBase: values.base, approval, sandbox: values.sandbox as SandboxMode | undefined });
      await chat(host, s.id);
      break;
    }
    case 'run': {
      const prompt = args.join(' ') || (!process.stdin.isTTY ? readFileSync(0, 'utf8') : '');
      if (!prompt) throw new Error('Usage: sun run "<prompt>"');
      const s = await host.createSession({ cwd: sessionCwd, repoCwd, mode: values.mode, model: values.model, worktree: values.worktree, worktreeBase: values.base, approval, sandbox: values.sandbox as SandboxMode | undefined });
      const state = { streamed: false, reasoning: false };
      const stream = values.output === 'stream-json';
      // stream-json: one JSON object per line (live deltas and durable events), then a final {"type":"result"}.
      if (stream) host.subscribe((e) => ('sessionId' in e && e.sessionId === s.id) && console.log(JSON.stringify(e)));
      else if (!values.json) host.subscribe((e) => printEvent(e, s.id, state));
      wireApprovals(host);
      await host.ready?.();
      const images = (values.image ?? []).map((f) => ({ data: readFileSync(f).toString('base64'), mime: imageMime(f) ?? 'image/png' }));
      await host.send(s.id, prompt, 'user', { images, noDetect: true });
      let r = await host.wait(s.id);
      // Background jobs deliver their results as new turns; stay until they and those turns finish.
      while ((await host.listJobs(s.id)).some((j) => j.state === 'running') || (await host.isRunning(s.id))) {
        await new Promise((res) => setTimeout(res, 300));
        r = (await host.wait(s.id)) ?? r;
      }
      const last = [...(await host.getEvents(s.id))].reverse().find((e) => e.type === 'assistant/message') as { text: string } | undefined;
      const cost = await host.cost(s.id);
      if (stream) console.log(JSON.stringify({ type: 'result', sessionId: s.id, status: r?.status, reason: r?.reason, text: last?.text ?? '', costUsd: cost.usd }));
      else if (values.json) console.log(JSON.stringify({ sessionId: s.id, status: r?.status, reason: r?.reason, text: last?.text ?? '', costUsd: cost.usd }, null, 2));
      else {
        const changes = await host.sessionChanges(s.id);
        if (changes.length) printChanges(changes, 'this run');
        console.log(c.dim(`\nsession ${s.id} · ${r?.status}${r?.reason ? ` (${r.reason})` : ''}`));
      }
      process.exitCode = runExitCode(r?.status);
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
      process.exitCode = runExitCode(r?.status);
      break;
    }
    case 'sessions':
      await listSessions(host, values.all);
      break;
    case 'undo': {
      if (!args[0]) throw new Error('Usage: sun undo <sessionId> [--steps n]');
      printUndo(await host.undo(args[0], { steps: Number(values.steps) || 1 }));
      break;
    }
  }
  await host.dispose();
}

async function saveBundle(bundle: Readable, output?: string): Promise<void> {
  if (!output) {
    await pipeline(bundle, process.stdout, { end: false });
    return;
  }
  const target = resolve(output);
  const stage = mkdtempSync(join(dirname(target), '.sun-export-'));
  try {
    const file = join(stage, 'session.sunbundle');
    await pipeline(bundle, createWriteStream(file, { flags: 'wx', mode: 0o600, flush: true }));
    renameSync(file, target);
    console.log(`Exported to ${output}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

async function transferSession(
  command: 'import' | 'export', source: string | undefined,
  options: { local?: boolean; remote?: string; cwd?: string; format?: string; output?: string },
): Promise<void> {
  if (!source) throw new Error(command === 'import'
    ? 'Usage: sun import <file.jsonl|file.sunbundle> [--cwd workspace]'
    : 'Usage: sun export <sessionId> [--format markdown|html|jsonl|bundle] [-o file]');
  const remote = !options.local && getRemote(options.remote);
  if (!options.local && options.remote && !remote) throw new Error(`No remote named ${options.remote} (sun remote list).`);
  const target = remote || (!options.local && await findGateway());
  const gateway = target ? new GatewayClient(target) : undefined;
  const local = gateway ? undefined : new HarnessHost({ connectMcp: false, loadPlugins: false, shellHooks: false });
  try {
    if (command === 'export') {
      const format = options.format ?? 'markdown';
      if (format === 'bundle') {
        await saveBundle(gateway ? await gateway.exportSessionBundle(source) : local!.exportSessionBundle(source), options.output);
        return;
      }
      if (format !== 'markdown' && format !== 'html' && format !== 'jsonl') throw new Error('Unknown transcript export format.');
      const text = gateway ? await gateway.call<string>('exportSession', source, format) : local!.exportSession(source, format);
      if (options.output) {
        writeFileSync(options.output, text);
        console.log(`Exported to ${options.output}`);
      } else process.stdout.write(text + '\n');
      return;
    }
    const input = options.cwd ? { cwd: gateway ? options.cwd : resolve(options.cwd) } : {};
    let imported: SessionSummary;
    if (source.toLowerCase().endsWith('.sunbundle')) {
      const file = createReadStream(source);
      try {
        imported = await (gateway ? gateway.importSessionBundle(file, input) : local!.importSessionBundle(file, input));
      } finally {
        file.destroy();
      }
    } else {
      const stat = statSync(source);
      if (!stat.isFile() || stat.size > BUNDLE_MAX_BYTES) throw new Error('Invalid transcript file or import size exceeds the limit.');
      const text = readFileSync(source, 'utf8');
      imported = gateway ? await gateway.call<SessionSummary>('importSession', text, input) : local!.importSession(text, input);
    }
    console.log(`Imported as ${imported.id} (${imported.title}). Continue with: sun resume ${imported.id} --chat`);
  } finally {
    await local?.dispose();
  }
}

async function hookCommand(
  [action = 'list', id, digest]: string[],
  options: { cwd?: string; remote?: string; local?: boolean; fixture?: string; execute?: boolean },
): Promise<void> {
  const remote = !options.local && getRemote(options.remote);
  if (!options.local && options.remote && !remote) throw new Error(`No remote named ${options.remote} (sun remote list).`);
  const target = remote || (!options.local && await findGateway());
  const client = target ? new GatewayClient(target) : undefined;
  const host = client ? undefined : new HarnessHost({ connectMcp: false, loadPlugins: false });
  const cwd = remote ? options.cwd : resolve(options.cwd ?? process.cwd());
  if (!cwd) throw new Error('Provide --cwd with a workspace on the remote execution host.');
  const call = <T>(method: string, local: () => T | Promise<T>, ...args: unknown[]): Promise<T> =>
    client ? client.call<T>(method, ...args, SETTINGS_PROTOCOL_VERSION) : Promise.resolve(local());
  try {
    if (action === 'list') {
      console.log(JSON.stringify(await call('listHooks', () => host!.listHooks(cwd), cwd), null, 2));
      return;
    }
    if (!id || !digest) throw new Error('Choose a hook ID and digest from sun hooks list.');
    if (action === 'trust' || action === 'revoke') {
      const changes = [{ id, digest, trust: action === 'trust' }];
      console.log(JSON.stringify(await call('reviewHooks', () => host!.reviewHooks(cwd, changes), cwd, changes), null, 2));
      return;
    }
    if (action !== 'preview' && action !== 'test') throw new Error('Unknown hooks command. See sun --help.');
    if (action === 'test' && !options.execute) throw new Error('Use --execute to run a reviewed hook. Use preview to inspect the fixture.');
    const requestId = randomUUID();
    const request: HookFixtureRequest = { cwd, id, digest, fixture: (options.fixture ?? 'read') as HookFixture, execute: action === 'test', requestId };
    const cancel = () => { void call('cancelHookFixture', () => host!.cancelHookFixture(requestId), requestId).catch(() => undefined); };
    if (request.execute) process.on('SIGINT', cancel);
    try {
      const result = await call<HookFixtureResult>('runHookFixture', () => host!.runHookFixture(request), request);
      console.log(JSON.stringify(result, null, 2));
      if (result.execution) process.exitCode = result.execution.code;
    } finally {
      process.off('SIGINT', cancel);
    }
  } finally {
    await host?.dispose();
  }
}

async function pluginCommand([action = 'list', name, ...rest]: string[], options: { remote?: string; local?: boolean }): Promise<void> {
  if (rest.length || !(action === 'list' && !name || (action === 'enable' || action === 'disable') && name)) {
    throw new Error('Use sun plugins list, sun plugins enable <name>, or sun plugins disable <name>.');
  }
  const remote = !options.local && getRemote(options.remote);
  if (!options.local && options.remote && !remote) throw new Error(`No remote named ${options.remote} (sun remote list).`);
  const target = remote || (!options.local && await findGateway());
  const client = target ? new GatewayClient(target) : undefined;
  const host = client ? undefined : new HarnessHost({ connectMcp: false, shellHooks: false });
  const list = () => client ? client.call<PluginState[]>('listPlugins') : host!.pluginStates;
  try {
    if (action === 'list') {
      console.log(JSON.stringify(await list(), null, 2));
      return;
    }
    const snapshot = client ? await client.call<SettingsSnapshot>('getSettings', SETTINGS_PROTOCOL_VERSION) : host!.getSettings();
    const request = { name: name!, enabled: action === 'enable', expectedRevision: snapshot.revision };
    const result = client ? await client.call<SettingsWriteResult>('setPluginEnabled', request, SETTINGS_PROTOCOL_VERSION) : await host!.setPluginEnabled(request);
    if (!result.ok) throw new Error(`Plugin state could not change (${result.code}${result.fields?.plugin ? ` · ${result.fields.plugin}` : ''}).`);
    console.log(JSON.stringify({ plugin: (await list()).find(plugin => plugin.name === name), audit: result.audit, durability: result.durability }, null, 2));
  } finally {
    await host?.dispose();
  }
}

async function browserPermissionsCommand([command, origin, action, decision, ...extra]: string[], options: { remote?: string; local?: boolean }): Promise<void> {
  if (command !== undefined && (command !== 'set' || !origin || !['browse', 'upload', 'download'].includes(action)
    || !['allow', 'deny', 'ask'].includes(decision) || extra.length)) {
    throw new Error('Use sun browser permissions or sun browser permissions set <origin> <browse|upload|download> <allow|deny|ask>.');
  }
  const remote = !options.local && getRemote(options.remote);
  if (!options.local && options.remote && !remote) throw new Error(`No remote named ${options.remote} (sun remote list).`);
  const target = remote || (!options.local && await findGateway());
  const client = target ? new GatewayClient(target) : undefined;
  const permissions = new BrowserPermissions();
  const snapshot = client ? await client.call<BrowserPermissionsSnapshot>('browserPermissions', SETTINGS_PROTOCOL_VERSION) : permissions.snapshot();
  if (!command) {
    console.log(JSON.stringify(snapshot, null, 2));
    return;
  }
  const request = { expectedRevision: snapshot.revision, origin, action: action as BrowserAction, decision: decision as BrowserDecision };
  const result = client ? await client.call<BrowserPermissionResult>('updateBrowserPermission', request, SETTINGS_PROTOCOL_VERSION) : permissions.update(request);
  if (!result.ok) throw new Error(`Browser permission could not change (${result.code}).`);
  console.log(JSON.stringify(result, null, 2));
}

async function worktreeCommand([action = 'list', id, ...rest]: string[], options: { remote?: string; local?: boolean; strategy?: string }): Promise<void> {
  const remote = !options.local && getRemote(options.remote);
  if (!options.local && options.remote && !remote) throw new Error(`No remote named ${options.remote} (sun remote list).`);
  const target = remote || (!options.local && await findGateway());
  const client = target ? new GatewayClient(target) : undefined;
  const host = client ? undefined : new HarnessHost({ connectMcp: false, loadPlugins: false });
  const call = <T>(method: string, local: () => T | Promise<T>, ...args: unknown[]): Promise<T> =>
    client ? client.call<T>(method, ...args) : Promise.resolve(local());
  const print = (result: unknown) => console.log(JSON.stringify(result, null, 2));
  try {
    if (action === 'list') return print(await call('worktreeInventory', () => host!.worktreeInventory()));
    if (!id) throw new Error('Provide a worktree session ID or the cleanup revision.');
    if (action === 'status') return print(await call('worktreeStatus', () => host!.worktreeStatus(id), id));
    if (action === 'diff') return console.log(await call('worktreeDiff', () => host!.worktreeDiff(id), id));
    if (action === 'preview') return print(await call('previewWorktreeCleanup', () => host!.previewWorktreeCleanup([id, ...rest]), [id, ...rest]));
    if (action === 'cleanup') return print(await call('cleanupWorktrees', () => host!.cleanupWorktrees(rest, id), rest, id));
    if (action === 'discard') return print(await call('discardWorktree', () => host!.discardWorktree(id), id));
    if (action === 'merge') {
      if (options.strategy && !['squash', 'merge'].includes(options.strategy)) throw new Error('Use squash or merge.');
      const strategy = options.strategy === 'merge' ? 'merge' : 'squash';
      return print(await call('mergeWorktree', () => host!.mergeWorktree(id, { strategy }), id, strategy));
    }
    if (action === 'setup' && rest.length === 2) {
      const cancel = () => { void call('abort', () => host!.abort(id), id).catch(() => undefined); };
      process.on('SIGINT', cancel);
      try { return print(await call('runWorktreeSetup', () => host!.runWorktreeSetup(id, rest[0], rest[1]), id, ...rest)); }
      finally { process.off('SIGINT', cancel); }
    }
    if (action === 'reconcile') {
      await call('acknowledgeWorktreeRecovery', () => host!.acknowledgeWorktreeRecovery(id), id);
      return console.log('Recovery acknowledged.');
    }
    throw new Error(`Unknown worktree command ${action}`);
  } finally {
    await host?.dispose();
  }
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
      base: { type: 'string' },
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
      diff: { type: 'boolean' },
      schedule: { type: 'string' },
      prompt: { type: 'string' },
      title: { type: 'string' },
      all: { type: 'boolean' },
      kind: { type: 'string' },
      output: { type: 'string', short: 'o' },
      image: { type: 'string', multiple: true },
      format: { type: 'string' },
      at: { type: 'string' },
      days: { type: 'string' },
      seconds: { type: 'string' },
      profile: { type: 'string' },
      sandbox: { type: 'string' },
      apply: { type: 'boolean' },
      steps: { type: 'string' },
      fingerprint: { type: 'string' },
      fixture: { type: 'string' },
      execute: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return void console.log(HELP);
  const [cmd = 'chat', ...args] = positionals;
  const cwd = resolve(values.cwd ?? process.cwd());
  // Coding works in the current folder; agent/assistant use ~/.sun/workspace unless --cwd is given (specs/007).
  const sessionCwd = values.cwd ? cwd : undefined;
  const approval = values.approval as ApprovalMode | undefined;
  if (cmd === 'serve') return serve(values);
  if (cmd === 'gateway') return gatewayCommand(args[0] ?? 'status', args.slice(1), values);
  if (cmd === 'remote') return remoteCommand(args[0] ?? 'list', args.slice(1), values);
  if (cmd === 'hooks') return hookCommand(args, values);
  if (cmd === 'browser' && args[0] === 'permissions') return browserPermissionsCommand(args.slice(1), values);
  if (cmd === 'plugins') return pluginCommand(args, values);
  if (cmd === 'worktree') return worktreeCommand(args, values);
  if (cmd === 'eval') return evalCommand(args[0] ?? 'list', args.slice(1), values);
  if (cmd === 'import' || cmd === 'export') return transferSession(cmd, args[0], values);

  // Session commands: --local > --remote <name> > default remote > local gateway > in-process.
  // Best-of-N runs in-process: its worktrees and test judging need the local disk.
  const bestOf = cmd === 'run' && Number(values['best-of']) > 1;
  if (['chat', 'run', 'resume', 'sessions', 'undo'].includes(cmd) && !values.local && !bestOf) {
    const remote = getRemote(values.remote);
    if (values.remote && !remote) throw new Error(`No remote named ${values.remote} (sun remote list).`);
    if (remote) return sessionCommands(new RemoteHost(remote), cmd, args, values, values.cwd ? cwd : undefined, approval);
    const gw = await findGateway();
    if (gw) return sessionCommands(new RemoteHost(gw), cmd, args, values, sessionCwd, approval, cwd);
  }

  if (cmd === 'capabilities' && !values.local) {
    const gateway = await findGateway();
    if (gateway) {
      const capabilities = await new GatewayClient(gateway).call('listCapabilities', SETTINGS_PROTOCOL_VERSION);
      console.log(JSON.stringify({ protocolVersion: SETTINGS_PROTOCOL_VERSION, capabilities }, null, 2));
      return;
    }
  }

  const needsMcp = ['chat', 'run', 'resume', 'mcp', 'capabilities'].includes(cmd);
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
    await sessionCommands(host, cmd, args, values, sessionCwd, approval, cwd);
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
        const r = await host.analyzeIntel(args[1] ?? localDate());
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
    case 'browser': {
      const sub = args[0] ?? 'status';
      const cfg = { ...host.config.browser, ...(values.profile ? { profile: values.profile } : {}) };
      if (sub === 'status') {
        const b = new BrowserManager(() => cfg);
        console.log(`${b.available() ? c.green('available') : c.yellow('unavailable')}  mode ${cfg.mode} · ${b.describe()}`);
        const profile = b.profile();
        console.log(c.dim(profile.location ? `managed profile: ${profile.location}` : `profile owner: ${profile.owner}`));
      } else if (sub === 'login') {
        const url = args[1] ?? 'about:blank';
        if (cfg.mode === 'cdp') throw new Error('Sign in using the browser that owns this external DevTools profile.');
        if (cfg.mode === 'docker') {
          const b = new BrowserManager(() => cfg);
          try {
            await b.openManualLogin(url);
            console.log(`Sign in through the live view: ${c.bold(b.vncUrl ?? '(no VNC port)')}\nPress Enter here when done.`);
            await new Promise((r) => process.stdin.once('data', r));
          } finally {
            await b.dispose();
          }
        } else {
          const chrome = findChrome(cfg.chromePath);
          if (!chrome) throw new Error('No Chrome/Chromium/Edge/Brave found (set browser.chromePath).');
          const profile = new BrowserManager(() => cfg).profile().location;
          if (!profile) throw new Error('Invalid browser profile name.');
          mkdirSync(profile, { recursive: true });
          console.log(`Opening ${url} with profile "${cfg.profile}". Sign in, then close the window; the agent reuses the session.`);
          spawnSync(chrome, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', url], { stdio: 'ignore' });
        }
      } else if (sub === 'stop') {
        const stopped = new BrowserManager(() => cfg).stopDockerProfile();
        console.log(stopped ? 'Stopped the managed browser container.' : 'No managed browser container was running.');
        console.log('Local Chrome stops with the sun process that started it.');
      } else throw new Error(`Unknown browser command ${sub}`);
      break;
    }
    case 'changes': {
      const id = args[0] ?? host.listSessions()[0]?.id;
      if (!id) throw new Error('Usage: sun changes <sessionId> [--diff]');
      const changes = host.sessionChanges(id);
      if (values.json) console.log(JSON.stringify(changes, null, 2));
      else {
        printChanges(changes, `session ${id}`);
        if (values.diff) for (const ch of changes) console.log('\n' + colorDiff(ch.diff || `(${ch.status}${ch.binary ? ', binary' : ''}) ${ch.path}`));
      }
      break;
    }
    case 'automations':
    case 'automation': {
      const sub = args[0] ?? 'list';
      const fmt = (a: Automation) => `${a.enabled ? c.green('●') : c.dim('○')} ${a.id}  ${a.title.slice(0, 40).padEnd(40)} ${c.dim(`${a.description}${a.nextRun ? ` · next ${new Date(a.nextRun).toLocaleString()}` : ''}${a.lastStatus ? ` · last ${a.lastStatus}` : ''} · ${a.mode}`)}`;
      if (sub === 'list') {
        const list = host.listAutomations();
        for (const a of list) console.log(fmt(a));
        if (!list.length) console.log(c.dim('No automations. sun automations add "every weekday at 9" "summarize my unread mail", or just say it in a chat.'));
      } else if (sub === 'add') {
        const [schedule, ...p] = args.slice(1);
        if (!schedule || !p.length) throw new Error('Usage: sun automations add "<when>" "<prompt>" [--mode m] [--model m] [--cwd dir]');
        console.log(fmt(host.createAutomation({ schedule, prompt: p.join(' '), mode: values.mode, model: values.model, cwd: values.cwd ? cwd : undefined })));
      } else if (sub === 'preview') {
        const p = host.previewSchedule(args.slice(1).join(' '));
        console.log(p ? `${p.cron ?? p.at} · ${p.description}\nnext: ${p.next.map((d) => new Date(d).toLocaleString()).join(' · ')}` : 'Not understood.');
      } else if (sub === 'run') {
        const sid = await host.runAutomation(args[1] ?? '');
        console.log(c.dim(`Running in session ${sid}…`));
        await host.wait(sid);
        console.log(([...host.getEvents(sid)].reverse().find((e) => e.type === 'assistant/message') as { text?: string } | undefined)?.text ?? '');
      } else if (sub === 'pause' || sub === 'resume') console.log(fmt(host.updateAutomation(args[1] ?? '', { enabled: sub === 'resume' })));
      else if (sub === 'edit') {
        console.log(fmt(host.updateAutomation(args[1] ?? '', { ...(values.schedule ? { schedule: values.schedule } : {}), ...(values.prompt ? { prompt: values.prompt } : {}), ...(values.title ? { title: values.title } : {}), ...(values.mode ? { mode: values.mode } : {}), ...(values.model ? { model: values.model } : {}) })));
      } else if (sub === 'rm' || sub === 'delete') {
        host.deleteAutomation(args[1] ?? '');
        console.log('Deleted.');
      } else if (sub === 'history') {
        const a = host.listAutomations().find((x) => x.id === args[1]);
        if (!a) throw new Error(`No automation ${args[1]}`);
        for (const r of a.runs ?? []) console.log(`${new Date(r.at).toLocaleString()}  ${r.status ?? ''}${r.catchUp ? ' (catch-up)' : ''}  ${c.dim(r.sessionId)}`);
        if (!a.runs?.length) console.log(c.dim('No runs yet.'));
      } else throw new Error(`Unknown automations command ${sub}`);
      break;
    }
    case 'context': {
      const id = args[0] ?? host.listSessions()[0]?.id;
      if (!id) throw new Error('Usage: sun context <sessionId>');
      if (values.format === 'html') {
        const html = await host.contextReportHtml(id);
        if (values.output) {
          writeFileSync(values.output, html);
          console.log(`Report written to ${values.output}`);
        } else process.stdout.write(html);
      } else if (values.json) console.log(JSON.stringify(await host.contextUsage(id), null, 2));
      else console.log(formatContextReport(await host.contextUsage(id)));
      break;
    }
    case 'pin':
    case 'unpin':
    case 'archive':
    case 'unarchive': {
      if (!args[0]) throw new Error(`Usage: sun ${cmd} <sessionId>`);
      const s = host.setSessionFlags(args[0], cmd.endsWith('pin') ? { pinned: cmd === 'pin' } : { archived: cmd === 'archive' });
      console.log(`${s.title}: ${s.pinned ? 'pinned' : 'not pinned'}, ${s.archived ? 'archived' : 'active'}`);
      break;
    }
    case 'search':
      for (const r of host.searchSessions(args.join(' '))) console.log(`${r.id}  ${c.dim(r.mode.padEnd(9))} ${r.title.slice(0, 50).padEnd(50)} ${c.dim(r.snippet.slice(0, 80))}`);
      break;
    case 'commands':
      for (const x of host.listCommands(cwd)) console.log(`/${x.name}${x.argumentHint ? ` ${x.argumentHint}` : ''}  ${c.dim(`${x.description} · ${x.scope} · ${x.source}`)}`);
      if (!host.listCommands(cwd).length) console.log(c.dim('No custom commands. Add Markdown files to .sun/commands/ (project) or ~/.sun/commands/ (user).'));
      break;
    case 'memory': {
      const sub = args[0] ?? 'list';
      const store = host.memoryStore;
      if (sub === 'list') for (const m of store.list()) console.log(`${m.id}  ${c.dim(`${m.kind.padEnd(10)} ${m.created.slice(0, 10)} used ${m.uses}`)}  ${m.text}`);
      else if (sub === 'search') for (const h of store.search(args.slice(1).join(' '), 10, 0.1)) console.log(`${h.score.toFixed(2)}  ${h.item.id}  ${c.dim(h.item.kind)}  ${h.item.text}`);
      else if (sub === 'add') {
        const r = store.add(args.slice(1).join(' '), (values.kind as MemoryKind) ?? 'fact');
        console.log(r.duplicate ? `Already remembered: ${r.item.text}` : `Added ${r.item.id}`);
      } else if (sub === 'rm') console.log(store.remove(args[1] ?? '') ? 'Removed.' : 'No such memory.');
      else if (sub === 'extract') console.log(`Added ${(await host.extractMemories(args[1] ?? '')).added} memories.`);
      else throw new Error(`Unknown memory command ${sub}`);
      console.log(c.dim(`Core memory (always in the prompt): ${homePath('memory', 'MEMORY.md')}`));
      break;
    }
    case 'briefing': {
      const sub = args[0] ?? 'show';
      if (sub === 'run') {
        console.log(c.dim('Preparing the briefing…'));
        const r = await host.runBriefing();
        console.log(`${r.text}\n\n${c.dim(`saved ${r.path}`)}`);
      } else if (sub === 'show') console.log(readBriefing(args[1] ?? localDate(new Date())) ?? c.dim('No briefing for that day yet (sun briefing run).'));
      else if (sub === 'enable' || sub === 'disable') {
        const time = values.at?.match(/^(\d{1,2}):(\d{2})$/);
        if (values.at && !time) throw new Error('Use --at HH:MM for the briefing schedule.');
        let hour = 0;
        let minute = 0;
        await editHostSettings(host, values.local, config => {
          hour = time ? Number(time[1]) : config.briefing.hour;
          minute = time ? Number(time[2]) : config.briefing.minute;
          return { 'briefing.enabled': sub === 'enable', ...(time ? { 'briefing.hour': hour, 'briefing.minute': minute } : {}) };
        });
        console.log(sub === 'enable' ? `Daily briefing at ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} while the gateway (sun gateway install) or desktop app runs.` : 'Daily briefing disabled.');
      } else throw new Error(`Unknown briefing command ${sub}`);
      break;
    }
    case 'trigger': {
      const sub = args[0] ?? 'list';
      if (sub === 'list') {
        for (const t of host.config.triggers) console.log(`${t.id.padEnd(16)} ${t.kind.padEnd(8)} ${t.enabled === false ? c.dim('disabled') : c.green('enabled')}  ${t.kind === 'watch' ? t.path : `POST /trigger/${t.id}`}`);
        if (!host.config.triggers.length) console.log(c.dim('No triggers. Add them to "triggers" in ~/.sun/config.json.'));
      } else if (sub === 'fire') {
        const id = await host.fireTrigger(args[1] ?? '', { payload: args.slice(2).join(' ') || undefined });
        await host.wait(id);
        const last = (await host.getEvents(id)).filter((e) => e.type === 'assistant/message').pop() as { text?: string } | undefined;
        console.log(`${last?.text ?? ''}\n${c.dim(`session ${id}`)}`);
      } else throw new Error(`Unknown trigger command ${sub}`);
      break;
    }
    case 'metrics':
      console.log(formatMetrics(host.metrics(Number(values.days) || 7), Number(values.days) || 7));
      break;
    case 'voice': {
      if (host.config.voice.enabled === false) throw new Error('Voice input is disabled.');
      const sub = args[0] ?? 'record';
      if (sub === 'transcribe') {
        const f = args[1];
        if (!f) throw new Error('Usage: sun voice transcribe <audio-file>');
        console.log(await host.transcribe(readFileSync(f).toString('base64'), f.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream'));
      } else if (sub === 'record') {
        const secs = Number(values.seconds) || 8;
        console.log(c.dim(`Recording ${secs} s…`));
        console.log(await host.transcribe(recordMic(secs).toString('base64'), 'audio/mpeg'));
      } else throw new Error(`Unknown voice command ${sub}`);
      break;
    }
    case 'sandbox': {
      const sub = args[0] ?? 'status';
      const info = host.sandboxInfo();
      console.log(`mode ${info.mode} → ${c.bold(info.kind)}: ${info.description}`);
      console.log(c.dim(`network ${info.network}${info.network === 'allowlist' ? ` (allow: ${host.config.sandbox.allow.join(', ')})` : ''} · scrub secrets ${host.config.sandbox.scrubEnv} · auto-approve ${host.config.sandbox.autoApprove}`));
      if (sub === 'test') {
        const dir = mkdtempSync(join(tmpdir(), 'sun-sbtest-'));
        const id = `selftest-${randomUUID()}`;
        const probe = join(homedir(), `.sun-sandbox-${id}`);
        let sb: ReturnType<typeof createSandbox> | undefined;
        try {
          sb = createSandbox({ mode: host.config.sandbox.mode, cfg: host.config.sandbox, sessionId: id, cwd: dir, secretEnv: [] });
          const command = `echo ok > inside.txt && cat inside.txt; echo x > ${shq(probe)} 2>/dev/null && echo OUTSIDE-WRITABLE || echo outside-blocked`;
          const r = spawnSync('bash', ['-c', sb.shell(command, dir)], { cwd: dir, env: sb.env(process.env), encoding: 'utf8' });
          const output = r.stdout?.trim() ?? '';
          const lines = output.split(/\r?\n/);
          const expected = sb.kind === 'none' ? 'OUTSIDE-WRITABLE' : 'outside-blocked';
          console.log(output || r.stderr?.trim() || r.error?.message || 'The shell produced no self-test output.');
          process.exitCode = r.status === 0 && lines.includes('ok') && lines.includes(expected) ? 0 : 1;
        } finally {
          if (existsSync(probe)) unlinkSync(probe);
          sb?.dispose?.();
          rmSync(dir, { recursive: true, force: true });
        }
      }
      break;
    }
    case 'skills':
      for (const s of host.listSkills(cwd)) console.log(`${c.bold(s.name)} ${c.dim(`[${s.scope}]`)} ${s.description.slice(0, 100)}`);
      break;
    case 'mcp':
      if (args[0] === 'presets') {
        for (const [name, p] of Object.entries(MCP_PRESETS)) console.log(`${name.padEnd(16)} ${p.description}\n${''.padEnd(17)}${c.dim(p.setup)}`);
        break;
      }
      if (args[0] === 'add') {
        const setup = await addMcpPreset(args[1] ?? '', globs => editHostSettings(host, values.local, config => ({
          'taint.untrusted': [...new Set([...config.taint.untrusted, ...globs])],
        })));
        console.log(`Added ${args[1]} to ${homePath('mcp.json')} (its tools are treated as untrusted content).\nSetup: ${setup}`);
        break;
      }
      for (const s of await host.listMcp(cwd)) console.log(`${s.status === 'ready' ? c.green('●') : c.red('●')} ${s.name} ${c.dim(s.source)} ${s.error ?? s.tools.join(', ')}`);
      break;
    case 'schedules':
      for (const t of listSchedules()) console.log(`${t.id} ${t.enabled ? 'on ' : 'off'} ${t.cron ?? t.at} ${t.title}`);
      break;
    case 'doctor':
      await doctor(host, cwd);
      break;
    case 'capabilities':
      console.log(JSON.stringify({ protocolVersion: SETTINGS_PROTOCOL_VERSION, capabilities: host.listCapabilities() }, null, 2));
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
