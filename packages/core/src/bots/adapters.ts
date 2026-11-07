import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HarnessHost } from '../host.js';
import { BotBridge, type BotMessage, type BotTransport, type BridgeOptions } from './bridge.js';
import { FeishuBot } from './feishu.js';
import { WeChatBot, WeComBot } from './wechat.js';

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, ctx: { authorized: boolean; body: string }) => Promise<void>;

const json = (res: ServerResponse, code: number, body: unknown) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// ---------------- Telegram (long polling: no public URL needed) ----------------

export class TelegramBot implements BotTransport {
  readonly platform = 'telegram';
  readonly maxLength = 4000;
  readonly bridge: BotBridge;
  private ctrl = new AbortController();
  private offset = 0;

  constructor(
    host: HarnessHost,
    private readonly token: string,
    opts: BridgeOptions,
    private readonly apiBase = 'https://api.telegram.org',
  ) {
    this.bridge = new BotBridge(host, this, opts);
  }

  private api(method: string): string {
    return `${this.apiBase.replace(/\/$/, '')}/bot${this.token}/${method}`;
  }

  async send(chatId: string, text: string): Promise<void> {
    const r = await fetch(this.api('sendMessage'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, text }) });
    if (!r.ok) throw new Error(`telegram sendMessage ${r.status}`);
  }

  start(): void {
    this.bridge.start();
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (!this.ctrl.signal.aborted) {
      try {
        const r = await fetch(`${this.api('getUpdates')}?timeout=25&offset=${this.offset}`, { signal: this.ctrl.signal });
        const data = (await r.json()) as { ok: boolean; result?: any[] };
        for (const u of data.result ?? []) {
          this.offset = Math.max(this.offset, u.update_id + 1);
          const m = u.message ?? u.edited_message;
          if (!m?.text) continue;
          await this.bridge.handle({ chatId: String(m.chat.id), userId: String(m.from?.id ?? ''), userName: m.from?.username, text: m.text }).catch(() => undefined);
        }
      } catch {
        if (this.ctrl.signal.aborted) return;
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop(): void {
    this.ctrl.abort();
    this.bridge.stop();
  }
}

// ---------------- DingTalk outgoing robot (callback + sessionWebhook replies) ----------------

/** DingTalk signs callbacks: sign = base64(HMAC-SHA256(appSecret, timestamp + "\n" + appSecret)). */
export function dingtalkSign(timestamp: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(`${timestamp}\n${appSecret}`).digest('base64');
}

export class DingTalkBot implements BotTransport {
  readonly platform = 'dingtalk';
  readonly maxLength = 3500;
  readonly bridge: BotBridge;
  private webhooks = new Map<string, { url: string; expires: number }>();

  constructor(
    host: HarnessHost,
    private readonly appSecret: string,
    opts: BridgeOptions,
  ) {
    this.bridge = new BotBridge(host, this, opts);
  }

  async send(chatId: string, text: string): Promise<void> {
    const w = this.webhooks.get(chatId);
    if (!w || w.expires < Date.now()) throw new Error(`No live DingTalk session webhook for ${chatId}`);
    const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ msgtype: 'markdown', markdown: { title: 'sun-harness', text } }) });
    if (!r.ok) throw new Error(`dingtalk webhook ${r.status}`);
  }

  /** POST /bots/dingtalk — verify the signature, remember the reply webhook, hand the text to the bridge. */
  route: RouteHandler = async (req, res, { body }) => {
    const ts = String(req.headers.timestamp ?? '');
    const sign = String(req.headers.sign ?? '');
    const expected = dingtalkSign(ts, this.appSecret);
    const fresh = Math.abs(Date.now() - Number(ts)) < 60 * 60 * 1000;
    if (!fresh || sign.length !== expected.length || !timingSafeEqual(Buffer.from(sign), Buffer.from(expected))) return json(res, 401, { error: 'bad signature' });
    let m: any;
    try {
      m = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    const chatId = String(m.conversationId ?? '');
    if (m.sessionWebhook) this.webhooks.set(chatId, { url: m.sessionWebhook, expires: Number(m.sessionWebhookExpiredTime ?? Date.now() + 3_600_000) });
    json(res, 200, {});
    const text = String(m.text?.content ?? '').trim();
    await this.bridge.handle({ chatId, userId: String(m.senderStaffId ?? m.senderId ?? ''), userName: m.senderNick, text }).catch(() => undefined);
  };

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }
}

