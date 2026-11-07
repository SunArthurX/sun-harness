#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/money/split.js <<'EOF'
// Split an amount (in cents) into n parts that add up exactly to the amount.
export function splitCents(total, n) {
  const base = Math.floor(total / n);
  const rest = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}
EOF
