import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelegramBot, createDevice, dingtalkSign, startBots, startGateway, type RunningGateway } from '../src/index.js';
import { call, mockHost, tempHome } from './helpers.js';

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** A tiny fake of the Telegram Bot API (getUpdates long poll + sendMessage). */
async function fakeTelegram() {
  const queue: any[] = [];
  const sent: { chat_id: string; text: string }[] = [];
  let nextId = 1;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      if (req.url!.includes('/sendMessage')) {
        sent.push(JSON.parse(body));
        res.end('{"ok":true}');
      } else if (req.url!.includes('/getUpdates')) {
        const offset = Number(new URL(req.url!, 'http://x').searchParams.get('offset'));
        for (let i = 0; i < 20 && !queue.some((u) => u.update_id >= offset); i++) await new Promise((r) => setTimeout(r, 25));
        res.end(JSON.stringify({ ok: true, result: queue.filter((u) => u.update_id >= offset) }));
      } else res.end('{"ok":false}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  return {
    base: `http://127.0.0.1:${port}`,
    sent,
    say: (userId: number, text: string, chatId = 100) => queue.push({ update_id: nextId++, message: { chat: { id: chatId }, from: { id: userId, username: `u${userId}` }, text } }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('chat bots', () => {
  let gw: RunningGateway | undefined;
  beforeEach(() => tempHome());
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
  });

  it('Telegram: allowlist, one session per chat, approvals answered in the chat, replies sent back', async () => {
    const tg = await fakeTelegram();
    const { host } = await mockHost(
      {
        'mock/a': [
          { text: 'Let me check.', toolCalls: [call('bash', { command: 'echo from-telegram' }, 'tg1')] },
          { text: 'The command printed from-telegram.', toolCalls: [] },
        ],
      },
      { approval: 'suggest' },
    );
    const bot = new TelegramBot(host, 'TEST', { allowedUsers: ['42'], defaultMode: 'coding', approvals: 'chat' }, tg.base);
    bot.start();
    try {
      tg.say(7, 'hello');
      await until(() => tg.sent.some((m) => m.text.includes('Not authorized')));
      expect(tg.sent[0].text).toContain('user id is 7');
      expect(host.listSessions()).toHaveLength(0);

      tg.say(42, 'run the echo please');
      await until(() => tg.sent.some((m) => m.text.includes('Approval needed')));
      expect(tg.sent.map((m) => m.text)).toContain('Let me check.');
      tg.say(42, '/approve');
      await until(() => tg.sent.some((m) => m.text.includes('printed from-telegram')));
      expect(tg.sent.some((m) => m.text === 'Approved bash.')).toBe(true);
      const sid = bot.bridge.sessionOf('100')!;
      expect((host.getEvents(sid).find((e) => e.type === 'tool/result') as any).output).toContain('from-telegram');

      tg.say(42, '/status');
      await until(() => tg.sent.some((m) => m.text.startsWith(`Session ${sid}`)));
    } finally {
      bot.stop();
      await tg.close();
    }
  });

  it('a bot only approves its own chats; other sessions still fail closed', async () => {
    const tg = await fakeTelegram();
    const { host } = await mockHost({ 'mock/a': [{ text: '', toolCalls: [call('bash', { command: 'echo x' })] }, { text: 'ok', toolCalls: [] }] }, { approval: 'suggest' });
    const bot = new TelegramBot(host, 'TEST', { allowedUsers: ['42'], defaultMode: 'coding', approvals: 'chat' }, tg.base);
    bot.start();
    try {
      const other = host.createSession({});
      await host.send(other.id, 'not from the bot');
      await host.wait(other.id);
      expect((host.getEvents(other.id).find((e) => e.type === 'tool/result') as any).output).toContain('headless run');
    } finally {
      bot.stop();
      await tg.close();
    }
  });

  it('DingTalk: verifies the callback signature and replies through the session webhook', async () => {
    const replies: any[] = [];
    const hook = createServer((req, res) => {
      let b = '';
      req.on('data', (d) => (b += d));
      req.on('end', () => (replies.push(JSON.parse(b)), res.end('{"errcode":0}')));
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const hookUrl = `http://127.0.0.1:${(hook.address() as any).port}/robot/send?session=abc`;
    const { host } = await mockHost({ 'mock/a': [{ text: '钉钉你好 (hello from DingTalk)', toolCalls: [] }] });
    const bots = startBots(
      host,
      { defaultMode: 'assistant', approvals: 'deny', telegram: { enabled: false, tokenEnv: 'X', allowedUsers: [] }, dingtalk: { enabled: true, appSecretEnv: 'DT_SECRET', allowedUsers: ['staff-1'] }, webhook: { enabled: false, allowedUsers: [] } },
      { DT_SECRET: 'sekret' },
    );
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const ts = String(Date.now());
    const body = JSON.stringify({ msgtype: 'text', text: { content: ' 你好 ' }, senderStaffId: 'staff-1', senderNick: 'Arthur', conversationId: 'cid-1', sessionWebhook: hookUrl, sessionWebhookExpiredTime: Date.now() + 60_000 });
    const bad = await fetch(`${gw.url}/bots/dingtalk`, { method: 'POST', headers: { timestamp: ts, sign: 'nope' }, body });
    expect(bad.status).toBe(401);
    const ok = await fetch(`${gw.url}/bots/dingtalk`, { method: 'POST', headers: { timestamp: ts, sign: dingtalkSign(ts, 'sekret') }, body });
    expect(ok.status).toBe(200);
    await until(() => replies.length > 0);
    expect(replies[0]).toMatchObject({ msgtype: 'markdown', markdown: { text: '钉钉你好 (hello from DingTalk)' } });
    bots.stop();
    await new Promise<void>((r) => hook.close(() => r()));
  });

  it('webhook: device-token auth, allowlist, and synchronous replies with ?wait=1', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: 'pong from webhook', toolCalls: [] }] });
    const bots = startBots(host, {
      defaultMode: 'assistant',
      approvals: 'deny',
      telegram: { enabled: false, tokenEnv: 'X', allowedUsers: [] },
      dingtalk: { enabled: false, appSecretEnv: 'X', allowedUsers: [] },
      webhook: { enabled: true, allowedUsers: ['ops'] },
    });
    expect(bots.started).toEqual(['webhook']);
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const { token } = createDevice('slack');
    const post = (body: unknown, auth = token, q = '?wait=1') =>
      fetch(`${gw!.url}/bots/webhook${q}`, { method: 'POST', headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await post({ chatId: 'c', userId: 'ops', text: 'x' }, 'sund_bad')).status).toBe(401);
    const denied = await (await post({ chatId: 'c', userId: 'stranger', text: 'ping' })).json();
    expect(denied.replies[0]).toContain('Not authorized');
    const r = await (await post({ chatId: 'c', userId: 'ops', text: 'ping' })).json();
    expect(r.replies).toEqual(['pong from webhook']);
    expect(r.sessionId).toBeTruthy();
    bots.stop();
  });

  it('reports bots that cannot start for lack of credentials', async () => {
    const { host } = await mockHost({});
    const bots = startBots(
      host,
      { defaultMode: 'assistant', approvals: 'chat', telegram: { enabled: true, tokenEnv: 'NO_SUCH_TOKEN', allowedUsers: ['1'] }, dingtalk: { enabled: false, appSecretEnv: 'X', allowedUsers: [] }, webhook: { enabled: false, allowedUsers: [] } },
      {},
    );
    expect(bots.started).toEqual([]);
    expect(bots.skipped[0]).toContain('NO_SUCH_TOKEN');
  });
});
