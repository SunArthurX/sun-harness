#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
sed -i '' 's/fullname: string;/displayName: string;/' src/types.ts
sed -i '' 's/u\.fullname/u.displayName/g; s/a\.fullname/a.displayName/g; s/b\.fullname/b.displayName/g' src/format.ts src/search.ts src/sort.ts
sed -i '' 's/createUser(fullname: string/createUser(displayName: string/; s/{ id: next++, fullname, email }/{ id: next++, displayName, email }/' src/create.ts
cat > src/serialize.ts <<'EOF'
import type { User } from './types.ts';

// The wire format keeps the legacy key `fullname`.
export function toWire(u: User): Record<string, unknown> {
  return { id: u.id, fullname: u.displayName, email: u.email };
}

export function fromWire(o: { id: number; fullname: string; email: string }): User {
  return { id: o.id, displayName: o.fullname, email: o.email };
}
EOF
