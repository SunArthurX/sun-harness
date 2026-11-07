#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat >> stats.js <<'EOF'

/**
 * Median value.
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!values.length) throw new RangeError('empty');
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
EOF
