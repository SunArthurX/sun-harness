import { formatContextReport } from '../ux/context.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { HarnessHost } from '../host.js';
import { homePath } from '../paths.js';
import type { LiveEvent, PendingApproval } from '../types.js';

export interface BotMessage {
  chatId: string;
  userId: string;
  userName?: string;
  text: string;
}

/** What a platform adapter provides: deliver text to a chat. */
export interface BotTransport {
  platform: string;
  /** Platform message size limit; longer replies are split. */
  maxLength: number;
  send(chatId: string, text: string): Promise<void>;
}

export interface BridgeOptions {
  /** Platform user ids allowed to use the bot. Empty = nobody (fail closed). */
  allowedUsers: string[];
  defaultMode: string;
  /** "chat": approvals are asked in the chat; "deny": tool calls needing approval are denied. */
  approvals: 'chat' | 'deny';
  cwd?: string;
}

const HELP = `sun-harness bot
/new [coding|agent|assistant] — start a fresh session
/mode <id> · /model <provider/model> — switch this chat's session
/status — current session, model, state
/stop — stop the current run · /resume [model] — continue a paused run
/approve [always] · /deny — answer a pending approval
/compact — summarize older history · /cost — tokens and estimated cost · /context — what fills the context
/commands — custom commands (from .sun/commands, ~/.sun/commands)
/automations — scheduled automations · /yes /both /no — answer a scheduling proposal
/id — show your user id`;

