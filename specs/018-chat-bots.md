# 018 — Chat bot clients

Status: implemented (iteration 11). Source: Hermes Agent (bots attach to the gateway like any other surface).
Code: `packages/core/src/bots/bridge.ts` (`BotBridge`), `bots/adapters.ts` (`TelegramBot`, `DingTalkBot`, `WebhookBot`, `startBots`), gateway `routes`, CLI `serve`.

## Bridge (platform-neutral)

- Runs inside the gateway (`sun serve` starts enabled bots), so bot sessions get schedules, jobs, auto-resume and approvals like any other.
- **Allowlist**: `bots.<platform>.allowedUsers` (platform user ids). Empty = nobody. Unauthorized users get their id back (`/id` works for anyone) and nothing else.
- **One session per chat**, created on the first message in `bots.defaultMode` (default `assistant`), persisted in `~/.sun/bots.json`.
- Assistant text is sent back to the chat (split at the platform limit); pauses and errors are reported with how to resume.
- **Approvals**: with `bots.approvals = "chat"` (default) the bot registers a *scoped* approver for its sessions (specs/016) and posts "⚠️ Approval needed …"; `/approve`, `/approve always`, `/deny` answer it with the current prompt id. `"deny"` makes bot sessions headless (approvals denied).
- Commands: `/help`, `/new [mode]`, `/mode`, `/model`, `/status`, `/stop`, `/resume [model]`, `/approve [always]`, `/deny`, `/id`.

## Adapters

| Platform | Transport | Auth | Config |
|---|---|---|---|
| Telegram | long polling `getUpdates` (no public URL), `sendMessage` | bot token from `bots.telegram.tokenEnv` | `apiBase` for proxies/tests |
| DingTalk | outgoing robot callback `POST /bots/dingtalk`; replies to the per-message `sessionWebhook` (markdown) | `timestamp` + `sign` headers, `sign = base64(HMAC-SHA256(appSecret, timestamp + "\n" + appSecret))`, ≤ 1 h skew | `bots.dingtalk.appSecretEnv`; the callback URL must be reachable by DingTalk |
| Webhook | `POST /bots/webhook {chatId, userId, text, replyUrl?}`; replies POSTed to `replyUrl`, or returned with `?wait=1` as `{sessionId, replies}` (returns early when an approval is pending) | owner or device token (Bearer) | `bots.webhook.allowedUsers` |

Bots whose credentials are missing are reported as skipped at start-up.
