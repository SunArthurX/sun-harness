import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, TelegramBot, createDevice, dingtalkSign, startBots, startGateway, type RunningGateway } from '../src/index.js';
import { BotBridge } from '../src/bots/bridge.js';
import { call, mockHost, tempHome, tempWorkspace } from './helpers.js';

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
    expect((await post(null)).status).toBe(400);
    expect((await post({ chatId: 'c', userId: 'ops', text: 'x', replyUrl: 42 })).status).toBe(400);
    const denied = await (await post({ chatId: 'c', userId: 'stranger', text: 'ping' })).json();
    expect(denied.replies[0]).toContain('Not authorized');
    const r = await (await post({ chatId: 'c', userId: 'ops', text: 'ping' })).json();
    expect(r.replies).toEqual(['pong from webhook']);
    expect(r.sessionId).toBeTruthy();
    const deniedAfterSession = await (await post({ chatId: 'c', userId: 'stranger', text: 'ping' })).json();
    expect(deniedAfterSession).toEqual({ replies: [expect.stringContaining('Not authorized')] });
    bots.stop();
  });

  it('isolates a waiting webhook reply from concurrent same-chat requests', async () => {
    let entered!: () => void;
    let release!: () => void;
    const modelEntered = new Promise<void>(resolve => { entered = resolve; });
    const modelRelease = new Promise<void>(resolve => { release = resolve; });
    const { host } = await mockHost({ 'mock/a': [async () => {
      entered();
      await modelRelease;
      return { text: 'first private fixture reply', toolCalls: [] };
    }] });
    const bots = startBots(host, {
      ...host.config.bots, approvals: 'deny', webhook: { enabled: true, allowedUsers: ['ops'] },
    });
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const post = (chatId: string, text: string) => fetch(`${gw!.url}/bots/webhook?wait=1`, {
      method: 'POST', headers: { authorization: `Bearer ${gw!.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chatId, userId: 'ops', text }),
    });
    const first = post('shared-chat', 'start fixture model');
    let concurrent: Promise<Response> | undefined;
    try {
      await modelEntered;
      concurrent = post('shared-chat', '/status');
      const conflict = await Promise.race([concurrent, new Promise<undefined>(resolve => setTimeout(resolve, 1500).unref())]);
      expect(conflict?.status).toBe(409);
      expect((await post('different-chat', '/status')).status).toBe(200);
      release();
      expect((await (await first).json()).replies).toEqual(['first private fixture reply']);
      expect((await post('shared-chat', '/status')).status).toBe(200);
    } finally {
      release();
      await Promise.allSettled([first, concurrent]);
      bots.stop();
      await host.dispose();
    }
  });

  it.each(['webhook', 'dingtalk'] as const)('%s keeps a denied user from replacing an authorized reply destination', async (platform) => {
    let entered!: () => void;
    let release!: () => void;
    const modelEntered = new Promise<void>(resolve => { entered = resolve; });
    const modelRelease = new Promise<void>(resolve => { release = resolve; });
    const { host } = await mockHost({ 'mock/a': [async () => {
      entered();
      await modelRelease;
      return { text: 'authorized fixture reply', toolCalls: [] };
    }] });
    const secret = 'offline-dingtalk-fixture';
    const bots = startBots(host, {
      ...host.config.bots, approvals: 'deny', webhook: { enabled: platform === 'webhook', allowedUsers: ['ops'] },
      dingtalk: { enabled: platform === 'dingtalk', allowedUsers: ['ops'], appSecretEnv: 'FIXTURE_DINGTALK_SECRET' },
    }, { FIXTURE_DINGTALK_SECRET: secret });
    const deliveries: Array<{ path: string | undefined; text: string }> = [];
    const receiver = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        const payload = JSON.parse(body);
        deliveries.push({ path: req.url, text: payload.markdown?.text ?? payload.text });
        res.writeHead(204).end();
      });
    });
    try {
      await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
      const address = receiver.address();
      if (!address || typeof address === 'string') throw new Error('Missing fixture address');
      gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
      const post = (userId: string, path: string) => {
        const replyUrl = `http://127.0.0.1:${address.port}/${path}`;
        const timestamp = String(Date.now());
        const signature = dingtalkSign(timestamp, secret);
        const data = platform === 'dingtalk'
          ? { conversationId: 'shared-chat', senderStaffId: userId, text: { content: 'fixture request' }, sessionWebhook: replyUrl }
          : { chatId: 'shared-chat', userId, text: 'fixture request', replyUrl };
        return fetch(`${gw!.url}/bots/${platform}`, {
          method: 'POST', headers: {
            authorization: `Bearer ${gw!.token}`, 'content-type': 'application/json', timestamp, sign: signature,
          },
          body: JSON.stringify(data),
        });
      };
      const acknowledgement = platform === 'dingtalk' ? 200 : 202;
      expect((await post('ops', 'allowed')).status).toBe(acknowledgement);
      await modelEntered;
      expect((await post('denied', 'denied')).status).toBe(acknowledgement);
      await until(() => deliveries.some(delivery => delivery.text.includes('Not authorized')));
      release();
      await until(() => deliveries.some(delivery => delivery.text === 'authorized fixture reply'));
      expect(deliveries.filter(delivery => delivery.path === '/denied').map(delivery => delivery.text)).toEqual([expect.stringContaining('Not authorized')]);
      expect(deliveries).toContainEqual({ path: '/allowed', text: 'authorized fixture reply' });
    } finally {
      release();
      bots.stop();
      await host.dispose();
      receiver.closeAllConnections();
      if (receiver.listening) await new Promise<void>(resolve => receiver.close(() => resolve()));
    }
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

  it('answers every documented chat command, including denial, resume and custom commands', async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, '.sun', 'commands'), { recursive: true });
    writeFileSync(join(ws, '.sun', 'commands', 'audit-cmd.md'), '---\ndescription: Audit command\n---\nExpand the audit command.\n');
    const { host } = await mockHost({
      'mock/a': [
        { text: 'First reply.', toolCalls: [] },
        { text: '', toolCalls: [call('bash', { command: 'echo denied' }, 'deny1')] },
        { text: 'Denial acknowledged.', toolCalls: [] },
        new ProviderError('quota', 'HTTP 402: Insufficient Balance', 402),
        { text: 'Resumed reply.', toolCalls: [] },
        { text: 'Custom reply.', toolCalls: [] },
      ],
    }, { approval: 'suggest' });
    const sent: string[] = [];
    const bridge = new BotBridge(host, { platform: 'audit', maxLength: 4000, send: async (_chat, text) => void sent.push(text) },
      { allowedUsers: ['u'], defaultMode: 'assistant', approvals: 'chat', cwd: ws });
    bridge.start();
    const say = async (text: string) => {
      const before = sent.length;
      await bridge.handle({ chatId: 'c', userId: 'u', text });
      return sent.slice(before).join('\n');
    };
    const reply = async (text: string, expected: string) => {
      await say(text);
      await until(() => sent.includes(expected));
    };
    try {
      expect(await say('/id')).toBe('Your audit user id: u');
      expect(await say('/status')).toBe('No session yet; just send a message.');
      expect(await say('/mode coding')).toBe('No session yet.');
      expect(await say('/help')).toMatch(/^sun-harness bot[\s\S]*\/automations/);
      expect(await say('/new coding')).toMatch(/^New coding session \S+\.$/);
      const sid = bridge.sessionOf('c')!;
      expect(await say('/mode agent')).toBe('Mode → agent');
      expect(await say('/model mock/a')).toBe('Model → mock/a');
      await reply('hello', 'First reply.');
      expect(await say('/status')).toBe(`Session ${sid} · agent · mock/a · idle`);
      expect(await say('/cost')).toBe('No usage yet.');
      expect(await say('/context')).toMatch(/Context · mock\/a/);
      expect(await say('/review')).toBe('No file changes to review.');
      expect(await say('/commands')).toBe('/audit-cmd — Audit command');
      expect(await say('/automations')).toMatch(/^No automations\./);
      expect(await say('/yes')).toBe('Nothing is waiting for a scheduling decision.');
      expect(await say('/approve')).toBe('Nothing is waiting for approval.');
      await say('run the command');
      await until(() => sent.some((text) => text.startsWith('⚠️ Approval needed: bash')));
      expect(await say('/deny')).toBe('Denied bash.');
      await until(() => sent.includes('Denial acknowledged.'));
      expect(host.getEvents(sid).some((e) => e.type === 'approval/decision' && e.callId === 'deny1' && e.decision === 'deny')).toBe(true);
      await until(() => host.listSessions().find((s) => s.id === sid)?.status === 'idle');
      await say('continue after the quota');
      await until(() => sent.some((text) => text.startsWith('⏸ Paused (quota). Send /resume when ready')));
      expect(await say('/resume')).toBe('Resuming…');
      await until(() => sent.includes('Resumed reply.'));
      await until(() => host.listSessions().find((s) => s.id === sid)?.status === 'idle');
      await reply('/audit-cmd', 'Custom reply.');
      expect(host.getEvents(sid).some((e) => e.type === 'user/message' && e.text.includes('Expand the audit command.'))).toBe(true);
      expect(await say('/stop')).toBe('Stopped.');
      expect(await say('/compact')).toMatch(/^(Compacted\.|Nothing to compact yet\.)$/);
      expect(await say('/bogus')).toMatch(/^Unknown command \/bogus\.\nsun-harness bot/);
      expect(await bridge.handle({ chatId: 'c', userId: 'stranger', text: '/status' }).then(() => sent.at(-1))).toMatch(/^Not authorized/);
    } finally {
      bridge.stop();
      await host.dispose();
    }
  });
});
