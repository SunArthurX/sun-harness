#!/usr/bin/env bash
# Reference solution: proves the task is solvable and the check is fair. Never shown to the agent.
set -euo pipefail
python3 - <<'EOF'
p='store.js'; s=open(p).read()
s=s.replace('''  records.forEach(async (r) => {
    await save(r);
  });''','''  await Promise.all(records.map((r) => save(r)));''')
open(p,'w').write(s)
EOF
