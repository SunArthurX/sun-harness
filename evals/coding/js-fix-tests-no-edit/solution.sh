#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/cart.js <<'EOF'
export function addItem(cart, item) {
  return { ...cart, items: [...cart.items, item] };
}

export function total(cart) {
  return cart.items.reduce((s, i) => s + i.price * (i.qty ?? 1), 0);
}

export function applyDiscount(cart, percent) {
  return total(cart) * (1 - percent / 100);
}
EOF
