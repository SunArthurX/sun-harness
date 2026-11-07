#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/subscriptions.js <<'EOF'
export function watch(bus, topic, handler) {
  const listener = (msg) => {
    if (msg.topic === topic) handler(msg.payload);
  };
  bus.on('message', listener);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    bus.off('message', listener);
  };
}

export function watchOnce(bus, topic, handler) {
  const unsubscribe = watch(bus, topic, (payload) => {
    unsubscribe();
    handler(payload);
  });
  return unsubscribe;
}
EOF
