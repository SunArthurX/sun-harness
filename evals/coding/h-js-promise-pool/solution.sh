#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/pool.js <<'EOF'
export function pool(tasks, limit) {
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit must be a positive integer');
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    let next = 0;
    let done = 0;
    let failed = false;
    if (!tasks.length) return resolve([]);
    const launch = () => {
      if (failed || next >= tasks.length) return;
      const i = next++;
      Promise.resolve().then(() => tasks[i]()).then((v) => {
        results[i] = v;
        if (++done === tasks.length) resolve(results);
        else launch();
      }, (e) => { failed = true; reject(e); });
    };
    for (let k = 0; k < Math.min(limit, tasks.length); k++) launch();
  });
}
EOF
