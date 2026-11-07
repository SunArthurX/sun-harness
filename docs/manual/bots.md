# Chat bots

Talk to sun-harness from Telegram, DingTalk, or any tool that can send a webhook (Slack workflows, Feishu, scripts). Bots run inside the gateway, so each chat gets a real session with memory, tools, schedules and background jobs.

## Enable

Edit `~/.sun/config.json`, then restart the gateway (`sun gateway install` again, or restart `sun serve`):

```json
{
  "bots": {
    "defaultMode": "assistant",
    "approvals": "chat",
    "telegram": { "enabled": true, "tokenEnv": "TELEGRAM_BOT_TOKEN", "allowedUsers": ["123456789"] },
    "dingtalk": { "enabled": true, "appSecretEnv": "DINGTALK_APP_SECRET", "allowedUsers": ["your-staff-id"] },
    "webhook":  { "enabled": true, "allowedUsers": ["ops"] }
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
- **Webhook** — `POST /bots/webhook` with a device token:

```sh
TOKEN=$(sun gateway token create ops-bot | grep -o 'sund_[A-Za-z0-9_-]*' | head -1)
curl -s "http://127.0.0.1:4471/bots/webhook?wait=1" -H "Authorization: Bearer $TOKEN" \
  -d '{"chatId":"ops-room","userId":"ops","text":"What is on my calendar today?"}'
# → {"sessionId":"…","replies":["…"]}
```

Without `?wait=1` the call returns `202` and replies are POSTed to `replyUrl` (`{chatId, text}`) if you passed one.
