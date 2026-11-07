# Automations

Prompts that run by themselves on a schedule, each in its own session.

## Just say it

In any chat (desktop, CLI, chat bots), write what and when:

- “Every weekday at 9am summarize my unread mail”
- “每个工作日早上9点帮我总结邮件” · “每周一下午3点半检查一下PR” · “每隔30分钟检查网站”
- “Remind me tomorrow at 3pm to call Alex” · “2小时后提醒我喝水”

sun recognizes the schedule and asks before doing anything:

- **Create automation** — saved; the message is not answered now.
- **Create & run now** — saved, and answered right away too.
- **Just answer now** — not scheduled; a normal reply.

You can fix the title or the time in the card first (it shows the next three runs). CLI chat: answer `y`, `b` or `n`. Bots: `/yes`, `/both`, `/no`.

One-time phrases (“tomorrow at 3pm”) only count when you ask for an action (remind, run, check, send, 提醒, 执行…), so “the demo is tomorrow at 3pm” stays a normal message. Turn detection off with `"automations": { "detect": false }`.

## The Automations menu

Desktop: ⏲ in the left rail.

- Each automation shows its schedule in words, the next run, the mode and model, the last result.
- **On/Off** pauses it; **Run now**; **Edit**; **History** lists runs (click one to open its session); **Delete**.
- **+ New automation**: what to do, when (plain language like “every weekday at 9:00”, “每天晚上8点”, “tomorrow at 15:00”, or a cron expression — the preview shows how it was understood), title, mode, model, workspace, chats that also get the result, and whether to catch up missed runs.

## CLI

```bash
sun automations                                  # list
sun automations add "every weekday at 9" "summarize my unread mail" --mode assistant
sun automations preview "每周一下午3点半"          # check a schedule
sun automations run <id>                         # run once now
sun automations pause <id> | resume <id> | rm <id>
sun automations edit <id> --schedule "every day at 18:00" --prompt "…"
sun automations history <id>
```

## When do they run?

While the gateway (`sun gateway install`) or the desktop app is running. If the computer was asleep at the scheduled time, the run happens once when sun is back (within 24 hours; switch off per automation). Each run is a normal session titled `[automation] …` that you can open, continue, or export. With the app in the background you get a notification when a run ends; chat bots listed under “chats” receive the answer.

Runs use the approval mode from Settings; nobody is there to click “allow”, so actions that need approval are denied with a reason. Use read-only tasks, a sandboxed workspace, or `full-auto` only for trusted automations.
