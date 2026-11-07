#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
cat > src/inventory.ts <<'EOF'
export interface Item {
  sku: string;
  qty: number;
  price?: number;
}

export function totalValue(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.qty * (i.price ?? 0), 0);
}

export function findItem(items: Item[], sku: string): Item | undefined {
  return items.find((i) => i.sku === sku);
}

export function restock(item: Item, amount: number): Item {
  return { ...item, qty: item.qty + amount };
}
EOF
