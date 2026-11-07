import { createDecipheriv, createHash } from 'node:crypto';
import type { HarnessHost } from '../host.js';
import type { RouteHandler } from './adapters.js';
import { BotBridge, type BotTransport, type BridgeOptions } from './bridge.js';

/** Feishu/Lark "Encrypt Key": AES-256-CBC, key = sha256(encryptKey), first 16 bytes of the payload are the IV. */
export function feishuDecrypt(encrypt: string, encryptKey: string): string {
  const key = createHash('sha256').update(encryptKey).digest();
  const buf = Buffer.from(encrypt, 'base64');
  const decipher = createDecipheriv('aes-256-cbc', key, buf.subarray(0, 16));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  verificationToken: string;
  encryptKey?: string;
  /** https://open.feishu.cn (China) or https://open.larksuite.com (Lark). */
  apiBase?: string;
}

/**
 * Feishu / Lark app bot over event subscription callbacks (POST /bots/feishu).
 * Handles the url_verification challenge, optional encryption, im.message.receive_v1 text messages,
 * and replies with the IM API (tenant access token cached until it expires).
 */
export class FeishuBot implements BotTransport {
  readonly platform = 'feishu';
  readonly maxLength = 4000;
  readonly bridge: BotBridge;
  private token?: { value: string; expires: number };
  private seen = new Set<string>();

  constructor(
    host: HarnessHost,
    private readonly f: FeishuOptions,
    opts: BridgeOptions,
  ) {
    this.bridge = new BotBridge(host, this, opts);
  }

  private base(): string {
    return (this.f.apiBase ?? 'https://open.feishu.cn').replace(/\/$/, '');
  }

  private async tenantToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    const r = await fetch(`${this.base()}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: this.f.appId, app_secret: this.f.appSecret }),
    });
    const d = (await r.json()) as { code: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (d.code !== 0 || !d.tenant_access_token) throw new Error(`feishu token: ${d.msg ?? d.code}`);
    this.token = { value: d.tenant_access_token, expires: Date.now() + (d.expire ?? 7200) * 1000 };
    return this.token.value;
  }

  async send(chatId: string, text: string): Promise<void> {
    const r = await fetch(`${this.base()}/open-apis/im/v1/messages?receive_id_type=chat_id`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.tenantToken()}` },
      body: JSON.stringify({ receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }),
    });
    const d = (await r.json()) as { code: number; msg?: string };
    if (d.code !== 0) throw new Error(`feishu send: ${d.msg ?? d.code}`);
  }

  route: RouteHandler = async (req, res, { body }) => {
    const reply = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.method !== 'POST') return reply(405, { error: 'POST only' });
    let m: any;
    try {
      m = JSON.parse(body);
      if (m.encrypt) {
        if (!this.f.encryptKey) return reply(400, { error: 'encrypted event but no encrypt key configured' });
        m = JSON.parse(feishuDecrypt(m.encrypt, this.f.encryptKey));
      }
    } catch {
      return reply(400, { error: 'invalid body' });
    }
    // v1 challenge and v2 events both carry the verification token.
    const token = m.token ?? m.header?.token;
    if (token !== this.f.verificationToken) return reply(401, { error: 'bad verification token' });
    if (m.type === 'url_verification') return reply(200, { challenge: m.challenge });
    reply(200, {});
    if (m.header?.event_type !== 'im.message.receive_v1') return;
    const eventId = m.header.event_id;
    if (eventId && this.seen.has(eventId)) return; // Feishu retries deliveries
    if (eventId) this.seen.add(eventId);
    if (this.seen.size > 1000) this.seen.clear();
    const msg = m.event?.message;
    if (!msg || msg.message_type !== 'text') return;
    let text = '';
    try {
      text = JSON.parse(msg.content).text ?? '';
    } catch {
      return;
    }
    // In group chats the bot is @-mentioned; drop the mention placeholders (@_user_1).
    text = text.replace(/@_user_\d+/g, '').trim();
    const sender = m.event.sender?.sender_id ?? {};
    await this.bridge.handle({ chatId: String(msg.chat_id), userId: String(sender.open_id ?? sender.user_id ?? ''), text }).catch(() => undefined);
  };

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }
}
