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
      default:
        return this.say(chatId, `Unknown command ${cmd}.\n${HELP}`);
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
    if (e.kind !== 'event') return;
    const chatId = this.chatOf(e.sessionId);
    if (!chatId) return;
    const ev = e.event;
    if (ev.type === 'assistant/message' && ev.text.trim()) await this.say(chatId, ev.text.trim());
    else if (ev.type === 'run/status' && (ev.status === 'paused' || ev.status === 'error')) {
      await this.say(chatId, `${ev.status === 'paused' ? '⏸ Paused' : '✗ Error'} (${ev.reason ?? ''}). ${ev.status === 'paused' ? 'Send /resume when ready, or /resume <provider/model>.' : (ev.detail ?? '').slice(0, 300)}`);
    }
  }
}