// ---------------- Generic webhook (Slack/Feishu/scripts; device-token auth) ----------------

/**
 * POST /bots/webhook {chatId, userId, text, replyUrl?}. Replies go to replyUrl ({chatId, text}),
 * or with ?wait=1 the response holds until the run ends and returns {replies}.
 */
export class WebhookBot implements BotTransport {
  readonly platform = 'webhook';
  readonly maxLength = 20_000;
  readonly bridge: BotBridge;
  private replyUrls = new Map<string, string>();
  private collectors = new Map<string, string[]>();

  constructor(
    private readonly host: HarnessHost,
    opts: BridgeOptions,
  ) {
    this.bridge = new BotBridge(host, this, opts);
  }

  async send(chatId: string, text: string): Promise<void> {
    const c = this.collectors.get(chatId);
    if (c) return void c.push(text);
    const url = this.replyUrls.get(chatId);
    if (url) await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chatId, text }) });
  }

  route: RouteHandler = async (req, res, { authorized, body }) => {
    if (!authorized) return json(res, 401, { error: 'unauthorized' });
    let m: BotMessage & { replyUrl?: string };
    try {
      m = JSON.parse(body);
    } catch {
      return json(res, 400, { error: 'invalid JSON' });
    }
    if (!m.chatId || typeof m.text !== 'string') return json(res, 400, { error: 'chatId and text are required' });
    m.chatId = String(m.chatId);
    m.userId = String(m.userId ?? '');
    if (m.replyUrl) this.replyUrls.set(m.chatId, m.replyUrl);
    const wait = new URL(req.url ?? '/', 'http://x').searchParams.get('wait') === '1';
    if (!wait) {
      json(res, 202, { accepted: true });
      await this.bridge.handle(m).catch(() => undefined);
      return;
    }
    const replies: string[] = [];
    this.collectors.set(m.chatId, replies);
    try {
      await this.bridge.handle(m);
      const sid = this.bridge.sessionOf(m.chatId);
      if (sid) {
        await new Promise((r) => setTimeout(r, 50));
        const t0 = Date.now();
        // Wait for the run to finish, or for it to stop on an approval the caller must answer.
        while (this.host.isRunning(sid) && Date.now() - t0 < 10 * 60_000) {
          if (this.host.pendingApprovals().some((a) => a.displaySessionId === sid) && replies.some((r) => r.startsWith('⚠️'))) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      json(res, 200, { sessionId: sid, replies });
    } finally {
      this.collectors.delete(m.chatId);
    }
  };

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }
}

// ---------------- wiring ----------------

export interface BotsConfig {
  defaultMode: string;
  approvals: 'chat' | 'deny';
  telegram: { enabled: boolean; tokenEnv: string; allowedUsers: string[]; apiBase?: string };
  dingtalk: { enabled: boolean; appSecretEnv: string; allowedUsers: string[] };
  webhook: { enabled: boolean; allowedUsers: string[] };
  feishu: { enabled: boolean; appIdEnv: string; appSecretEnv: string; verificationTokenEnv: string; encryptKeyEnv: string; apiBase?: string; allowedUsers: string[] };
  wechat: { enabled: boolean; appIdEnv: string; appSecretEnv: string; tokenEnv: string; encodingAesKeyEnv: string; apiBase?: string; allowedUsers: string[] };
  wecom: { enabled: boolean; corpIdEnv: string; secretEnv: string; agentId: string; tokenEnv: string; encodingAesKeyEnv: string; apiBase?: string; allowedUsers: string[] };
}

export interface RunningBots {
  started: string[];
  skipped: string[];
  routes: Record<string, RouteHandler>;
  stop(): void;
}