function chunks(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Platform-neutral chat bot: allowlisted users, one session per chat (persisted), commands,
 * approvals answered in the chat, and final replies sent back. Adapters only translate messages.
 */
export class BotBridge {
  private map: Record<string, string>;
  private announced = new Set<string>();
  private unsub?: () => void;
  private releaseApprover?: () => void;

  constructor(
    private readonly host: HarnessHost,
    private readonly transport: BotTransport,
    private readonly opts: BridgeOptions,
  ) {
    this.map = this.loadMap();
  }

  private file(): string {
    return homePath('bots.json');
  }

  private loadMap(): Record<string, string> {
    if (!existsSync(this.file())) return {};
    try {
      return JSON.parse(readFileSync(this.file(), 'utf8'))[this.transport.platform] ?? {};
    } catch {
      return {};
    }
  }

  private saveMap(): void {
    let all: Record<string, Record<string, string>> = {};
    try {
      all = JSON.parse(readFileSync(this.file(), 'utf8'));
    } catch {
      // new file
    }
    all[this.transport.platform] = this.map;
    writeFileSync(this.file(), JSON.stringify(all, null, 2), { mode: 0o600 });
  }

  private chatOf(sessionId: string): string | undefined {
    return Object.entries(this.map).find(([, s]) => s === sessionId)?.[0];
  }

  sessionOf(chatId: string): string | undefined {
    return this.map[chatId];
  }

  start(): void {
    this.unsub = this.host.subscribe((e) => void this.onLive(e).catch(() => undefined));
    if (this.opts.approvals === 'chat') this.releaseApprover = this.host.registerApprover((sid) => !!this.chatOf(sid));
  }

  stop(): void {
    this.unsub?.();
    this.releaseApprover?.();
  }

  async say(chatId: string, text: string): Promise<void> {
    for (const part of chunks(text, this.transport.maxLength)) await this.transport.send(chatId, part);
  }

  private newSession(chatId: string, mode?: string): string {
    const s = this.host.createSession({ mode: mode ?? this.opts.defaultMode, cwd: this.opts.cwd, title: `[${this.transport.platform}] chat ${chatId}` });
    this.map[chatId] = s.id;
    this.saveMap();
    return s.id;
  }

  private pendingFor(sessionId: string): PendingApproval[] {
    return this.host.pendingApprovals().filter((a) => a.displaySessionId === sessionId);
  }

  async handle(msg: BotMessage): Promise<void> {
    const text = msg.text.trim();
    if (text === '/id') return this.say(msg.chatId, `Your ${this.transport.platform} user id: ${msg.userId}`);
    if (!this.opts.allowedUsers.includes(msg.userId)) {
      return this.say(msg.chatId, `Not authorized. Your user id is ${msg.userId}; the owner can add it to bots.${this.transport.platform}.allowedUsers.`);
    }
    if (!text) return;
    if (text.startsWith('/')) return this.command(msg.chatId, text);
    const sid = this.map[msg.chatId] && this.host.listSessions().some((s) => s.id === this.map[msg.chatId]) ? this.map[msg.chatId] : this.newSession(msg.chatId);
    await this.host.send(sid, text);
  }

  private async command(chatId: string, text: string): Promise<void> {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(' ');
    const sid = this.map[chatId];
    const summary = sid ? this.host.listSessions().find((s) => s.id === sid) : undefined;
    switch (cmd.replace(/@.*$/, '')) {
      case '/start':
      case '/help':
        return this.say(chatId, HELP);
      case '/new': {
        const id = this.newSession(chatId, arg || undefined);
        return this.say(chatId, `New ${arg || this.opts.defaultMode} session ${id}.`);
      }
      case '/status':
        return this.say(chatId, summary ? `Session ${summary.id} · ${summary.mode} · ${summary.model} · ${summary.status}${summary.statusReason ? ` (${summary.statusReason})` : ''}` : 'No session yet; just send a message.');
      case '/mode':
        if (!sid) return this.say(chatId, 'No session yet.');
        this.host.switchMode(sid, arg);
        return this.say(chatId, `Mode → ${arg}`);
      case '/model':
        if (!sid) return this.say(chatId, 'No session yet.');
        this.host.switchModel(sid, arg);
        return this.say(chatId, `Model → ${arg}`);
      case '/stop':
        if (sid) this.host.abort(sid);
        return this.say(chatId, 'Stopped.');
      case '/resume':
        if (!sid) return this.say(chatId, 'No session yet.');
        this.host.resume(sid, { model: arg || undefined });
        return this.say(chatId, 'Resuming…');
      case '/approve':
      case '/deny': {
        const [pending] = sid ? this.pendingFor(sid) : [];
        if (!pending) return this.say(chatId, 'Nothing is waiting for approval.');
        const decision = cmd === '/deny' ? 'deny' : arg === 'always' ? 'allow_always' : 'allow';
        const ok = this.host.approve(pending.callId, decision, pending.promptId);
        return this.say(chatId, ok ? `${decision === 'deny' ? 'Denied' : 'Approved'} ${pending.name}.` : 'That approval was already answered.');
      }
      case '/compact':
        if (!sid) return this.say(chatId, 'No session yet.');
        return this.say(chatId, (await this.host.compact(sid).catch((e: Error) => (void this.say(chatId, e.message), false))) ? 'Compacted.' : 'Nothing to compact yet.');
      case '/cost': {
        if (!sid) return this.say(chatId, 'No session yet.');
        const c = this.host.cost(sid);
        return this.say(chatId, c.byModel.map((m) => `${m.model}: ${m.input} in (${m.cached} cached), ${m.output} out${m.usd !== undefined ? `, $${m.usd.toFixed(4)}` : ''}`).join('\n') || 'No usage yet.');
      }
      case '/context': {
        if (!sid) return this.say(chatId, 'No session yet.');
        return this.say(chatId, formatContextReport(await this.host.contextUsage(sid), false));
      }
      case '/yes':
      case '/both':
      case '/no': {
        if (!sid) return this.say(chatId, 'No session yet.');
        const events = this.host.getEvents(sid);
        const resolved = new Set(events.filter((x) => x.type === 'automation/resolved').map((x) => (x as { proposalId: string }).proposalId));
        const p = [...events].reverse().find((x) => x.type === 'automation/proposal' && !resolved.has(x.proposalId)) as { proposalId: string } | undefined;
        if (!p) return this.say(chatId, 'Nothing is waiting for a scheduling decision.');
        const action = cmd === '/no' ? 'run' : cmd === '/both' ? 'both' : 'create';
        this.host.resolveProposal(sid, p.proposalId, action);
        return action === 'run' ? undefined : this.say(chatId, 'Automation created. /automations lists them.');
      }
      case '/automations': {
        const list = this.host.listAutomations();
        return this.say(chatId, list.map((a) => `${a.enabled ? '●' : '○'} ${a.id} ${a.title} — ${a.description}${a.nextRun ? ` · next ${new Date(a.nextRun).toLocaleString()}` : ''}${a.lastStatus ? ` · last ${a.lastStatus}` : ''}`).join('\n') || 'No automations. Say e.g. “every weekday at 9 summarize my mail”.');
      }
      case '/commands': {
        const list = this.host.listCommands(this.opts.cwd);
        return this.say(chatId, list.map((x) => `/${x.name}${x.argumentHint ? ` ${x.argumentHint}` : ''} — ${x.description}`).join('\n') || 'No custom commands.');
      }
      default: {
        // Custom slash commands are expanded by the host like any typed message.
        const name = cmd.replace(/@.*$/, '').slice(1);
        if (this.host.listCommands(this.opts.cwd ?? summary?.cwd).some((x) => x.name === name)) {
          const id = sid && summary ? sid : this.newSession(chatId);
          return this.host.send(id, text);
        }
        return this.say(chatId, `Unknown command ${cmd}.\n${HELP}`);
      }
    }
  }

  private async onLive(e: LiveEvent): Promise<void> {
    if (e.kind === 'approvals') {
      for (const a of e.approvals) {
        const chatId = this.chatOf(a.displaySessionId);
        if (!chatId || this.announced.has(a.promptId)) continue;
        this.announced.add(a.promptId);
        await this.say(chatId, `⚠️ Approval needed: ${a.name} [${a.risk}]\n${a.arguments.slice(0, 800)}\nReply /approve, /approve always, or /deny.`);
      }
      return;
    }
    if (e.kind === 'automation') {
      if (e.status === 'running') return;
      for (const target of e.chats ?? []) {
        const [platform, ...id] = target.split(':');
        if (platform === this.transport.platform) await this.say(id.join(':'), `⏲ ${e.title} (${e.status})\n\n${e.text?.trim() || '(no answer)'}`);
      }
      return;
    }
    if (e.kind !== 'event') return;
    const chatId = this.chatOf(e.sessionId);
    if (!chatId) return;
    const ev = e.event;
    if (ev.type === 'automation/proposal') {
      await this.say(chatId, `⏲ Schedule this? “${ev.title}” — ${ev.description}.\nReply /yes to create the automation, /both to create it and answer now, or /no to just answer now.`);
      return;
    }
    if (ev.type === 'assistant/message' && ev.text.trim()) await this.say(chatId, ev.text.trim());
    else if (ev.type === 'run/status' && ev.status === 'idle') {
      const events = this.host.getEvents(e.sessionId);
      const start = [...events].reverse().find((x) => x.type === 'user/message' && (!x.source || x.source === 'user'));
      const changes = start ? this.host.sessionChanges(e.sessionId, { fromSeq: start.seq }) : [];
      if (changes.length) await this.say(chatId, `📝 ${changes.length} file${changes.length > 1 ? 's' : ''} changed\n${changes.map((c) => `${c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'} ${c.path} (+${c.additions} −${c.deletions})`).join('\n')}`);
    }
    else if (ev.type === 'run/status' && (ev.status === 'paused' || ev.status === 'error')) {
      await this.say(chatId, `${ev.status === 'paused' ? '⏸ Paused' : '✗ Error'} (${ev.reason ?? ''}). ${ev.status === 'paused' ? 'Send /resume when ready, or /resume <provider/model>.' : (ev.detail ?? '').slice(0, 300)}`);
    }
  }
}
