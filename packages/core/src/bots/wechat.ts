import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HarnessHost } from '../host.js';
import type { RouteHandler } from './adapters.js';
import { BotBridge, type BotTransport, type BridgeOptions } from './bridge.js';

// ---------------- shared WeChat / WeCom crypto (the "safe mode" message encryption scheme) ----------------

/** sha1 of the sorted parameters: token, timestamp, nonce (+ encrypted payload for msg_signature). */
export function wechatSignature(...parts: string[]): string {
  return createHash('sha1').update([...parts].sort().join('')).digest('hex');
}

function aesKey(encodingAesKey: string): Buffer {
  return Buffer.from(`${encodingAesKey}=`, 'base64');
}

/** Decrypt: AES-256-CBC (IV = key[0..16], PKCS#7 to 32) → 16 random bytes · 4-byte length · message · receiver id. */
export function wechatDecrypt(encrypted: string, encodingAesKey: string): { message: string; receiverId: string } {
  const key = aesKey(encodingAesKey);
  const decipher = createDecipheriv('aes-256-cbc', key, key.subarray(0, 16));
  decipher.setAutoPadding(false);
  let buf = Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64')), decipher.final()]);
  const pad = buf[buf.length - 1];
  buf = buf.subarray(0, buf.length - (pad >= 1 && pad <= 32 ? pad : 0));
  const len = buf.readUInt32BE(16);
  return { message: buf.subarray(20, 20 + len).toString('utf8'), receiverId: buf.subarray(20 + len).toString('utf8') };
}

export function wechatEncrypt(message: string, encodingAesKey: string, receiverId: string): string {
  const key = aesKey(encodingAesKey);
  const msg = Buffer.from(message, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(msg.length);
  let plain = Buffer.concat([randomBytes(16), len, msg, Buffer.from(receiverId)]);
  const pad = 32 - (plain.length % 32);
  plain = Buffer.concat([plain, Buffer.alloc(pad, pad)]);
  const cipher = createCipheriv('aes-256-cbc', key, key.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

/** Read <Tag><![CDATA[v]]></Tag> or <Tag>v</Tag> from WeChat's flat XML. */
export function xmlField(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<]*))\\s*</${tag}>`).exec(xml);
  return m ? (m[1] ?? m[2] ?? '').trim() : undefined;
}

interface Callback {
  query: URLSearchParams;
  xml: string;
}

/** Common callback handling: URL verification (GET), signature checks, optional decryption, dedupe. */
abstract class WeChatFamilyBot implements BotTransport {
  abstract readonly platform: string;
  readonly maxLength = 600;
  readonly bridge: BotBridge;
  private seen = new Set<string>();
  protected accessToken?: { value: string; expires: number };

  constructor(
    host: HarnessHost,
    protected readonly token: string,
    protected readonly encodingAesKey: string | undefined,
    protected readonly receiverId: string,
    opts: BridgeOptions,
  ) {
    this.bridge = new BotBridge(host, this, opts);
  }

  abstract send(chatId: string, text: string): Promise<void>;

  /** WeCom always encrypts; Official Accounts only in safe mode. */
  protected abstract encryptedOnly: boolean;

  private verify(q: URLSearchParams, encrypted?: string): boolean {
    const ts = q.get('timestamp') ?? '';
    const nonce = q.get('nonce') ?? '';
    if (encrypted !== undefined) return wechatSignature(this.token, ts, nonce, encrypted) === q.get('msg_signature');
    return wechatSignature(this.token, ts, nonce) === q.get('signature');
  }

  private decode(cb: Callback): string | undefined {
    const encrypted = xmlField(cb.xml, 'Encrypt');
    if (encrypted !== undefined) {
      if (!this.encodingAesKey || !this.verify(cb.query, encrypted)) return undefined;
      const { message, receiverId } = wechatDecrypt(encrypted, this.encodingAesKey);
      return receiverId === this.receiverId ? message : undefined;
    }
    if (this.encryptedOnly || !this.verify(cb.query)) return undefined;
    return cb.xml;
  }

  private handleVerification(q: URLSearchParams, res: ServerResponse): void {
    const echostr = q.get('echostr') ?? '';
    if (q.get('msg_signature')) {
      // WeCom: echostr is encrypted and signed together with it.
      if (!this.encodingAesKey || !this.verify(q, echostr)) return void (res.writeHead(401), res.end('bad signature'));
      return void (res.writeHead(200, { 'content-type': 'text/plain' }), res.end(wechatDecrypt(echostr, this.encodingAesKey).message));
    }
    if (!this.verify(q)) return void (res.writeHead(401), res.end('bad signature'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(echostr);
  }

  route: RouteHandler = async (req: IncomingMessage, res: ServerResponse, { body }) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    if (req.method === 'GET') return this.handleVerification(q, res);
    const xml = this.decode({ query: q, xml: body });
    if (xml === undefined) {
      res.writeHead(401);
      res.end('bad signature');
      return;
    }
    // Answer at once ("success"): runs take longer than WeChat's 5 s passive-reply window; replies go through the API.
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('success');
    if (xmlField(xml, 'MsgType') !== 'text') return;
    const msgId = xmlField(xml, 'MsgId') ?? `${xmlField(xml, 'FromUserName')}:${xmlField(xml, 'CreateTime')}`;
    if (this.seen.has(msgId)) return; // WeChat retries 3 times when it does not get an answer fast enough
    this.seen.add(msgId);
    if (this.seen.size > 1000) this.seen.clear();
    const from = xmlField(xml, 'FromUserName') ?? '';
    await this.bridge.handle({ chatId: from, userId: from, text: xmlField(xml, 'Content') ?? '' }).catch(() => undefined);
  };

  start(): void {
    this.bridge.start();
  }

  stop(): void {
    this.bridge.stop();
  }
}

// ---------------- WeChat Official Account (公众号, incl. the sandbox 测试号) ----------------

export interface WeChatOptions {
  appId: string;
  appSecret: string;
  token: string;
  encodingAesKey?: string;
  apiBase?: string;
}

/** Callback at /bots/wechat; replies with the customer-service message API (within 48 h of the user's message). */
export class WeChatBot extends WeChatFamilyBot {
  readonly platform = 'wechat';
  protected encryptedOnly = false;

  constructor(
    host: HarnessHost,
    private readonly w: WeChatOptions,
    opts: BridgeOptions,
  ) {
    super(host, w.token, w.encodingAesKey, w.appId, opts);
  }

  private base(): string {
    return (this.w.apiBase ?? 'https://api.weixin.qq.com').replace(/\/$/, '');
  }

  private async token_(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const r = await fetch(`${this.base()}/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(this.w.appId)}&secret=${encodeURIComponent(this.w.appSecret)}`);
    const d = (await r.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!d.access_token) throw new Error(`wechat token: ${d.errmsg ?? d.errcode}`);
    this.accessToken = { value: d.access_token, expires: Date.now() + (d.expires_in ?? 7200) * 1000 };
    return d.access_token;
  }

  async send(chatId: string, text: string): Promise<void> {
    const r = await fetch(`${this.base()}/cgi-bin/message/custom/send?access_token=${await this.token_()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: chatId, msgtype: 'text', text: { content: text } }),
    });
    const d = (await r.json()) as { errcode?: number; errmsg?: string };
    if (d.errcode) throw new Error(`wechat send: ${d.errmsg ?? d.errcode}`);
  }
}

