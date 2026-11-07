import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { feishuDecrypt, startBots, startGateway, wechatDecrypt, wechatEncrypt, wechatSignature, xmlField, type BotsConfig, type RunningGateway } from '../src/index.js';
import { mockHost, tempHome } from './helpers.js';

const until = async (f: () => boolean, ms = 8000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 20));
  }
};

/** Records every call and answers like the vendor APIs (token endpoints + send endpoints). */
async function fakeApi() {
  const calls: { path: string; body: any }[] = [];
  const server: Server = createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      const path = req.url!;
      calls.push({ path, body: b ? JSON.parse(b) : undefined });
      res.setHeader('content-type', 'application/json');
      if (path.includes('tenant_access_token')) return res.end(JSON.stringify({ code: 0, tenant_access_token: 't-feishu', expire: 7200 }));
      if (path.startsWith('/open-apis/im/v1/messages')) return res.end(JSON.stringify({ code: 0 }));
      if (path.startsWith('/cgi-bin/token') || path.startsWith('/cgi-bin/gettoken')) return res.end(JSON.stringify({ access_token: 'wx-token', expires_in: 7200 }));
      if (path.includes('/message/')) return res.end(JSON.stringify({ errcode: 0, errmsg: 'ok' }));
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { base: `http://127.0.0.1:${(server.address() as any).port}`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function cfg(over: Partial<BotsConfig>): BotsConfig {
  const off = { enabled: false, allowedUsers: [] as string[] };
  return {
    defaultMode: 'assistant',
    approvals: 'deny',
    telegram: { ...off, tokenEnv: 'X' },
    dingtalk: { ...off, appSecretEnv: 'X' },
    webhook: off,
    feishu: { ...off, appIdEnv: 'FS_ID', appSecretEnv: 'FS_SECRET', verificationTokenEnv: 'FS_VT', encryptKeyEnv: 'FS_EK' },
    wechat: { ...off, appIdEnv: 'WX_ID', appSecretEnv: 'WX_SECRET', tokenEnv: 'WX_TOKEN', encodingAesKeyEnv: 'WX_AES' },
    wecom: { ...off, corpIdEnv: 'WC_CORP', secretEnv: 'WC_SECRET', agentId: '', tokenEnv: 'WC_TOKEN', encodingAesKeyEnv: 'WC_AES' },
    ...over,
  };
}

const AES = randomBytes(32).toString('base64').replace(/=+$/, '').slice(0, 43);

describe('Feishu and WeChat bots', () => {
  let gw: RunningGateway | undefined;
  let api: Awaited<ReturnType<typeof fakeApi>>;
  beforeEach(async () => {
    tempHome();
    api = await fakeApi();
  });
  afterEach(async () => {
    await gw?.close();
    gw = undefined;
    await api.close();
  });

  it('matches the vendors\u2019 published test vectors', () => {
    // WeChat/WeCom official callback sample (WXBizMsgCrypt Sample.py): token QDG6eK, corp wx5823bf96d3bd56c7.
    const enc =
      'RypEvHKD8QQKFhvQ6QleEB4J58tiPdvo+rtK1I9qca6aM/wvqnLSV5zEPeusUiX5L5X/0lWfrf0QADHHhGd3QczcdCUpj911L3vg3W/sYYvuJTs3TUUkSUXxaccAS0qhxchrRYt66wiSpGLYL42aM6A8dTT+6k4aSknmPj48kzJs8qLjvd4Xgpue06DOdnLxAUHzM6+kDZ+HMZfJYuR+LtwGc2hgf5gsijff0ekUNXZiqATP7PF5mZxZ3Izoun1s4zG4LUMnvw2r+KqCKIw+3IQH03v+BCA9nMELNqbSf6tiWSrXJB3LAVGUcallcrw8V2t9EL4EhzJWrQUax5wLVMNS0+rUPA3k22Ncx4XXZS9o0MBH27Bo6BpNelZpS+/uh9KsNlY6bHCmJU9p8g7m3fVKn28H3KDYA5Pl/T8Z1ptDAVe0lXdQ2YoyyH2uyPIGHBZZIs2pDBS8R07+qN+E7Q==';
    expect(wechatSignature('QDG6eK', '1409659813', '1372623149', enc)).toBe('477715d11cdb4164915debcba66cb864d751f3e6');
    const r = wechatDecrypt(enc, 'jWmYm7qr5nMoAUwZRjGtBxmz3KA1tkAj3ykkR6q2B2C');
    expect(r.receiverId).toBe('wx5823bf96d3bd56c7');
    expect(xmlField(r.message, 'Content')).toBe('hello');
    expect(xmlField(r.message, 'FromUserName')).toBe('mycreate');
    // Feishu event encryption doc sample.
    expect(feishuDecrypt('P37w+VZImNgPEO1RBhJ6RtKl7n6zymIbEG1pReEzghk=', 'test key')).toBe('hello world');
  });

  it('WeChat/WeCom crypto round-trips and signatures sort their inputs', () => {
    const enc = wechatEncrypt('<xml>hello 你好</xml>', AES, 'corp-1');
    expect(wechatDecrypt(enc, AES)).toEqual({ message: '<xml>hello 你好</xml>', receiverId: 'corp-1' });
    expect(wechatSignature('b', 'a', 'c')).toBe(createHash('sha1').update('abc').digest('hex'));
  });

  it('Feishu: url_verification, token check, encrypted events, dedupe, reply via IM API', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: '飞书你好 (hello Feishu)', toolCalls: [] }] });
    const bots = startBots(host, cfg({ feishu: { ...cfg({}).feishu, enabled: true, apiBase: api.base, allowedUsers: ['ou_owner'] } }), { FS_ID: 'cli_x', FS_SECRET: 's', FS_VT: 'vtoken', FS_EK: 'ekey' });
    expect(bots.started).toEqual(['feishu']);
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const post = (body: unknown) => fetch(`${gw!.url}/bots/feishu`, { method: 'POST', body: JSON.stringify(body) });

    expect(await (await post({ type: 'url_verification', token: 'vtoken', challenge: 'c-123' })).json()).toEqual({ challenge: 'c-123' });
    expect((await post({ type: 'url_verification', token: 'wrong', challenge: 'x' })).status).toBe(401);

    const event = {
      schema: '2.0',
      header: { event_id: 'ev-1', event_type: 'im.message.receive_v1', token: 'vtoken' },
      event: { sender: { sender_id: { open_id: 'ou_owner' } }, message: { chat_id: 'oc_chat', message_type: 'text', content: JSON.stringify({ text: '@_user_1 你好' }) } },
    };
    const key = createHash('sha256').update('ekey').digest();
    const iv = randomBytes(16);
    const c = createCipheriv('aes-256-cbc', key, iv);
    const encrypt = Buffer.concat([iv, c.update(JSON.stringify(event)), c.final()]).toString('base64');
    expect((await post({ encrypt })).status).toBe(200);
    await post({ encrypt }); // retried delivery is ignored
    await until(() => api.calls.some((x) => x.path.startsWith('/open-apis/im/v1/messages')));
    await new Promise((r) => setTimeout(r, 100));
    const sends = api.calls.filter((x) => x.path.startsWith('/open-apis/im/v1/messages'));
    expect(sends).toHaveLength(1);
    expect(sends[0].path).toContain('receive_id_type=chat_id');
    expect(sends[0].body).toMatchObject({ receive_id: 'oc_chat', msg_type: 'text' });
    expect(JSON.parse(sends[0].body.content).text).toBe('飞书你好 (hello Feishu)');
    const sid = host.listSessions()[0].id;
    expect((host.getEvents(sid).find((e) => e.type === 'user/message') as any).text).toBe('你好');
    bots.stop();
  });

  it('WeChat Official Account: URL verification, signed XML, retry dedupe, allowlist, customer-service reply', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: '公众号回复 (reply)', toolCalls: [] }] });
    const bots = startBots(host, cfg({ wechat: { ...cfg({}).wechat, enabled: true, apiBase: api.base, allowedUsers: ['o_owner'] } }), { WX_ID: 'wx1', WX_SECRET: 's', WX_TOKEN: 'wxtoken' });
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const ts = '1700000000';
    const nonce = 'n1';
    const sig = wechatSignature('wxtoken', ts, nonce);
    expect(await (await fetch(`${gw.url}/bots/wechat?signature=${sig}&timestamp=${ts}&nonce=${nonce}&echostr=hello-echo`)).text()).toBe('hello-echo');
    expect((await fetch(`${gw.url}/bots/wechat?signature=bad&timestamp=${ts}&nonce=${nonce}&echostr=x`)).status).toBe(401);

    const xml = (from: string, id: string, text: string) =>
      `<xml><ToUserName><![CDATA[gh_1]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName><CreateTime>1700000000</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${text}]]></Content><MsgId>${id}</MsgId></xml>`;
    const send = (body: string, s = sig) => fetch(`${gw!.url}/bots/wechat?signature=${s}&timestamp=${ts}&nonce=${nonce}`, { method: 'POST', body });
    expect((await send(xml('o_owner', '1', 'hi'), 'bad')).status).toBe(401);
    const ok = await send(xml('o_owner', '1', '你好'));
    expect(await ok.text()).toBe('success');
    await send(xml('o_owner', '1', '你好')); // WeChat retry with the same MsgId
    await until(() => api.calls.some((x) => x.path.includes('/message/custom/send')));
    await send(xml('o_stranger', '2', 'hi'));
    await until(() => api.calls.filter((x) => x.path.includes('/message/custom/send')).length === 2);
    const sends = api.calls.filter((x) => x.path.includes('/message/custom/send'));
    expect(sends[0].path).toContain('access_token=wx-token');
    expect(sends[0].body).toEqual({ touser: 'o_owner', msgtype: 'text', text: { content: '公众号回复 (reply)' } });
    expect(sends[1].body.text.content).toContain('Not authorized');
    expect(host.listSessions()).toHaveLength(1);
    bots.stop();
  });

  it('WeCom: encrypted URL verification and messages, receiver check, reply with agentid', async () => {
    const { host } = await mockHost({ 'mock/a': [{ text: '企业微信回复 (reply)', toolCalls: [] }] });
    const bots = startBots(host, cfg({ wecom: { ...cfg({}).wecom, enabled: true, agentId: '1000002', apiBase: api.base, allowedUsers: ['zhangsan'] } }), {
      WC_CORP: 'ww-corp',
      WC_SECRET: 's',
      WC_TOKEN: 'wctoken',
      WC_AES: AES,
    });
    expect(bots.started).toEqual(['wecom']);
    gw = await startGateway(host, { port: 0, advertise: false, routes: bots.routes });
    const ts = '1700000001';
    const nonce = 'n2';
    const echo = wechatEncrypt('echo-plain', AES, 'ww-corp');
    const vsig = wechatSignature('wctoken', ts, nonce, echo);
    expect(await (await fetch(`${gw.url}/bots/wecom?msg_signature=${vsig}&timestamp=${ts}&nonce=${nonce}&echostr=${encodeURIComponent(echo)}`)).text()).toBe('echo-plain');

    const inner = `<xml><ToUserName><![CDATA[ww-corp]]></ToUserName><FromUserName><![CDATA[zhangsan]]></FromUserName><CreateTime>1700000001</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[帮我看看]]></Content><MsgId>77</MsgId><AgentID>1000002</AgentID></xml>`;
    const post = (enc: string) => {
      const s = wechatSignature('wctoken', ts, nonce, enc);
      return fetch(`${gw!.url}/bots/wecom?msg_signature=${s}&timestamp=${ts}&nonce=${nonce}`, { method: 'POST', body: `<xml><ToUserName><![CDATA[ww-corp]]></ToUserName><Encrypt><![CDATA[${enc}]]></Encrypt></xml>` });
    };
    expect((await post(wechatEncrypt(inner, AES, 'other-corp'))).status).toBe(401);
    expect((await post(wechatEncrypt(inner, AES, 'ww-corp'))).status).toBe(200);
    await until(() => api.calls.some((x) => x.path.includes('/cgi-bin/message/send')));
    const send = api.calls.find((x) => x.path.includes('/cgi-bin/message/send'))!;
    expect(send.body).toEqual({ touser: 'zhangsan', msgtype: 'text', agentid: 1000002, text: { content: '企业微信回复 (reply)' } });
    const unsigned = await fetch(`${gw.url}/bots/wecom?timestamp=${ts}&nonce=${nonce}`, { method: 'POST', body: inner });
    expect(unsigned.status).toBe(401); // WeCom never accepts plain-text callbacks
    bots.stop();
  });

  it('reports missing credentials for each platform', async () => {
    const { host } = await mockHost({});
    const bots = startBots(host, cfg({ feishu: { ...cfg({}).feishu, enabled: true }, wechat: { ...cfg({}).wechat, enabled: true }, wecom: { ...cfg({}).wecom, enabled: true } }), {});
    expect(bots.started).toEqual([]);
    expect(bots.skipped.join(' | ')).toMatch(/feishu \(set FS_ID, FS_SECRET, FS_VT\).*wechat \(set WX_ID, WX_SECRET, WX_TOKEN\).*wecom \(set bots\.wecom\.agentId\)/);
  });
});
