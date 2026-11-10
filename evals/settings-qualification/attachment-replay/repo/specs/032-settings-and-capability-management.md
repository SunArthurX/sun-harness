# 032 — Repair missing attachment replay

Replay user and assistant events in order. Each missing attachment raises
ENOENT from the injected reader. Keep the user message and successful images
in original order. If one or more attachments are missing, append a newline and
[Missing attachments: N] to the user message. Do not include paths or substitute
new attachment bytes. Other reader errors must propagate. Ignore unrelated event
types. Do not mutate the event array or change intact replay.