// ---------------- WeCom self-built app (企业微信自建应用) ----------------

export interface WeComOptions {
  corpId: string;
  secret: string;
  agentId: string;
  token: string;
  encodingAesKey: string;
  apiBase?: string;
}

/** Callback at /bots/wecom (always encrypted); replies with message/send to the user. */
export class WeComBot extends WeChatFamilyBot {
  readonly platform = 'wecom';
  protected encryptedOnly = true;

  constructor(
    host: HarnessHost,
    private readonly w: WeComOptions,
    opts: BridgeOptions,
  ) {
    super(host, w.token, w.encodingAesKey, w.corpId, opts);
  }

  private base(): string {
    return (this.w.apiBase ?? 'https://qyapi.weixin.qq.com').replace(/\/$/, '');
  }

  private async token_(): Promise<string> {
    if (this.accessToken && this.accessToken.expires > Date.now() + 60_000) return this.accessToken.value;
    const r = await fetch(`${this.base()}/cgi-bin/gettoken?corpid=${encodeURIComponent(this.w.corpId)}&corpsecret=${encodeURIComponent(this.w.secret)}`);
    const d = (await r.json()) as { access_token?: string; expires_in?: number; errcode?: number; errmsg?: string };
    if (!d.access_token) throw new Error(`wecom token: ${d.errmsg ?? d.errcode}`);
    this.accessToken = { value: d.access_token, expires: Date.now() + (d.expires_in ?? 7200) * 1000 };
    return d.access_token;
  }

  async send(chatId: string, text: string): Promise<void> {
    const r = await fetch(`${this.base()}/cgi-bin/message/send?access_token=${await this.token_()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ touser: chatId, msgtype: 'text', agentid: Number(this.w.agentId) || this.w.agentId, text: { content: text } }),
    });
    const d = (await r.json()) as { errcode?: number; errmsg?: string };
    if (d.errcode) throw new Error(`wecom send: ${d.errmsg ?? d.errcode}`);
  }
}
