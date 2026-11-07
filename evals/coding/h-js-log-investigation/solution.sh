#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/notify/job.js <<'EOF'
import { normalizeEmail } from './email.js';

export async function notifyAll(users, send) {
  let sent = 0;
  let skipped = 0;
  for (const u of users) {
    const to = u?.profile?.email;
    if (typeof to !== 'string' || !to.trim()) {
      skipped++;
      continue;
    }
    await send(normalizeEmail(to));
    sent++;
  }
  return { sent, skipped };
}
EOF