/** Start the enabled bots against a host; HTTP-based ones contribute gateway routes. */
export function startBots(host: HarnessHost, cfg: BotsConfig, env: NodeJS.ProcessEnv = process.env): RunningBots {
  const base = { defaultMode: cfg.defaultMode, approvals: cfg.approvals };
  const started: string[] = [];
  const skipped: string[] = [];
  const stops: (() => void)[] = [];
  const routes: Record<string, RouteHandler> = {};
  const bridges: Record<string, BotBridge> = {};
  if (cfg.telegram?.enabled) {
    const token = env[cfg.telegram.tokenEnv];
    if (!token) skipped.push(`telegram (set ${cfg.telegram.tokenEnv})`);
    else {
      const t = new TelegramBot(host, token, { ...base, allowedUsers: cfg.telegram.allowedUsers.map(String) }, cfg.telegram.apiBase);
      t.start();
      stops.push(() => t.stop());
      started.push('telegram');
      bridges.telegram = t.bridge;
    }
  }
  if (cfg.dingtalk?.enabled) {
    const secret = env[cfg.dingtalk.appSecretEnv];
    if (!secret) skipped.push(`dingtalk (set ${cfg.dingtalk.appSecretEnv})`);
    else {
      const d = new DingTalkBot(host, secret, { ...base, allowedUsers: cfg.dingtalk.allowedUsers.map(String) });
      d.start();
      routes['/bots/dingtalk'] = d.route;
      stops.push(() => d.stop());
      started.push('dingtalk');
      bridges.dingtalk = d.bridge;
    }
  }
  if (cfg.webhook?.enabled) {
    const w = new WebhookBot(host, { ...base, allowedUsers: cfg.webhook.allowedUsers.map(String) });
    w.start();
    routes['/bots/webhook'] = w.route;
    stops.push(() => w.stop());
    started.push('webhook');
    bridges.webhook = w.bridge;
  }
  const need = (platform: string, names: string[]) => {
    const missing = names.filter((n) => !env[n]);
    if (missing.length) skipped.push(`${platform} (set ${missing.join(', ')})`);
    return !missing.length;
  };
  if (cfg.feishu?.enabled) {
    const f = cfg.feishu;
    if (need('feishu', [f.appIdEnv, f.appSecretEnv, f.verificationTokenEnv])) {
      const b = new FeishuBot(
        host,
        { appId: env[f.appIdEnv]!, appSecret: env[f.appSecretEnv]!, verificationToken: env[f.verificationTokenEnv]!, encryptKey: env[f.encryptKeyEnv] || undefined, apiBase: f.apiBase },
        { ...base, allowedUsers: f.allowedUsers.map(String) },
      );
      b.start();
      routes['/bots/feishu'] = b.route;
      stops.push(() => b.stop());
      started.push('feishu');
      bridges.feishu = b.bridge;
    }
  }
  if (cfg.wechat?.enabled) {
    const w = cfg.wechat;
    if (need('wechat', [w.appIdEnv, w.appSecretEnv, w.tokenEnv])) {
      const b = new WeChatBot(
        host,
        { appId: env[w.appIdEnv]!, appSecret: env[w.appSecretEnv]!, token: env[w.tokenEnv]!, encodingAesKey: env[w.encodingAesKeyEnv] || undefined, apiBase: w.apiBase },
        { ...base, allowedUsers: w.allowedUsers.map(String) },
      );
      b.start();
      routes['/bots/wechat'] = b.route;
      stops.push(() => b.stop());
      started.push('wechat');
      bridges.wechat = b.bridge;
    }
  }
  if (cfg.wecom?.enabled) {
    const w = cfg.wecom;
    if (!w.agentId) skipped.push('wecom (set bots.wecom.agentId)');
    else if (need('wecom', [w.corpIdEnv, w.secretEnv, w.tokenEnv, w.encodingAesKeyEnv])) {
      const b = new WeComBot(
        host,
        { corpId: env[w.corpIdEnv]!, secret: env[w.secretEnv]!, agentId: String(w.agentId), token: env[w.tokenEnv]!, encodingAesKey: env[w.encodingAesKeyEnv]!, apiBase: w.apiBase },
        { ...base, allowedUsers: w.allowedUsers.map(String) },
      );
      b.start();
      routes['/bots/wecom'] = b.route;
      stops.push(() => b.stop());
      started.push('wecom');
      bridges.wecom = b.bridge;
    }
  }
  // Daily briefings go to the chats listed in briefing.chats ("platform:chatId").
  stops.push(
    host.subscribe((e) => {
      if (e.kind !== 'briefing') return;
      for (const target of host.config.briefing?.chats ?? []) {
        const [platform, ...id] = target.split(':');
        void bridges[platform]?.say(id.join(':'), `Briefing ${e.date}\n\n${e.text}`).catch(() => undefined);
      }
    }),
  );
  return { started, skipped, routes, stop: () => stops.forEach((s) => s()) };
}
