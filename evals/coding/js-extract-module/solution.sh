#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > dates.js <<'EOF'
export function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

export function addDays(d, n) {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

export function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}
EOF
cat > app.js <<'EOF'
import { addDays, formatDate, isWeekend } from './dates.js';

export { addDays, formatDate, isWeekend };

export function nextBusinessDay(d) {
  let x = addDays(d, 1);
  while (isWeekend(x)) x = addDays(x, 1);
  return formatDate(x);
}
EOF
