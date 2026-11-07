#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/limiter.js <<'EOF'
export function createLimiter({ limit, windowMs, now = Date.now } = {}) {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError('limit must be a positive integer');
  if (typeof windowMs !== 'number' || !(windowMs > 0)) throw new TypeError('windowMs must be positive');
  const hits = new Map();
  return {
    allow(key) {
      const t = now();
      const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
      if (list.length >= limit) {
        hits.set(key, list);
        return false;
      }
      list.push(t);
      hits.set(key, list);
      return true;
    },
  };
}
EOF
