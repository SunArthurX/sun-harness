# Chat bots

Talk to sun-harness from Telegram, DingTalk, Feishu (飞书/Lark), WeChat (微信公众号), WeCom (企业微信), or any tool that can send a webhook (Slack workflows, scripts). Bots run inside the gateway, so each chat gets a real session with memory, tools, schedules and background jobs.

## Enable

Edit `~/.sun/config.json`, then restart the gateway (`sun gateway install` again, or restart `sun serve`):

```json
{
  "bots": {
    "defaultMode": "assistant",
    "approvals": "chat",
    "telegram": { "enabled": true, "tokenEnv": "TELEGRAM_BOT_TOKEN", "allowedUsers": ["123456789"] },
    "dingtalk": { "enabled": true, "appSecretEnv": "DINGTALK_APP_SECRET", "allowedUsers": ["your-staff-id"] },
    "webhook":  { "enabled": true, "allowedUsers": ["ops"] },
    "feishu":   { "enabled": true, "allowedUsers": ["ou_xxx"] },
    "wechat":   { "enabled": true, "allowedUsers": ["oXyz…openid"] },
    "wecom":    { "enabled": true, "agentId": "1000002", "allowedUsers": ["ZhangSan"] }
  }
}
```

Put the secrets in your shell (`export TELEGRAM_BOT_TOKEN=…`) or `~/.sun/.env`. At start-up the gateway prints which bots started and which were skipped (missing credentials).

**Allowlist first.** Only listed user ids can use a bot; an empty list means nobody. Send `/id` to the bot to learn your id, then add it.

## Using a bot

Just write. The first message starts a session for that chat (default mode `assistant`); replies come back as messages.

| Command | Effect |
|---|---|
| `/new [coding\|agent\|assistant]` | start a fresh session for this chat |
| `/mode <id>`, `/model <provider/model>` | switch the current session |
| `/status` | session id, mode, model, state |
| `/stop`, `/resume [model]` | stop a run; continue a paused one (e.g. after quota) |
| `/approve`, `/approve always`, `/deny` | answer a pending approval |
| `/id`, `/help` | your user id; this list |

When a tool needs approval, the bot posts `⚠️ Approval needed: …` and waits for `/approve` or `/deny`. Set `"approvals": "deny"` to make bot sessions never wait (approvals are denied with a reason).

## Platforms

- **Telegram** — create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN`. Uses long polling: no public URL needed. Behind a proxy or mirror, set `bots.telegram.apiBase`.
- **DingTalk** — create an internal robot with *outgoing* messages ("消息接收模式: HTTP"), set its AppSecret as `DINGTALK_APP_SECRET`, and point the message URL to `https://<gateway>/bots/dingtalk`. DingTalk must be able to reach that URL (run the gateway with `--tls --host 0.0.0.0` behind a reachable address or tunnel). Callbacks are verified with DingTalk's signature; replies use the per-message session webhook.
- **Feishu / Lark (飞书)** — in the developer console create an app, enable the bot capability, add the `im:message` permission and subscribe to the event `im.message.receive_v1` with request URL `https://<gateway>/bots/feishu`. Set `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_VERIFICATION_TOKEN` and, if you set an Encrypt Key, `FEISHU_ENCRYPT_KEY`. For Lark (international) set `bots.feishu.apiBase` to `https://open.larksuite.com`. In groups, @-mention the bot. User ids are `open_id`s (send `/id`).
- **WeChat Official Account (微信公众号)** — for a free test, use the sandbox account (公众平台测试号). Set the server URL to `https://<gateway>/bots/wechat` and a Token; export `WECHAT_APP_ID`, `WECHAT_APP_SECRET`, `WECHAT_TOKEN` (and `WECHAT_ENCODING_AES_KEY` for safe mode). WeChat verifies the URL with a GET request; messages are answered at once and replies are sent with the customer-service API, which works within 48 hours of the user's last message. User ids are `openid`s.
- **WeCom (企业微信)** — create a self-built app, set its "receive messages" API URL to `https://<gateway>/bots/wecom` with Token and EncodingAESKey, and add the gateway's public IP to the app's trusted IPs. Export `WECOM_CORP_ID`, `WECOM_SECRET` (the app secret), `WECOM_TOKEN`, `WECOM_ENCODING_AES_KEY`, and set `bots.wecom.agentId`. User ids are WeCom `UserID`s.

Feishu, WeChat and WeCom push to a URL, so like DingTalk the gateway must be reachable from the internet (`sun serve --tls --host 0.0.0.0` behind a public address, or a tunnel). Personal WeChat accounts have no official bot API and are not supported.

- **Webhook** — `POST /bots/webhook` with a device token:

```sh
TOKEN=$(sun gateway token create ops-bot | grep -o 'sund_[A-Za-z0-9_-]*' | head -1)
curl -s "http://127.0.0.1:4471/bots/webhook?wait=1" -H "Authorization: Bearer $TOKEN" \
  -d '{"chatId":"ops-room","userId":"ops","text":"What is on my calendar today?"}'
# → {"sessionId":"…","replies":["…"]}
```

Without `?wait=1` the call returns `202` and replies are POSTed to `replyUrl` (`{chatId, text}`) if you passed one.
